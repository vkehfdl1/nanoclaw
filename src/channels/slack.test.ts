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
    it('sets activeThreadTs to message.ts for top-level messages', async () => {
      const channel = new SlackChannel(createTestOpts());
      await connectChannel(channel);

      await triggerMessage({
        channel: CHANNEL_ID,
        ts: '1700000001.000001',
        text: 'Hello!',
        user: 'U_ALICE',
      });

      expect(channel.getActiveThreadTs(REGISTERED_JID)).toBe('1700000001.000001');
    });

    it('sets activeThreadTs to message.thread_ts when already in a thread', async () => {
      const channel = new SlackChannel(createTestOpts());
      await connectChannel(channel);

      await triggerMessage({
        channel: CHANNEL_ID,
        ts: '1700000002.000001',
        thread_ts: '1700000001.000000',
        text: 'Another message in thread',
        user: 'U_ALICE',
      });

      expect(channel.getActiveThreadTs(REGISTERED_JID)).toBe('1700000001.000000');
    });

    it('updates activeThreadTs when a newer message arrives', async () => {
      const channel = new SlackChannel(createTestOpts());
      await connectChannel(channel);

      await triggerMessage({ channel: CHANNEL_ID, ts: '1700000001.000001', text: 'First', user: 'U_ALICE' });
      await triggerMessage({ channel: CHANNEL_ID, ts: '1700000005.000001', text: 'Second', user: 'U_BOB' });

      expect(channel.getActiveThreadTs(REGISTERED_JID)).toBe('1700000005.000001');
    });

    it('does not update activeThreadTs for bot messages (fromMe)', async () => {
      const channel = new SlackChannel(createTestOpts());
      await connectChannel(channel);

      await triggerMessage({ channel: CHANNEL_ID, ts: '1700000001.000001', text: 'User msg', user: 'U_ALICE' });
      await triggerMessage({ channel: CHANNEL_ID, ts: '1700000002.000001', text: 'Bot reply', user: 'BOT_USER_123' });

      expect(channel.getActiveThreadTs(REGISTERED_JID)).toBe('1700000001.000001');
    });

    it('does not track thread for unregistered channels', async () => {
      const channel = new SlackChannel(createTestOpts());
      await connectChannel(channel);

      await triggerMessage({ channel: 'C_UNREGISTERED', ts: '1700000001.000001', text: 'Not registered', user: 'U_ALICE' });

      expect(channel.getActiveThreadTs('slack:C_UNREGISTERED')).toBeUndefined();
    });

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

    it('replies in thread when activeThreadTs is set via incoming message', async () => {
      const channel = new SlackChannel(createTestOpts());
      await connectChannel(channel);

      await triggerMessage({ channel: CHANNEL_ID, ts: '1700000010.000001', text: 'Hi', user: 'U_ALICE' });

      await channel.sendMessage(REGISTERED_JID, 'Hello!');

      expect(fakeClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: CHANNEL_ID,
          thread_ts: '1700000010.000001',
          text: expect.stringContaining('Hello!'),
        }),
      );
    });

    it('uses group name as assistant label', async () => {
      const channel = new SlackChannel(createTestOpts());
      await connectChannel(channel);

      await channel.sendMessage(REGISTERED_JID, 'Response message');

      const call = fakeClient.chat.postMessage.mock.calls[0][0];
      expect(call.text).toMatch(/^\*Test Channel:\*/);
    });

    it('explicit threadTs overrides auto-tracked thread', async () => {
      const channel = new SlackChannel(createTestOpts());
      await connectChannel(channel);

      await triggerMessage({ channel: CHANNEL_ID, ts: '1700000010.000001', text: 'hi', user: 'U_ALICE' });

      await channel.sendMessage(REGISTERED_JID, 'Different thread reply', '1700000099.000001');

      expect(fakeClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ thread_ts: '1700000099.000001' }),
      );
    });

    it('sendMessageInThread always uses the provided thread_ts', async () => {
      const channel = new SlackChannel(createTestOpts());
      await connectChannel(channel);

      await channel.sendMessageInThread(REGISTERED_JID, 'Thread reply', '1700000050.000001');

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

    it('logs inThread=true when posting inside a thread', async () => {
      const { logger } = await import('../logger.js');
      const channel = new SlackChannel(createTestOpts());
      await connectChannel(channel);

      await triggerMessage({
        channel: CHANNEL_ID,
        ts: '1700000010.000001',
        text: 'hi',
        user: 'U_ALICE',
      });

      vi.mocked(logger.info).mockClear();
      await channel.sendMessage(REGISTERED_JID, 'Reply');

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

  // --- getActiveThreadTs ---

  describe('getActiveThreadTs', () => {
    it('returns undefined when no messages have arrived', async () => {
      const channel = new SlackChannel(createTestOpts());
      await connectChannel(channel);
      expect(channel.getActiveThreadTs(REGISTERED_JID)).toBeUndefined();
    });

    it('returns undefined for a jid with no tracked thread', async () => {
      const channel = new SlackChannel(createTestOpts());
      await connectChannel(channel);
      expect(channel.getActiveThreadTs('slack:COTHER')).toBeUndefined();
    });
  });

  // --- Message filtering ---

  describe('message filtering', () => {
    it('skips bot messages (bot_id set)', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await connectChannel(channel);

      await triggerMessage({
        channel: CHANNEL_ID,
        ts: '1700000001.000001',
        text: 'I am a bot',
        bot_id: 'B123',
        user: 'U_BOT',
      });

      expect(opts.onMessage).not.toHaveBeenCalled();
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
