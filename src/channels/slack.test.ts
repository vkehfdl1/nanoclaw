import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../db.js', () => ({
  updateChatName: vi.fn(),
}));

vi.mock('../router.js', () => ({
  formatOutbound: vi.fn((text: string) => text),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: vi.fn(() => Buffer.from('file-content')),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
    },
  };
});

// --- Fake @slack/bolt App ---

type SlackMessageHandler = (ctx: { message: Record<string, unknown>; client: FakeClient }) => Promise<void>;

interface FakeClient {
  auth: { test: ReturnType<typeof vi.fn> };
  chat: { postMessage: ReturnType<typeof vi.fn> };
  users: { info: ReturnType<typeof vi.fn> };
  conversations: {
    list: ReturnType<typeof vi.fn>;
    replies: ReturnType<typeof vi.fn>;
    history: ReturnType<typeof vi.fn>;
  };
  filesUploadV2: ReturnType<typeof vi.fn>;
}

function createFakeClient(): FakeClient {
  return {
    auth: {
      test: vi.fn().mockResolvedValue({ user_id: 'BOT_USER_123' }),
    },
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '1700000000.000001' }),
    },
    users: {
      info: vi.fn().mockResolvedValue({
        user: {
          profile: { display_name: 'Alice' },
          real_name: 'Alice Smith',
          name: 'alice',
        },
      }),
    },
    conversations: {
      list: vi.fn().mockResolvedValue({ channels: [] }),
      replies: vi.fn().mockResolvedValue({ messages: [] }),
      history: vi.fn().mockResolvedValue({ messages: [] }),
    },
    filesUploadV2: vi.fn().mockResolvedValue({ ok: true }),
  };
}

let fakeClient: FakeClient;
let messageHandlers: SlackMessageHandler[] = [];

function createFakeApp() {
  messageHandlers = [];

  return {
    client: fakeClient,
    message: (handler: SlackMessageHandler) => {
      messageHandlers.push(handler);
    },
    event: (_eventName: string, _handler: unknown) => {
      // No event handlers needed — app_mention and reaction_added are removed
    },
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

let fakeApp: ReturnType<typeof createFakeApp>;

vi.mock('@slack/bolt', () => {
  return {
    App: class FakeApp {
      constructor(_opts: unknown) {
        return fakeApp as unknown as FakeApp;
      }
    },
    LogLevel: { WARN: 'warn' },
  };
});

import { SlackChannel, SlackChannelOpts } from './slack.js';

// --- Helper to fire a fake Slack message event ---

async function triggerMessage(msg: Record<string, unknown>) {
  for (const handler of messageHandlers) {
    await handler({ message: msg as never, client: fakeClient });
  }
}

// --- Test helpers ---

const REGISTERED_JID = 'slack:C123456789';
const CHANNEL_ID = 'C123456789';

function createTestOpts(overrides?: Partial<SlackChannelOpts>): SlackChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      [REGISTERED_JID]: {
        name: 'Test Channel',
        folder: 'test-channel',
        trigger: '@Andy',
        aliases: ['andy'],
        added_at: '2024-01-01T00:00:00.000Z',
        gateway: { rules: [{ match: 'self_mention' as const }] },
      },
    })),
    botToken: 'xoxb-test-token',
    appToken: 'xapp-test-token',
    ...overrides,
  };
}

async function connectChannel(channel: SlackChannel): Promise<void> {
  await channel.connect();
}

// --- Tests ---

