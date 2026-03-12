import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase, storeChatMetadata } from './db.js';
import {
  _evaluateReplyAuditOutcomeForTests,
  _hadIpcDeliverySinceForTests,
  _mergeConversationContextForTests,
  _noteIpcDeliveryForTests,
  _resolveReplyThreadTsForTests,
  _setRegisteredGroups,
} from './index.js';
import type { ReplyAuditParseResult } from './router.js';

beforeEach(() => {
  _initTestDatabase();
  _setRegisteredGroups({});
  storeChatMetadata('slack:C111', '2024-01-01T00:00:00.000Z', 'Test', 'slack', true);
});

describe('thread affinity helpers', () => {
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

  it('prefers the current channel batch anchor over stale channel context when choosing reply thread', () => {
    const replyThreadTs = _resolveReplyThreadTsForTests(
      '__channel__',
      [
        {
          id: 'old-root',
          chat_jid: 'slack:C111',
          sender: 'U_BOBB',
          sender_name: 'Bobb',
          content: '오~~~',
          timestamp: '2024-01-01T00:00:00.000Z',
          thread_ts: 'old-root',
        },
        {
          id: 'new-root',
          chat_jid: 'slack:C111',
          sender: 'U_JEFF',
          sender_name: 'Jeffrey',
          content: '영구야 이거 봐줘',
          timestamp: '2024-01-01T00:10:00.000Z',
          thread_ts: 'new-root',
        },
      ],
      'new-root',
    );

    expect(replyThreadTs).toBe('new-root');
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

describe('reply audit decision helper', () => {
  it('requests correction when reply was needed but no visible delivery happened', () => {
    const audit: ReplyAuditParseResult = {
      kind: 'valid',
      audit: {
        reply_needed: true,
        reply_sent: false,
        reason: 'user asked a direct question',
      },
    };

    expect(
      _evaluateReplyAuditOutcomeForTests(audit, false, false, false),
    ).toEqual({
      action: 'correct',
      reason: 'reply_needed_but_send_message_missing',
      correctionMode: 'send_visible_reply',
    });
  });

  it('allows silent completion when audit says no visible reply is needed', () => {
    const audit: ReplyAuditParseResult = {
      kind: 'valid',
      audit: {
        reply_needed: false,
        reply_sent: false,
        reason: 'no actionable response needed',
      },
    };

    expect(
      _evaluateReplyAuditOutcomeForTests(audit, false, false, false),
    ).toEqual({
      action: 'none',
      reason: 'silent_ok:no actionable response needed',
    });
  });

  it('does not trigger correction for missing audit when a visible reply already went out', () => {
    expect(
      _evaluateReplyAuditOutcomeForTests({ kind: 'missing' }, true, false, false),
    ).toEqual({
      action: 'protocol_violation',
      reason: 'missing_reply_audit',
    });
  });

  it('asks for a reassessment correction when audit is missing and no visible reply was sent', () => {
    expect(
      _evaluateReplyAuditOutcomeForTests({ kind: 'missing' }, false, false, false),
    ).toEqual({
      action: 'correct',
      reason: 'missing_reply_audit',
      correctionMode: 'reassess_reply_need',
    });
  });

  it('treats a failed force-reply correction as a protocol violation', () => {
    const audit: ReplyAuditParseResult = {
      kind: 'valid',
      audit: {
        reply_needed: false,
        reply_sent: false,
        reason: 'agent changed its mind',
      },
    };

    expect(
      _evaluateReplyAuditOutcomeForTests(audit, false, true, true),
    ).toEqual({
      action: 'protocol_violation',
      reason: 'corrective_visible_reply_still_missing',
    });
  });
});
