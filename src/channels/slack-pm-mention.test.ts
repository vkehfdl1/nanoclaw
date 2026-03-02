/**
 * Tests for the PM agent @mention context extraction module.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  extractPmMentionContext,
  formatPmMentionContent,
  isPmAgentGroup,
  PM_MENTION_CONTEXT_LIMIT,
  PmMentionContext,
  SlackHistoryMessage,
  SlackClientLike,
} from './slack-pm-mention.js';
import { RegisteredGroup } from '../types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeGroup(overrides: Partial<RegisteredGroup> = {}): RegisteredGroup {
  return {
    name: 'test-group',
    folder: 'test-group',
    trigger: '@bot',
    added_at: new Date().toISOString(),
    ...overrides,
  };
}

/** Build a mock Slack client that returns controlled data for each API method. */
function makeClient(overrides: {
  usersInfoName?: string | Record<string, string>;
  repliesMessages?: Array<{ ts: string; user?: string; text?: string; thread_ts?: string; bot_id?: string }>;
  historyMessages?: Array<{ ts: string; user?: string; text?: string; thread_ts?: string; bot_id?: string }>;
  repliesThrows?: boolean;
  historyThrows?: boolean;
} = {}): SlackClientLike {
  return {
    users: {
      info: vi.fn(async ({ user }: { user: string }) => {
        let name: string;
        if (typeof overrides.usersInfoName === 'string') {
          name = overrides.usersInfoName;
        } else if (overrides.usersInfoName && user in overrides.usersInfoName) {
          name = overrides.usersInfoName[user];
        } else {
          name = user; // fallback to user ID
        }
        return { user: { profile: { display_name: name } } };
      }),
    },
    conversations: {
      replies: vi.fn(async () => {
        if (overrides.repliesThrows) throw new Error('API error');
        return { messages: overrides.repliesMessages ?? [] };
      }),
      history: vi.fn(async () => {
        if (overrides.historyThrows) throw new Error('API error');
        return { messages: overrides.historyMessages ?? [] };
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// isPmAgentGroup
// ---------------------------------------------------------------------------

describe('isPmAgentGroup', () => {
  it('returns true when role is pm-agent', () => {
    expect(isPmAgentGroup(makeGroup({ role: 'pm-agent' }))).toBe(true);
  });

  it('returns false when role is undefined', () => {
    expect(isPmAgentGroup(makeGroup())).toBe(false);
  });

  it('returns false when role is another value', () => {
    expect(isPmAgentGroup(makeGroup({ role: 'marketer' }))).toBe(false);
    expect(isPmAgentGroup(makeGroup({ role: 'todomon' }))).toBe(false);
    expect(isPmAgentGroup(makeGroup({ role: '' }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractPmMentionContext — basic mention (top-level, not in thread)
// ---------------------------------------------------------------------------

describe('extractPmMentionContext — top-level mention', () => {
  const BOT_ID = 'U_BOT123';
  const channelId = 'C_CHAN001';
  // Slack ts: seconds since epoch + microseconds suffix
  const mentionTs = '1700000000.000100';

  it('strips bot mention from text', async () => {
    const client = makeClient({ usersInfoName: 'Alice' });
    const ctx = await extractPmMentionContext({
      text: `<@${BOT_ID}> can you check the deploy?`,
      userId: 'U_ALICE',
      channelId,
      ts: mentionTs,
      threadTs: undefined,
      client,
      botUserId: BOT_ID,
    });
    expect(ctx.mentionText).toBe('can you check the deploy?');
    expect(ctx.rawText).toBe(`<@${BOT_ID}> can you check the deploy?`);
  });

  it('resolves sender display name', async () => {
    const client = makeClient({ usersInfoName: 'Alice' });
    const ctx = await extractPmMentionContext({
      text: `<@${BOT_ID}> hello`,
      userId: 'U_ALICE',
      channelId,
      ts: mentionTs,
      threadTs: undefined,
      client,
      botUserId: BOT_ID,
    });
    expect(ctx.senderName).toBe('Alice');
    expect(ctx.senderUserId).toBe('U_ALICE');
  });

  it('sets isInThread=false when threadTs is undefined', async () => {
    const client = makeClient();
    const ctx = await extractPmMentionContext({
      text: `<@${BOT_ID}> ping`,
      userId: 'U_ALICE',
      channelId,
      ts: mentionTs,
      threadTs: undefined,
      client,
      botUserId: BOT_ID,
    });
    expect(ctx.isInThread).toBe(false);
    expect(ctx.threadTs).toBeUndefined();
    expect(ctx.parentMessageText).toBeUndefined();
  });

  it('sets isInThread=false when threadTs equals ts (message starts new thread)', async () => {
    const client = makeClient();
    const ctx = await extractPmMentionContext({
      text: `<@${BOT_ID}> ping`,
      userId: 'U_ALICE',
      channelId,
      ts: mentionTs,
      threadTs: mentionTs, // same as ts → starts a new thread, not a reply
      client,
      botUserId: BOT_ID,
    });
    expect(ctx.isInThread).toBe(false);
  });

  it('derives ISO timestamp from Slack ts', async () => {
    const client = makeClient({ usersInfoName: 'Alice' });
    const ctx = await extractPmMentionContext({
      text: `<@${BOT_ID}> hi`,
      userId: 'U_ALICE',
      channelId,
      ts: '1700000000.000100',
      threadTs: undefined,
      client,
      botUserId: BOT_ID,
    });
    expect(ctx.timestamp).toBe(new Date(1700000000 * 1000).toISOString());
  });

  it('fetches channel history when not in thread', async () => {
    // Slack conversations.history returns messages newest-first.
    // The implementation reverses them to produce oldest-first output.
    const historyMessages = [
      { ts: '1699999995.000100', user: 'U_ALICE', text: 'another message' }, // newer
      { ts: '1699999990.000100', user: 'U_BOB', text: 'earlier message' },   // older
    ];
    const client = makeClient({
      usersInfoName: { 'U_ALICE': 'Alice', 'U_BOB': 'Bob' },
      historyMessages,
    });

    const ctx = await extractPmMentionContext({
      text: `<@${BOT_ID}> what is the status?`,
      userId: 'U_ALICE',
      channelId,
      ts: mentionTs,
      threadTs: undefined,
      client,
      botUserId: BOT_ID,
    });

    expect(ctx.recentMessages).toHaveLength(2);
    // After reversal the messages should be in oldest-first order
    expect(ctx.recentMessages[0].text).toBe('earlier message');
    expect(ctx.recentMessages[1].text).toBe('another message');
  });

  it('excludes the triggering message from history', async () => {
    const historyMessages = [
      { ts: '1699999990.000100', user: 'U_BOB', text: 'earlier' },
      { ts: mentionTs, user: 'U_ALICE', text: `<@${BOT_ID}> ping` }, // the mention itself
    ];
    const client = makeClient({
      usersInfoName: { 'U_ALICE': 'Alice', 'U_BOB': 'Bob' },
      historyMessages,
    });

    const ctx = await extractPmMentionContext({
      text: `<@${BOT_ID}> ping`,
      userId: 'U_ALICE',
      channelId,
      ts: mentionTs,
      threadTs: undefined,
      client,
      botUserId: BOT_ID,
    });

    // Only "earlier" should remain; the @mention message itself is excluded
    expect(ctx.recentMessages).toHaveLength(1);
    expect(ctx.recentMessages[0].text).toBe('earlier');
  });

  it('excludes bot messages from channel history', async () => {
    const historyMessages = [
      { ts: '1699999990.000100', user: 'U_BOB', text: 'real message' },
      { ts: '1699999992.000100', bot_id: 'B_SOME_BOT', text: 'bot reply' },
    ];
    const client = makeClient({
      usersInfoName: 'Bob',
      historyMessages,
    });

    const ctx = await extractPmMentionContext({
      text: `<@${BOT_ID}> hello`,
      userId: 'U_ALICE',
      channelId,
      ts: mentionTs,
      threadTs: undefined,
      client,
      botUserId: BOT_ID,
    });

    // Bot message should be excluded
    expect(ctx.recentMessages).toHaveLength(1);
    expect(ctx.recentMessages[0].text).toBe('real message');
  });

  it('caps history at PM_MENTION_CONTEXT_LIMIT', async () => {
    // Build more messages than the limit
    const historyMessages = Array.from({ length: PM_MENTION_CONTEXT_LIMIT + 5 }, (_, i) => ({
      ts: `${1699999900 + i}.000100`,
      user: 'U_BOB',
      text: `message ${i}`,
    }));
    const client = makeClient({ usersInfoName: 'Bob', historyMessages });

    const ctx = await extractPmMentionContext({
      text: `<@${BOT_ID}> hello`,
      userId: 'U_ALICE',
      channelId,
      ts: mentionTs,
      threadTs: undefined,
      client,
      botUserId: BOT_ID,
    });

    expect(ctx.recentMessages.length).toBeLessThanOrEqual(PM_MENTION_CONTEXT_LIMIT);
  });

  it('returns empty recentMessages when channel history fails', async () => {
    const client = makeClient({ historyThrows: true });

    const ctx = await extractPmMentionContext({
      text: `<@${BOT_ID}> help`,
      userId: 'U_ALICE',
      channelId,
      ts: mentionTs,
      threadTs: undefined,
      client,
      botUserId: BOT_ID,
    });

    expect(ctx.recentMessages).toHaveLength(0);
    // The rest of the context should still be populated
    expect(ctx.mentionText).toBe('help');
    expect(ctx.senderUserId).toBe('U_ALICE');
  });

  it('falls back to userId as senderName when users.info fails', async () => {
    const client: SlackClientLike = {
      users: {
        info: vi.fn(async () => { throw new Error('not found'); }),
      },
      conversations: {
        replies: vi.fn(async () => ({ messages: [] })),
        history: vi.fn(async () => ({ messages: [] })),
      },
    };

    const ctx = await extractPmMentionContext({
      text: `<@${BOT_ID}> hi`,
      userId: 'U_ALICE',
      channelId,
      ts: mentionTs,
      threadTs: undefined,
      client,
      botUserId: BOT_ID,
    });

    expect(ctx.senderName).toBe('U_ALICE');
  });

  it('strips multiple bot mentions from text', async () => {
    const client = makeClient({ usersInfoName: 'Alice' });
    const ctx = await extractPmMentionContext({
      text: `<@${BOT_ID}> hey <@${BOT_ID}> what?`,
      userId: 'U_ALICE',
      channelId,
      ts: mentionTs,
      threadTs: undefined,
      client,
      botUserId: BOT_ID,
    });
    expect(ctx.mentionText).toBe('hey  what?');
  });
});

// ---------------------------------------------------------------------------
// extractPmMentionContext — mention inside an existing thread
// ---------------------------------------------------------------------------

describe('extractPmMentionContext — in-thread mention', () => {
  const BOT_ID = 'U_BOT123';
  const channelId = 'C_CHAN001';
  const parentTs = '1700000000.000000';
  const reply1Ts = '1700000010.000100';
  const reply2Ts = '1700000020.000100';
  const mentionTs = '1700000030.000100';

  it('sets isInThread=true when threadTs differs from ts', async () => {
    const client = makeClient({
      usersInfoName: 'Alice',
      repliesMessages: [
        { ts: parentTs, user: 'U_BOB', text: 'Parent message', thread_ts: parentTs },
      ],
    });

    const ctx = await extractPmMentionContext({
      text: `<@${BOT_ID}> review the PR`,
      userId: 'U_ALICE',
      channelId,
      ts: mentionTs,
      threadTs: parentTs,
      client,
      botUserId: BOT_ID,
    });

    expect(ctx.isInThread).toBe(true);
    expect(ctx.threadTs).toBe(parentTs);
  });

  it('extracts parent message text', async () => {
    const client = makeClient({
      usersInfoName: 'Alice',
      repliesMessages: [
        { ts: parentTs, user: 'U_BOB', text: 'Original thread starter', thread_ts: parentTs },
        { ts: reply1Ts, user: 'U_ALICE', text: 'First reply', thread_ts: parentTs },
      ],
    });

    const ctx = await extractPmMentionContext({
      text: `<@${BOT_ID}> help`,
      userId: 'U_ALICE',
      channelId,
      ts: mentionTs,
      threadTs: parentTs,
      client,
      botUserId: BOT_ID,
    });

    expect(ctx.parentMessageText).toBe('Original thread starter');
  });

  it('includes thread replies as context (excluding parent and triggering mention)', async () => {
    const client = makeClient({
      usersInfoName: { 'U_ALICE': 'Alice', 'U_BOB': 'Bob' },
      repliesMessages: [
        { ts: parentTs, user: 'U_BOB', text: 'Parent', thread_ts: parentTs },
        { ts: reply1Ts, user: 'U_BOB', text: 'First reply', thread_ts: parentTs },
        { ts: reply2Ts, user: 'U_ALICE', text: 'Second reply', thread_ts: parentTs },
        { ts: mentionTs, user: 'U_ALICE', text: `<@${BOT_ID}> help`, thread_ts: parentTs },
      ],
    });

    const ctx = await extractPmMentionContext({
      text: `<@${BOT_ID}> help`,
      userId: 'U_ALICE',
      channelId,
      ts: mentionTs,
      threadTs: parentTs,
      client,
      botUserId: BOT_ID,
    });

    // Should have reply1 and reply2, not parent or the @mention itself
    expect(ctx.recentMessages).toHaveLength(2);
    expect(ctx.recentMessages[0].text).toBe('First reply');
    expect(ctx.recentMessages[1].text).toBe('Second reply');
    expect(ctx.recentMessages[0].isThreadReply).toBe(true);
  });

  it('calls conversations.replies, not conversations.history, for threaded mentions', async () => {
    const client = makeClient({
      usersInfoName: 'Alice',
      repliesMessages: [
        { ts: parentTs, user: 'U_BOB', text: 'Parent', thread_ts: parentTs },
      ],
    });

    await extractPmMentionContext({
      text: `<@${BOT_ID}> check`,
      userId: 'U_ALICE',
      channelId,
      ts: mentionTs,
      threadTs: parentTs,
      client,
      botUserId: BOT_ID,
    });

    expect(client.conversations.replies).toHaveBeenCalledWith(
      expect.objectContaining({ channel: channelId, ts: parentTs }),
    );
    expect(client.conversations.history).not.toHaveBeenCalled();
  });

  it('returns empty recentMessages and no parentMessage when thread replies fails', async () => {
    const client = makeClient({ repliesThrows: true });

    const ctx = await extractPmMentionContext({
      text: `<@${BOT_ID}> help`,
      userId: 'U_ALICE',
      channelId,
      ts: mentionTs,
      threadTs: parentTs,
      client,
      botUserId: BOT_ID,
    });

    expect(ctx.recentMessages).toHaveLength(0);
    expect(ctx.parentMessageText).toBeUndefined();
    expect(ctx.isInThread).toBe(true); // isInThread is still correct
  });
});

// ---------------------------------------------------------------------------
// formatPmMentionContent
// ---------------------------------------------------------------------------

describe('formatPmMentionContent', () => {
  function makeCtx(overrides: Partial<PmMentionContext> = {}): PmMentionContext {
    return {
      mentionText: 'can you review the PR?',
      rawText: '<@U_BOT> can you review the PR?',
      senderUserId: 'U_ALICE',
      senderName: 'Alice',
      channelId: 'C_CHAN001',
      ts: '1700000000.000100',
      timestamp: new Date(1700000000 * 1000).toISOString(),
      threadTs: undefined,
      isInThread: false,
      parentMessageText: undefined,
      recentMessages: [],
      ...overrides,
    };
  }

  it('includes the sender name in the header', () => {
    const output = formatPmMentionContent(makeCtx());
    expect(output).toContain('[PM @mention from Alice]');
  });

  it('includes the cleaned mention text on the second line', () => {
    const output = formatPmMentionContent(makeCtx());
    expect(output).toContain('can you review the PR?');
  });

  it('includes recent channel history section when messages are present', () => {
    const messages: SlackHistoryMessage[] = [
      {
        ts: '1699999990.000100',
        userId: 'U_BOB',
        senderName: 'Bob',
        text: 'Deploy is ready',
        timestampIso: '2023-11-14T22:13:10.000Z',
        isThreadReply: false,
      },
    ];
    const output = formatPmMentionContent(makeCtx({ recentMessages: messages }));
    expect(output).toContain('[Recent channel history]');
    expect(output).toContain('Bob');
    expect(output).toContain('Deploy is ready');
  });

  it('uses [Thread history] label when isInThread=true', () => {
    const messages: SlackHistoryMessage[] = [
      {
        ts: '1699999990.000100',
        userId: 'U_BOB',
        senderName: 'Bob',
        text: 'thread reply',
        timestampIso: '2023-11-14T22:13:10.000Z',
        isThreadReply: true,
      },
    ];
    const output = formatPmMentionContent(
      makeCtx({ isInThread: true, recentMessages: messages }),
    );
    expect(output).toContain('[Thread history]');
    expect(output).not.toContain('[Recent channel history]');
  });

  it('includes thread parent section when isInThread=true and parentMessageText is set', () => {
    const output = formatPmMentionContent(
      makeCtx({
        isInThread: true,
        parentMessageText: 'Please review the auth module',
      }),
    );
    expect(output).toContain('[Thread context — parent message]');
    expect(output).toContain('Please review the auth module');
  });

  it('omits thread context section when parentMessageText is undefined', () => {
    const output = formatPmMentionContent(makeCtx({ isInThread: true }));
    expect(output).not.toContain('[Thread context — parent message]');
  });

  it('omits history section when recentMessages is empty', () => {
    const output = formatPmMentionContent(makeCtx());
    expect(output).not.toContain('[Recent channel history]');
    expect(output).not.toContain('[Thread history]');
  });

  it('truncates very long message texts to 400 characters', () => {
    const longText = 'x'.repeat(500);
    const messages: SlackHistoryMessage[] = [
      {
        ts: '1699999990.000100',
        userId: 'U_BOB',
        senderName: 'Bob',
        text: longText,
        timestampIso: '2023-11-14T22:13:10.000Z',
        isThreadReply: false,
      },
    ];
    const output = formatPmMentionContent(makeCtx({ recentMessages: messages }));
    // Should contain truncation indicator
    expect(output).toContain('…');
    // Should not contain the full 500-char string
    expect(output).not.toContain('x'.repeat(401));
  });

  it('does not truncate messages at exactly 400 characters', () => {
    const exactText = 'y'.repeat(400);
    const messages: SlackHistoryMessage[] = [
      {
        ts: '1699999990.000100',
        userId: 'U_BOB',
        senderName: 'Bob',
        text: exactText,
        timestampIso: '2023-11-14T22:13:10.000Z',
        isThreadReply: false,
      },
    ];
    const output = formatPmMentionContent(makeCtx({ recentMessages: messages }));
    expect(output).not.toContain('…');
    expect(output).toContain(exactText);
  });

  it('produces a multi-line string with header, mention, and history', () => {
    const messages: SlackHistoryMessage[] = [
      {
        ts: '1699999990.000100',
        userId: 'U_BOB',
        senderName: 'Bob',
        text: 'some context',
        timestampIso: '2023-11-14T22:13:10.000Z',
        isThreadReply: false,
      },
    ];
    const output = formatPmMentionContent(makeCtx({ recentMessages: messages }));
    const lines = output.split('\n');
    // First line is the header
    expect(lines[0]).toBe('[PM @mention from Alice]');
    // Second line is the mention text
    expect(lines[1]).toBe('can you review the PR?');
    // There's a blank separator before the history section
    const historyIdx = lines.indexOf('[Recent channel history]');
    expect(historyIdx).toBeGreaterThan(1);
  });
});