describe('SlackChannel', () => {
  beforeEach(() => {
    fakeClient = createFakeClient();
    fakeApp = createFakeApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('resolves connect() and sets connected=true', async () => {
      const channel = new SlackChannel(createTestOpts());
      await connectChannel(channel);
      expect(channel.isConnected()).toBe(true);
    });

    it('throws when auth.test fails', async () => {
      fakeClient.auth.test.mockRejectedValue(new Error('Invalid token'));
      const channel = new SlackChannel(createTestOpts());
      await expect(channel.connect()).rejects.toThrow('Invalid token');
    });

    it('stores bot user ID from auth', async () => {
      fakeClient.auth.test.mockResolvedValue({ user_id: 'U_BOT_456' });
      const channel = new SlackChannel(createTestOpts());
      await connectChannel(channel);
      expect(fakeClient.auth.test).toHaveBeenCalledOnce();
    });

    it('disconnects cleanly', async () => {
      const channel = new SlackChannel(createTestOpts());
      await connectChannel(channel);
      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
      expect(fakeApp.stop).toHaveBeenCalled();
    });
  });

  // --- JID ownership ---

  describe('ownsJid', () => {
    it('owns slack: JIDs', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.ownsJid('slack:C123456')).toBe(true);
    });

    it('does not own non-Slack JIDs', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own other JID formats', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.ownsJid('tg:12345')).toBe(false);
    });
  });

  // --- Thread tracking: message events ---

  describe('thread tracking via message events', () => {
    it('includes thread_ts in the NewMessage for threaded messages', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await connectChannel(channel);

      await triggerMessage({
        channel: CHANNEL_ID,
        ts: '1700000003.000001',
        thread_ts: '1700000001.000000',
        text: 'Reply in thread',
        user: 'U_ALICE',
      });

      expect(opts.onMessage).toHaveBeenCalledWith(
        REGISTERED_JID,
        expect.objectContaining({ thread_ts: '1700000001.000000' }),
      );
    });

    it('includes ts as thread_ts in NewMessage for top-level messages', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await connectChannel(channel);

      await triggerMessage({
        channel: CHANNEL_ID,
        ts: '1700000004.000001',
        text: 'Top-level message',
        user: 'U_ALICE',
      });

      expect(opts.onMessage).toHaveBeenCalledWith(
        REGISTERED_JID,
        expect.objectContaining({ thread_ts: '1700000004.000001' }),
      );
    });
  });

  // --- sendMessage: thread-aware response posting ---

  describe('sendMessage — thread-aware response posting', () => {
    it('posts to channel without thread_ts when no active thread tracked', async () => {
      const channel = new SlackChannel(createTestOpts());
      await connectChannel(channel);

      await channel.sendMessage(REGISTERED_JID, 'Hello!');

      const call = fakeClient.chat.postMessage.mock.calls[0][0];
      expect(call.channel).toBe(CHANNEL_ID);
      expect(call.text).toContain('Hello!');
      expect(call.thread_ts).toBeUndefined();
    });

    it('uses group name as assistant label', async () => {
      const channel = new SlackChannel(createTestOpts());
      await connectChannel(channel);

      await channel.sendMessage(REGISTERED_JID, 'Response message');

      const call = fakeClient.chat.postMessage.mock.calls[0][0];
      expect(call.text).toMatch(/^\*Test Channel:\*/);
    });

    it('uses the provided thread_ts when replying in a thread', async () => {
      const channel = new SlackChannel(createTestOpts());
      await connectChannel(channel);

      await channel.sendMessage(REGISTERED_JID, 'Thread reply', {
        threadTs: '1700000050.000001',
      });

      expect(fakeClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: CHANNEL_ID,
          thread_ts: '1700000050.000001',
          text: expect.stringContaining('Thread reply'),
        }),
      );
    });

    it('does not send messages when formatOutbound returns empty string', async () => {
      const { formatOutbound } = await import('../router.js');
      vi.mocked(formatOutbound).mockReturnValueOnce('');

      const channel = new SlackChannel(createTestOpts());
      await connectChannel(channel);

      await channel.sendMessage(REGISTERED_JID, '<internal>hidden reasoning</internal>');

      expect(fakeClient.chat.postMessage).not.toHaveBeenCalled();
    });

    it('handles postMessage failure without throwing', async () => {
      fakeClient.chat.postMessage.mockRejectedValueOnce(new Error('Slack API error'));

      const channel = new SlackChannel(createTestOpts());
      await connectChannel(channel);

      await expect(channel.sendMessage(REGISTERED_JID, 'Test')).resolves.toBeUndefined();
    });

    it('logs inThread=true when posting with threadTs', async () => {
      const { logger } = await import('../logger.js');
      const channel = new SlackChannel(createTestOpts());
      await connectChannel(channel);

      vi.mocked(logger.info).mockClear();
      await channel.sendMessage(REGISTERED_JID, 'Reply', {
        threadTs: '1700000010.000001',
      });

      expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
        expect.objectContaining({ inThread: true }),
        expect.any(String),
      );
    });

    it('logs inThread=false when posting to channel root', async () => {
      const { logger } = await import('../logger.js');
      const channel = new SlackChannel(createTestOpts());
      await connectChannel(channel);

      await channel.sendMessage(REGISTERED_JID, 'Top-level reply');

      expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
        expect.objectContaining({ inThread: false }),
        expect.any(String),
      );
    });
  });

  it('uses the provided agentLabel when supplied', async () => {
    const channel = new SlackChannel(createTestOpts());
    await connectChannel(channel);

    await channel.sendMessage(REGISTERED_JID, 'Thread reply', {
      threadTs: '1700000050.000001',
      agentLabel: 'TestAgent',
    });

    expect(fakeClient.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: CHANNEL_ID,
        thread_ts: '1700000050.000001',
        text: expect.stringContaining('TestAgent'),
      }),
    );
  });

  // --- Message filtering ---

  describe('message filtering', () => {
    it('passes bot messages through with is_bot_message=true', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await connectChannel(channel);

      await triggerMessage({
        channel: CHANNEL_ID,
        ts: '1700000001.000001',
        text: '*TestAgent:* hello from bot',
        bot_id: 'B123',
        user: 'U_BOT',
      });

      expect(opts.onMessage).toHaveBeenCalledWith(
        REGISTERED_JID,
        expect.objectContaining({
          is_bot_message: true,
          agent_source: 'TestAgent',
          content: '*TestAgent:* hello from bot',
        }),
      );
    });

    it('parses agent_source from *AgentName:* prefix in bot messages', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await connectChannel(channel);

      await triggerMessage({
        channel: CHANNEL_ID,
        ts: '1700000001.000001',
        text: '*홍명보:* 마케팅 리포트입니다',
        bot_id: 'B123',
        user: 'U_BOT',
      });

      expect(opts.onMessage).toHaveBeenCalledWith(
        REGISTERED_JID,
        expect.objectContaining({
          is_bot_message: true,
          agent_source: '홍명보',
        }),
      );
    });

    it('delivers bot messages with is_from_me=true for own bot', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await connectChannel(channel);

      await triggerMessage({
        channel: CHANNEL_ID,
        ts: '1700000002.000001',
        text: '*Bot:* reply',
        bot_id: 'B123',
        user: 'BOT_USER_123',
      });

      expect(opts.onMessage).toHaveBeenCalledWith(
        REGISTERED_JID,
        expect.objectContaining({ is_from_me: true }),
      );
    });

    it('skips messages with unsupported subtypes', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await connectChannel(channel);

      await triggerMessage({
        channel: CHANNEL_ID,
        ts: '1700000001.000001',
        text: 'Edited message',
        subtype: 'message_changed',
        user: 'U_ALICE',
      });

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('allows file_share subtype through when it has text', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await connectChannel(channel);

      await triggerMessage({
        channel: CHANNEL_ID,
        ts: '1700000001.000001',
        subtype: 'file_share',
        text: 'Check this file',
        user: 'U_ALICE',
        files: [],
      });

      expect(opts.onMessage).toHaveBeenCalled();
    });

    it('skips messages with no text and no files', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await connectChannel(channel);

      await triggerMessage({
        channel: CHANNEL_ID,
        ts: '1700000001.000001',
        user: 'U_ALICE',
      });

      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // --- Channel sync ---

  describe('syncChannels', () => {
    it('syncs channel names from Slack API on connect', async () => {
      fakeClient.conversations.list.mockResolvedValue({
        channels: [
          { id: 'C111', name: 'general' },
          { id: 'C222', name: 'project-alpha' },
        ],
      });

      const { updateChatName } = await import('../db.js');
      const channel = new SlackChannel(createTestOpts());
      await connectChannel(channel);

      expect(vi.mocked(updateChatName)).toHaveBeenCalledWith('slack:C111', '#general');
      expect(vi.mocked(updateChatName)).toHaveBeenCalledWith('slack:C222', '#project-alpha');
    });

    it('handles sync failure gracefully', async () => {
      fakeClient.conversations.list.mockRejectedValue(new Error('API error'));

      const channel = new SlackChannel(createTestOpts());
      await connectChannel(channel);

      await expect(channel.syncChannels()).resolves.toBeUndefined();
    });
  });
});
