import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  tmpGroupsDir: '',
  runContainerAgentMock: vi.fn(),
  writeTasksSnapshotMock: vi.fn(),
}));

vi.mock('./config.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./config.js')>();
  return {
    ...original,
    MAIN_GROUP_FOLDER: 'main',
    get GROUPS_DIR() {
      return mocks.tmpGroupsDir;
    },
  };
});

vi.mock('./container-runner.js', () => ({
  runContainerAgent: mocks.runContainerAgentMock,
  writeTasksSnapshot: mocks.writeTasksSnapshotMock,
}));

import {
  _initTestDatabase,
  createGithubWebhookDelivery,
  getGithubEventRun,
  getGithubWebhookDelivery,
  getSession,
  setRegisteredGroup,
} from './db.js';
import { enqueueGithubEvent } from './github-event-runner.js';
import { GroupQueue } from './group-queue.js';
import { RegisteredGroup, GithubNormalizedEvent } from './types.js';

const PM_GROUP: RegisteredGroup = {
  name: '영구',
  folder: 'pm-test',
  trigger: '@영구',
  aliases: ['young-gu', '영구'],
  added_at: '2024-01-01T00:00:00.000Z',
  gateway: { rules: [{ match: 'self_mention' }] },
  role: 'pm-agent',
  containerConfig: {
    envVars: {
      GITHUB_REPO: 'owner/repo',
      ALLOWED_REPOS: 'repo',
    },
    additionalMounts: [
      {
        hostPath: '~/Projects/repo',
        containerPath: 'repo',
        readonly: true,
      },
    ],
  },
};

function makeEvent(): GithubNormalizedEvent {
  return {
    deliveryId: 'delivery-1',
    eventName: 'issues',
    action: 'opened',
    installationId: 123,
    repositoryFullName: 'owner/repo',
    repositoryUrl: 'https://github.com/owner/repo',
    groupFolder: 'pm-test',
    chatJid: 'slack:C123',
    resourceType: 'issue',
    resourceNumber: 42,
    resourceKey: 'github:issue:owner/repo#42',
    triggerKind: 'issue-opened',
    author: {
      login: 'alice',
      type: 'User',
      isBot: false,
    },
    payload: {
      action: 'opened',
      issue: { number: 42, title: 'Broken', body: 'Broken body' },
    },
  };
}

describe('enqueueGithubEvent', () => {
  let queuedRun: Promise<void> | null;
  let sentMessages: Array<{ jid: string; text: string; agentLabel?: string }>;

  beforeEach(() => {
    mocks.tmpGroupsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-github-event-'));
    _initTestDatabase();
    setRegisteredGroup('slack:C123', PM_GROUP);
    sentMessages = [];
    queuedRun = null;
    mocks.runContainerAgentMock.mockReset();
    mocks.writeTasksSnapshotMock.mockReset();

    mocks.runContainerAgentMock.mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          result: 'Handled GitHub issue #42',
          newSessionId: 'session-123',
        });
        return {
          status: 'success',
          result: 'Handled GitHub issue #42',
          newSessionId: 'session-123',
        };
      },
    );
  });

  afterEach(() => {
    if (mocks.tmpGroupsDir) {
      fs.rmSync(mocks.tmpGroupsDir, { recursive: true, force: true });
    }
  });

  it('queues an event run, preserves an isolated session, and marks the issue seen', async () => {
    createGithubWebhookDelivery({
      delivery_id: 'delivery-1',
      event_name: 'issues',
      action: 'opened',
      repository_full_name: 'owner/repo',
      installation_id: 123,
      resource_key: null,
      received_at: '2024-01-01T00:00:00.000Z',
      status: 'received',
      error: null,
      payload_json: JSON.stringify({ ok: true }),
    });

    const fakeQueue = {
      enqueueTask: (_groupKey: string, _taskId: string, fn: () => Promise<void>) => {
        queuedRun = fn();
      },
      closeStdin: () => {},
      notifyIdle: () => {},
    } as unknown as GroupQueue;

    const runId = enqueueGithubEvent(makeEvent(), {
      registeredGroups: () => ({ 'slack:C123': PM_GROUP }),
      queue: fakeQueue,
      onProcess: () => {},
      sendMessage: async (jid, text, options) => {
        sentMessages.push({ jid, text, agentLabel: options?.agentLabel });
      },
    });

    await queuedRun;

    expect(sentMessages).toEqual([]);
    expect(getSession('pm-test', 'slack:C123', 'github:issue:owner/repo#42')).toBe('session-123');
    expect(getGithubEventRun(runId)?.status).toBe('success');
    expect(getGithubEventRun(runId)?.result).toBe('Handled GitHub issue #42');
    expect(getGithubWebhookDelivery('delivery-1')?.status).toBe('processed');

    const seenPath = path.join(mocks.tmpGroupsDir, 'pm-test', 'seen_issues.json');
    expect(JSON.parse(fs.readFileSync(seenPath, 'utf-8'))).toEqual([42]);
  });
});
