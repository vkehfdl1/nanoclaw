import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase, getAllChats, storeChatMetadata } from './db.js';
import { getAvailableGroups, _setRegisteredGroups } from './index.js';

beforeEach(() => {
  _initTestDatabase();
  _setRegisteredGroups({});
});

// --- JID ownership patterns ---

describe('JID ownership patterns', () => {
  // These test the patterns that will become ownsJid() on the Channel interface

  it('Slack channel JID: starts with slack:C', () => {
    const jid = 'slack:C12345678';
    expect(jid.startsWith('slack:C')).toBe(true);
  });

  it('Slack MPIM/Private channel JID: starts with slack:G', () => {
    const jid = 'slack:G12345678';
    expect(jid.startsWith('slack:G')).toBe(true);
  });
});

// --- getAvailableGroups ---

describe('getAvailableGroups', () => {
  it('returns only groups, excludes DMs', () => {
    storeChatMetadata('slack:C111', '2024-01-01T00:00:01.000Z', 'Group 1', 'slack', true);
    storeChatMetadata('slack:D111', '2024-01-01T00:00:02.000Z', 'User DM', 'slack', false);
    storeChatMetadata('slack:C222', '2024-01-01T00:00:03.000Z', 'Group 2', 'slack', true);

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.jid)).toContain('slack:C111');
    expect(groups.map((g) => g.jid)).toContain('slack:C222');
    expect(groups.map((g) => g.jid)).not.toContain('slack:D111');
  });

  it('excludes __group_sync__ sentinel', () => {
    storeChatMetadata('__group_sync__', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('slack:C333', '2024-01-01T00:00:01.000Z', 'Group', 'slack', true);

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].jid).toBe('slack:C333');
  });

  it('marks registered groups correctly', () => {
    storeChatMetadata('slack:C444', '2024-01-01T00:00:01.000Z', 'Registered', 'slack', true);
    storeChatMetadata('slack:C555', '2024-01-01T00:00:02.000Z', 'Unregistered', 'slack', true);

    _setRegisteredGroups({
      'slack:C444': {
        name: 'Registered',
        folder: 'registered',
        trigger: '@Andy',
        aliases: ['andy'],
        added_at: '2024-01-01T00:00:00.000Z',
        gateway: { rules: [{ match: 'self_mention' }] },
      },
    });

    const groups = getAvailableGroups();
    const reg = groups.find((g) => g.jid === 'slack:C444');
    const unreg = groups.find((g) => g.jid === 'slack:C555');

    expect(reg?.isRegistered).toBe(true);
    expect(unreg?.isRegistered).toBe(false);
  });

  it('returns groups ordered by most recent activity', () => {
    storeChatMetadata('slack:Cold', '2024-01-01T00:00:01.000Z', 'Old', 'slack', true);
    storeChatMetadata('slack:Cnew', '2024-01-01T00:00:05.000Z', 'New', 'slack', true);
    storeChatMetadata('slack:Cmid', '2024-01-01T00:00:03.000Z', 'Mid', 'slack', true);

    const groups = getAvailableGroups();
    expect(groups[0].jid).toBe('slack:Cnew');
    expect(groups[1].jid).toBe('slack:Cmid');
    expect(groups[2].jid).toBe('slack:Cold');
  });

  it('excludes non-group chats regardless of JID format', () => {
    // Unknown JID format stored without is_group should not appear
    storeChatMetadata('unknown-format-123', '2024-01-01T00:00:01.000Z', 'Unknown');
    // Explicitly non-group with unusual JID
    storeChatMetadata('custom:abc', '2024-01-01T00:00:02.000Z', 'Custom DM', 'custom', false);
    // A real group for contrast
    storeChatMetadata('slack:C666', '2024-01-01T00:00:03.000Z', 'Group', 'slack', true);

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].jid).toBe('slack:C666');
  });

  it('returns empty array when no chats exist', () => {
    const groups = getAvailableGroups();
    expect(groups).toHaveLength(0);
  });
});
