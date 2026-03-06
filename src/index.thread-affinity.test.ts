import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase, storeChatMetadata, storeMessage } from './db.js';
import {
  _hadIpcDeliverySinceForTests,
  _isReplyToAgentOwnedThreadForTests,
  _mergeConversationContextForTests,
  _noteIpcDeliveryForTests,
  _setRegisteredGroups,
} from './index.js';
import type { RegisteredGroup } from './types.js';

const PM_GROUP: RegisteredGroup = {
  name: '영구',
  folder: 'pm-autorag',
  trigger: '@영구',
  aliases: ['young-gu', '영구'],
  added_at: '2024-01-01T00:00:00.000Z',
  gateway: { rules: [{ match: 'self_mention' }] },
};

beforeEach(() => {
  _initTestDatabase();
  _setRegisteredGroups({});
  storeChatMetadata('slack:C111', '2024-01-01T00:00:00.000Z', 'Test', 'slack', true);
});

describe('thread affinity helpers', () => {
  it('detects replies to a bot thread owned by the same agent', () => {
    storeMessage({
      id: 'thread-1',
      chat_jid: 'slack:C111',
      sender: 'unknown',
      sender_name: '영구',
      content: '*영구:* daily update',
      timestamp: '2024-01-01T00:00:00.000Z',
      is_from_me: true,
      is_bot_message: true,
      agent_source: '영구',
      thread_ts: 'thread-1',
    });

    expect(
      _isReplyToAgentOwnedThreadForTests('slack:C111', 'thread-1', PM_GROUP),
    ).toBe(true);
  });

  it('does not treat human-authored roots as agent-owned threads', () => {
    storeMessage({
      id: 'thread-2',
      chat_jid: 'slack:C111',
      sender: 'U_ALICE',
      sender_name: 'Alice',
      content: 'human root',
      timestamp: '2024-01-01T00:00:00.000Z',
      is_from_me: false,
      thread_ts: 'thread-2',
    });

    expect(
      _isReplyToAgentOwnedThreadForTests('slack:C111', 'thread-2', PM_GROUP),
    ).toBe(false);
  });

  it('merges assigned channel context with thread history and removes duplicates', () => {
    const merged = _mergeConversationContextForTests(
      [
        {
          id: 'reply-1',
          chat_jid: 'slack:C111',
          sender: 'U_ALICE',
          sender_name: 'Alice',
          content: 'follow-up',
          timestamp: '2024-01-01T00:01:00.000Z',
          thread_ts: 'thread-1',
        },
      ],
      [
        {
          id: 'thread-1',
          chat_jid: 'slack:C111',
          sender: 'unknown',
          sender_name: '영구',
          content: '*영구:* daily update',
          timestamp: '2024-01-01T00:00:00.000Z',
          is_bot_message: true,
          agent_source: '영구',
          thread_ts: 'thread-1',
        },
        {
          id: 'reply-1',
          chat_jid: 'slack:C111',
          sender: 'U_ALICE',
          sender_name: 'Alice',
          content: 'follow-up',
          timestamp: '2024-01-01T00:01:00.000Z',
          thread_ts: 'thread-1',
        },
      ],
    );

    expect(merged.map((msg) => msg.id)).toEqual(['thread-1', 'reply-1']);
  });

  it('tracks IPC deliveries by conversation key', () => {
    const beforeDelivery = Date.now();
    expect(
      _hadIpcDeliverySinceForTests('pm-autorag', 'slack:C111', 'thread-1', beforeDelivery),
    ).toBe(false);

    _noteIpcDeliveryForTests('pm-autorag', 'slack:C111', 'thread-1');

    expect(
      _hadIpcDeliverySinceForTests('pm-autorag', 'slack:C111', 'thread-1', beforeDelivery),
    ).toBe(true);
    expect(
      _hadIpcDeliverySinceForTests('pm-autorag', 'slack:C111', 'thread-2', beforeDelivery),
    ).toBe(false);
  });
});
