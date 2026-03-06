import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase, setRegisteredGroup } from './db.js';
import { appendGithubEventMarker } from './github-event-markers.js';
import { normalizeGithubEvent } from './github-events.js';
import { RegisteredGroup } from './types.js';

const PM_GROUP: RegisteredGroup = {
  name: 'PM',
  folder: 'pm-test',
  trigger: '@PM',
  aliases: ['pm'],
  added_at: '2024-01-01T00:00:00.000Z',
  gateway: { rules: [{ match: 'self_mention' }] },
  role: 'pm-agent',
  containerConfig: {
    envVars: {
      GITHUB_REPO: 'owner/repo',
      ALLOWED_REPOS: 'repo',
    },
  },
};

function makeBasePayload() {
  return {
    action: 'opened',
    installation: { id: 123 },
    repository: {
      full_name: 'owner/repo',
      html_url: 'https://github.com/owner/repo',
    },
    sender: {
      login: 'alice',
      type: 'User',
    },
  };
}

beforeEach(() => {
  _initTestDatabase();
  setRegisteredGroup('slack:C123', PM_GROUP);
});

describe('normalizeGithubEvent', () => {
  it('normalizes issues.opened into an issue event', () => {
    const result = normalizeGithubEvent(
      'issues',
      {
        ...makeBasePayload(),
        action: 'opened',
        issue: { number: 42, title: 'Bug', body: 'Broken' },
      },
      'delivery-1',
    );

    expect(result.event).toBeDefined();
    expect(result.event!.groupFolder).toBe('pm-test');
    expect(result.event!.chatJid).toBe('slack:C123');
    expect(result.event!.resourceType).toBe('issue');
    expect(result.event!.resourceKey).toBe('github:issue:owner/repo#42');
    expect(result.event!.triggerKind).toBe('issue-opened');
  });

  it('ignores bot-authored issue comments', () => {
    const result = normalizeGithubEvent(
      'issue_comment',
      {
        ...makeBasePayload(),
        action: 'created',
        sender: { login: 'pm-bot[bot]', type: 'Bot' },
        issue: { number: 42, title: 'Bug', body: 'Broken' },
        comment: { body: 'Automated note' },
      },
      'delivery-2',
    );

    expect(result.event).toBeUndefined();
    expect(result.ignoreReason).toContain('bot-authored');
  });

  it('ignores NanoClaw-authored issue comments even when the sender looks human', () => {
    const result = normalizeGithubEvent(
      'issue_comment',
      {
        ...makeBasePayload(),
        action: 'created',
        sender: { login: 'vkehfdl1', type: 'User' },
        issue: { number: 42, title: 'Bug', body: 'Broken' },
        comment: { body: appendGithubEventMarker('Automated PM triage comment') },
      },
      'delivery-2b',
    );

    expect(result.event).toBeUndefined();
    expect(result.ignoreReason).toContain('NanoClaw-authored');
  });

  it('routes issue_comment on a PR into the PR resource flow', () => {
    const result = normalizeGithubEvent(
      'issue_comment',
      {
        ...makeBasePayload(),
        action: 'created',
        issue: {
          number: 99,
          title: 'PR discussion',
          body: 'Looks good',
          pull_request: { url: 'https://api.github.com/repos/owner/repo/pulls/99' },
        },
        comment: { body: 'Please verify this flow' },
      },
      'delivery-3',
    );

    expect(result.event).toBeDefined();
    expect(result.event!.resourceType).toBe('pr');
    expect(result.event!.resourceKey).toBe('github:pr:owner/repo#99');
    expect(result.event!.triggerKind).toBe('pr-comment-created');
  });

  it('ignores draft pull_request events until ready_for_review', () => {
    const result = normalizeGithubEvent(
      'pull_request',
      {
        ...makeBasePayload(),
        action: 'opened',
        pull_request: { number: 17, draft: true },
      },
      'delivery-4',
    );

    expect(result.event).toBeUndefined();
    expect(result.ignoreReason).toContain('draft PR');
  });
});
