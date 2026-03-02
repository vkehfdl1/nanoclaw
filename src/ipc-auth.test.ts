import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

import {
  _initTestDatabase,
  createTask,
  deleteSession,
  getAllTasks,
  getMessagesSince,
  getRegisteredGroup,
  getSession,
  getTaskById,
  setSession,
  setRegisteredGroup,
} from './db.js';
import {
  _resetPingPongCounts,
  _setHostCommandRunnerForTest,
  processTaskIpc,
  IpcDeps,
} from './ipc.js';
import { DATA_DIR, HOST_REPOS_DIR } from './config.js';
import { RegisteredGroup } from './types.js';

// Set up registered groups used across tests
const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
};

const OTHER_GROUP: RegisteredGroup = {
  name: 'Other',
  folder: 'other-group',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

const THIRD_GROUP: RegisteredGroup = {
  name: 'Third',
  folder: 'third-group',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

let groups: Record<string, RegisteredGroup>;
let deps: IpcDeps;
let sentMessages: Array<{ jid: string; text: string }>;

beforeEach(() => {
  _initTestDatabase();
  _resetPingPongCounts();
  _setHostCommandRunnerForTest();
  sentMessages = [];

  groups = {
    'main@g.us': MAIN_GROUP,
    'other@g.us': OTHER_GROUP,
    'third@g.us': THIRD_GROUP,
  };

  // Populate DB as well
  setRegisteredGroup('main@g.us', MAIN_GROUP);
  setRegisteredGroup('other@g.us', OTHER_GROUP);
  setRegisteredGroup('third@g.us', THIRD_GROUP);

  deps = {
    sendMessage: async (jid, text) => {
      sentMessages.push({ jid, text });
    },
    sendFile: async () => {},
    registeredGroups: () => groups,
    registerGroup: (jid, group) => {
      groups[jid] = group;
      setRegisteredGroup(jid, group);
      // Mock the fs.mkdirSync that registerGroup does
    },
    syncGroupMetadata: async () => {},
    getAvailableGroups: () => [],
    writeGroupsSnapshot: () => {},
    clearSession: (_chatJid, groupFolder) => {
      deleteSession(groupFolder);
    },
  };

  fs.rmSync(path.join(DATA_DIR, 'ipc', 'other-group', 'responses'), {
    recursive: true,
    force: true,
  });
  fs.rmSync(path.join(HOST_REPOS_DIR, 'autorag-research'), {
    recursive: true,
    force: true,
  });
});

// --- schedule_task authorization ---

describe('schedule_task authorization', () => {
  it('main group can schedule for another group', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'do something',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00.000Z',
        targetJid: 'other@g.us',
      },
      'main',
      true,
      deps,
    );

    // Verify task was created in DB for the other group
    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(1);
    expect(allTasks[0].group_folder).toBe('other-group');
  });

  it('non-main group can schedule for itself', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'self task',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00.000Z',
        targetJid: 'other@g.us',
      },
      'other-group',
      false,
      deps,
    );

    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(1);
    expect(allTasks[0].group_folder).toBe('other-group');
  });

  it('non-main group cannot schedule for another group', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'unauthorized',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00.000Z',
        targetJid: 'main@g.us',
      },
      'other-group',
      false,
      deps,
    );

    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(0);
  });

  it('rejects schedule_task for unregistered target JID', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'no target',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00.000Z',
        targetJid: 'unknown@g.us',
      },
      'main',
      true,
      deps,
    );

    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(0);
  });
});

// --- pause_task authorization ---

describe('pause_task authorization', () => {
  beforeEach(() => {
    createTask({
      id: 'task-main',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: 'main task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2025-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
    createTask({
      id: 'task-other',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'other task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2025-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
  });

  it('main group can pause any task', async () => {
    await processTaskIpc({ type: 'pause_task', taskId: 'task-other' }, 'main', true, deps);
    expect(getTaskById('task-other')!.status).toBe('paused');
  });

  it('non-main group can pause its own task', async () => {
    await processTaskIpc({ type: 'pause_task', taskId: 'task-other' }, 'other-group', false, deps);
    expect(getTaskById('task-other')!.status).toBe('paused');
  });

  it('non-main group cannot pause another groups task', async () => {
    await processTaskIpc({ type: 'pause_task', taskId: 'task-main' }, 'other-group', false, deps);
    expect(getTaskById('task-main')!.status).toBe('active');
  });
});

// --- resume_task authorization ---

describe('resume_task authorization', () => {
  beforeEach(() => {
    createTask({
      id: 'task-paused',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'paused task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2025-06-01T00:00:00.000Z',
      status: 'paused',
      created_at: '2024-01-01T00:00:00.000Z',
    });
  });

  it('main group can resume any task', async () => {
    await processTaskIpc({ type: 'resume_task', taskId: 'task-paused' }, 'main', true, deps);
    expect(getTaskById('task-paused')!.status).toBe('active');
  });

  it('non-main group can resume its own task', async () => {
    await processTaskIpc({ type: 'resume_task', taskId: 'task-paused' }, 'other-group', false, deps);
    expect(getTaskById('task-paused')!.status).toBe('active');
  });

  it('non-main group cannot resume another groups task', async () => {
    await processTaskIpc({ type: 'resume_task', taskId: 'task-paused' }, 'third-group', false, deps);
    expect(getTaskById('task-paused')!.status).toBe('paused');
  });
});

// --- cancel_task authorization ---

describe('cancel_task authorization', () => {
  it('main group can cancel any task', async () => {
    createTask({
      id: 'task-to-cancel',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'cancel me',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await processTaskIpc({ type: 'cancel_task', taskId: 'task-to-cancel' }, 'main', true, deps);
    expect(getTaskById('task-to-cancel')).toBeUndefined();
  });

  it('non-main group can cancel its own task', async () => {
    createTask({
      id: 'task-own',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'my task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await processTaskIpc({ type: 'cancel_task', taskId: 'task-own' }, 'other-group', false, deps);
    expect(getTaskById('task-own')).toBeUndefined();
  });

  it('non-main group cannot cancel another groups task', async () => {
    createTask({
      id: 'task-foreign',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: 'not yours',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await processTaskIpc({ type: 'cancel_task', taskId: 'task-foreign' }, 'other-group', false, deps);
    expect(getTaskById('task-foreign')).toBeDefined();
  });
});

// --- register_group authorization ---

describe('register_group authorization', () => {
  it('non-main group cannot register a group', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'New Group',
        folder: 'new-group',
        trigger: '@Andy',
      },
      'other-group',
      false,
      deps,
    );

    // registeredGroups should not have changed
    expect(groups['new@g.us']).toBeUndefined();
  });

  it('main group cannot register with unsafe folder path', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'New Group',
        folder: '../../outside',
        trigger: '@Andy',
      },
      'main',
      true,
      deps,
    );

    expect(groups['new@g.us']).toBeUndefined();
  });
});

// --- refresh_groups authorization ---

describe('refresh_groups authorization', () => {
  it('non-main group cannot trigger refresh', async () => {
    // This should be silently blocked (no crash, no effect)
    await processTaskIpc({ type: 'refresh_groups' }, 'other-group', false, deps);
    // If we got here without error, the auth gate worked
  });
});

// --- IPC message authorization ---
// Tests the authorization pattern from startIpcWatcher (ipc.ts).
// The logic: isMain || (targetGroup && targetGroup.folder === sourceGroup)

describe('IPC message authorization', () => {
  // Replicate the exact check from the IPC watcher
  function isMessageAuthorized(
    sourceGroup: string,
    isMain: boolean,
    targetChatJid: string,
    registeredGroups: Record<string, RegisteredGroup>,
  ): boolean {
    const targetGroup = registeredGroups[targetChatJid];
    return isMain || (!!targetGroup && targetGroup.folder === sourceGroup);
  }

  it('main group can send to any group', () => {
    expect(isMessageAuthorized('main', true, 'other@g.us', groups)).toBe(true);
    expect(isMessageAuthorized('main', true, 'third@g.us', groups)).toBe(true);
  });

  it('non-main group can send to its own chat', () => {
    expect(isMessageAuthorized('other-group', false, 'other@g.us', groups)).toBe(true);
  });

  it('non-main group cannot send to another groups chat', () => {
    expect(isMessageAuthorized('other-group', false, 'main@g.us', groups)).toBe(false);
    expect(isMessageAuthorized('other-group', false, 'third@g.us', groups)).toBe(false);
  });

  it('non-main group cannot send to unregistered JID', () => {
    expect(isMessageAuthorized('other-group', false, 'unknown@g.us', groups)).toBe(false);
  });

  it('main group can send to unregistered JID', () => {
    // Main is always authorized regardless of target
    expect(isMessageAuthorized('main', true, 'unknown@g.us', groups)).toBe(true);
  });
});

// --- schedule_task with cron and interval types ---

describe('schedule_task schedule types', () => {
  it('creates task with cron schedule and computes next_run', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'cron task',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *', // every day at 9am
        targetJid: 'other@g.us',
      },
      'main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].schedule_type).toBe('cron');
    expect(tasks[0].next_run).toBeTruthy();
    // next_run should be a valid ISO date in the future
    expect(new Date(tasks[0].next_run!).getTime()).toBeGreaterThan(Date.now() - 60000);
  });

  it('rejects invalid cron expression', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad cron',
        schedule_type: 'cron',
        schedule_value: 'not a cron',
        targetJid: 'other@g.us',
      },
      'main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('creates task with interval schedule', async () => {
    const before = Date.now();

    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'interval task',
        schedule_type: 'interval',
        schedule_value: '3600000', // 1 hour
        targetJid: 'other@g.us',
      },
      'main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].schedule_type).toBe('interval');
    // next_run should be ~1 hour from now
    const nextRun = new Date(tasks[0].next_run!).getTime();
    expect(nextRun).toBeGreaterThanOrEqual(before + 3600000 - 1000);
    expect(nextRun).toBeLessThanOrEqual(Date.now() + 3600000 + 1000);
  });

  it('rejects invalid interval (non-numeric)', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad interval',
        schedule_type: 'interval',
        schedule_value: 'abc',
        targetJid: 'other@g.us',
      },
      'main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('rejects invalid interval (zero)', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'zero interval',
        schedule_type: 'interval',
        schedule_value: '0',
        targetJid: 'other@g.us',
      },
      'main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('rejects invalid once timestamp', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad once',
        schedule_type: 'once',
        schedule_value: 'not-a-date',
        targetJid: 'other@g.us',
      },
      'main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });
});

// --- context_mode defaulting ---

describe('schedule_task context_mode', () => {
  it('accepts context_mode=group', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'group context',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00.000Z',
        context_mode: 'group',
        targetJid: 'other@g.us',
      },
      'main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('group');
  });

  it('accepts context_mode=isolated', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'isolated context',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00.000Z',
        context_mode: 'isolated',
        targetJid: 'other@g.us',
      },
      'main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('isolated');
  });

  it('defaults invalid context_mode to isolated', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad context',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00.000Z',
        context_mode: 'bogus' as any,
        targetJid: 'other@g.us',
      },
      'main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('isolated');
  });

  it('defaults missing context_mode to isolated', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'no context mode',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00.000Z',
        targetJid: 'other@g.us',
      },
      'main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('isolated');
  });
});

// --- register_group success path ---

describe('register_group success', () => {
  it('main group can register a new group', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'New Group',
        folder: 'new-group',
        trigger: '@Andy',
      },
      'main',
      true,
      deps,
    );

    // Verify group was registered in DB
    const group = getRegisteredGroup('new@g.us');
    expect(group).toBeDefined();
    expect(group!.name).toBe('New Group');
    expect(group!.folder).toBe('new-group');
    expect(group!.trigger).toBe('@Andy');
  });

  it('register_group passes role through to registration handler', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'pm@g.us',
        name: 'PM Agent',
        folder: 'pm-agent',
        trigger: '@pm',
        role: 'pm-agent',
      },
      'main',
      true,
      deps,
    );

    const group = getRegisteredGroup('pm@g.us');
    expect(group).toBeDefined();
    expect(group!.role).toBe('pm-agent');
  });

  it('register_group rejects request with missing fields', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'partial@g.us',
        name: 'Partial',
        // missing folder and trigger
      },
      'main',
      true,
      deps,
    );

    expect(getRegisteredGroup('partial@g.us')).toBeUndefined();
  });
});

// --- clear_session authorization ---

describe('clear_session authorization', () => {
  beforeEach(() => {
    setSession('other-group', 'session-other');
    setSession('main', 'session-main');
  });

  it('main group can clear another group session', async () => {
    await processTaskIpc(
      {
        type: 'clear_session',
        targetJid: 'other@g.us',
      },
      'main',
      true,
      deps,
    );

    expect(getSession('other-group')).toBeUndefined();
  });

  it('non-main group cannot clear another group session', async () => {
    await processTaskIpc(
      {
        type: 'clear_session',
        targetJid: 'main@g.us',
      },
      'other-group',
      false,
      deps,
    );

    expect(getSession('main')).toBe('session-main');
  });
});

// --- send_agent_message ---

describe('send_agent_message', () => {
  it('routes to target agent channel and stores cross-agent message in DB', async () => {
    await processTaskIpc(
      {
        type: 'send_agent_message',
        targetAgent: 'third-group',
        text: 'Please review this PR',
        sourceChatJid: 'other@g.us',
      },
      'other-group',
      false,
      deps,
    );

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].jid).toBe('third@g.us');
    expect(sentMessages[0].text).toContain('[from @Andy]');

    const stored = getMessagesSince('third@g.us', '', 'Andy');
    expect(stored).toHaveLength(1);
    expect(stored[0].content).toContain('[from @Andy]');
    expect(stored[0].content).toContain('Please review this PR');
  });

  it('respects explicit channelJid when target agent is registered there', async () => {
    setRegisteredGroup('third-alt@g.us', {
      ...THIRD_GROUP,
      added_at: '2024-01-01T00:00:01.000Z',
    });
    groups['third-alt@g.us'] = {
      ...THIRD_GROUP,
      added_at: '2024-01-01T00:00:01.000Z',
    };

    await processTaskIpc(
      {
        type: 'send_agent_message',
        targetAgent: 'third-group',
        channelJid: 'third-alt@g.us',
        text: 'Use this channel',
        sourceChatJid: 'other@g.us',
      },
      'other-group',
      false,
      deps,
    );

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].jid).toBe('third-alt@g.us');
  });

  it('blocks explicit channelJid when target agent is not registered there', async () => {
    await processTaskIpc(
      {
        type: 'send_agent_message',
        targetAgent: 'third-group',
        channelJid: 'main@g.us',
        text: 'This should be blocked',
        sourceChatJid: 'other@g.us',
      },
      'other-group',
      false,
      deps,
    );

    expect(sentMessages).toHaveLength(0);
    expect(getMessagesSince('main@g.us', '', 'Andy')).toHaveLength(0);
  });

  it('blocks cross-agent ping-pong after 5 turns per (source,target,thread)', async () => {
    for (let i = 0; i < 6; i += 1) {
      await processTaskIpc(
        {
          type: 'send_agent_message',
          targetAgent: 'third-group',
          text: `turn ${i + 1}`,
          sourceChatJid: 'other@g.us',
        },
        'other-group',
        false,
        deps,
      );
    }

    expect(sentMessages).toHaveLength(5);

    const stored = getMessagesSince('third@g.us', '', 'Andy');
    expect(stored).toHaveLength(5);
    expect(stored[4].content).toContain('turn 5');
  });

  it('tracks ping-pong counters independently for different threads in same channel', async () => {
    for (let i = 0; i < 5; i += 1) {
      await processTaskIpc(
        {
          type: 'send_agent_message',
          targetAgent: 'third-group',
          text: `thread-a turn ${i + 1}`,
          sourceChatJid: 'other@g.us',
          threadTs: '1700000000.100000',
        },
        'other-group',
        false,
        deps,
      );
    }

    await processTaskIpc(
      {
        type: 'send_agent_message',
        targetAgent: 'third-group',
        text: 'thread-b first message',
        sourceChatJid: 'other@g.us',
        threadTs: '1700000000.200000',
      },
      'other-group',
      false,
      deps,
    );

    expect(sentMessages).toHaveLength(6);
    expect(sentMessages[5].text).toContain('thread-b first message');
  });
});

// --- host repo task authorization and execution ---

describe('host repo IPC tasks', () => {
  function configureAllowedRepo(repo: string): string {
    const updated = {
      ...groups['other@g.us'],
      containerConfig: {
        envVars: {
          ALLOWED_REPOS: repo,
        },
      },
    };
    groups['other@g.us'] = updated;
    setRegisteredGroup('other@g.us', updated);

    const repoPath = path.join(HOST_REPOS_DIR, repo);
    fs.mkdirSync(repoPath, { recursive: true });
    return repoPath;
  }

  function readTaskResponse(requestId: string): any {
    const responsePath = path.join(
      DATA_DIR,
      'ipc',
      'other-group',
      'responses',
      `${requestId}.json`,
    );
    expect(fs.existsSync(responsePath)).toBe(true);
    return JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
  }

  it('rejects unauthorized repo access and writes error response', async () => {
    const runner = vi.fn(async () => ({ stdout: '', stderr: '' }));
    _setHostCommandRunnerForTest(runner);

    await processTaskIpc(
      {
        type: 'git_checkout',
        requestId: 'req-unauthorized',
        repo: 'private-repo',
        branch: 'main',
      },
      'other-group',
      false,
      deps,
    );

    expect(runner).not.toHaveBeenCalled();
    const response = readTaskResponse('req-unauthorized');
    expect(response.ok).toBe(false);
    expect(response.error).toContain('not allowed');
  });

  it('runs codex_exec in allowed repo and writes stdout response', async () => {
    const repoPath = configureAllowedRepo('autorag-research');

    const runner = vi.fn(async (command: string, args: string[]) => {
      if (command === 'git') return { stdout: '', stderr: '' };
      if (command === 'codex') return { stdout: 'codex complete', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    _setHostCommandRunnerForTest(runner);

    await processTaskIpc(
      {
        type: 'codex_exec',
        requestId: 'req-codex',
        repo: 'autorag-research',
        prompt: 'Implement feature X',
        branch: 'feat/us-005',
      },
      'other-group',
      false,
      deps,
    );

    expect(runner).toHaveBeenNthCalledWith(
      1,
      'git',
      ['checkout', 'feat/us-005'],
      expect.objectContaining({ cwd: repoPath }),
    );
    expect(runner).toHaveBeenNthCalledWith(
      2,
      'codex',
      expect.arrayContaining(['exec', '--full-auto', '--sandbox', 'danger-full-access', '--cd', repoPath]),
      expect.any(Object),
    );

    const response = readTaskResponse('req-codex');
    expect(response.ok).toBe(true);
    expect(response.stdout).toBe('codex complete');
  });

  it('git_pull defaults to current branch when none is provided', async () => {
    configureAllowedRepo('autorag-research');

    const runner = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === 'rev-parse') return { stdout: 'main\n', stderr: '' };
      if (args[0] === 'pull') return { stdout: 'Already up to date.', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    _setHostCommandRunnerForTest(runner);

    await processTaskIpc(
      {
        type: 'git_pull',
        requestId: 'req-pull',
        repo: 'autorag-research',
      },
      'other-group',
      false,
      deps,
    );

    expect(runner).toHaveBeenNthCalledWith(
      1,
      'git',
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      expect.any(Object),
    );
    expect(runner).toHaveBeenNthCalledWith(
      2,
      'git',
      ['pull', 'origin', 'main'],
      expect.any(Object),
    );

    const response = readTaskResponse('req-pull');
    expect(response.ok).toBe(true);
    expect(response.stdout).toContain('Already up to date.');
  });

  it('gh_issue_list normalizes issues to number/title/body/labels/state', async () => {
    const repoPath = configureAllowedRepo('autorag-research');

    const runner = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list') {
        return {
          stdout: JSON.stringify([
            {
              number: 17,
              title: 'Improve triage flow',
              body: 'Need clearer PM issue triage output.',
              state: 'OPEN',
              labels: [{ name: 'enhancement' }, { name: 'pm' }],
              url: 'https://github.com/example/repo/issues/17',
            },
            {
              number: 18,
              title: 'Issue without body',
              body: null,
              state: 'CLOSED',
              labels: [],
              url: 'https://github.com/example/repo/issues/18',
            },
          ]),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });
    _setHostCommandRunnerForTest(runner);

    await processTaskIpc(
      {
        type: 'gh_issue_list',
        requestId: 'req-gh-list',
        repo: 'autorag-research',
      },
      'other-group',
      false,
      deps,
    );

    expect(runner).toHaveBeenCalledWith(
      'gh',
      [
        'issue',
        'list',
        '--state',
        'open',
        '--json',
        'number,title,body,state,labels,url',
      ],
      expect.objectContaining({ cwd: repoPath }),
    );

    const response = readTaskResponse('req-gh-list');
    expect(response.ok).toBe(true);
    expect(JSON.parse(response.stdout)).toEqual([
      {
        number: 17,
        title: 'Improve triage flow',
        body: 'Need clearer PM issue triage output.',
        labels: ['enhancement', 'pm'],
        state: 'open',
      },
      {
        number: 18,
        title: 'Issue without body',
        body: '',
        labels: [],
        state: 'closed',
      },
    ]);
  });

  it('gh_issue_list returns an error when gh output is not valid JSON', async () => {
    configureAllowedRepo('autorag-research');

    const runner = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list') {
        return { stdout: 'not-json', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    _setHostCommandRunnerForTest(runner);

    await processTaskIpc(
      {
        type: 'gh_issue_list',
        requestId: 'req-gh-list-invalid',
        repo: 'autorag-research',
      },
      'other-group',
      false,
      deps,
    );

    const response = readTaskResponse('req-gh-list-invalid');
    expect(response.ok).toBe(false);
    expect(response.error).toContain('Failed to parse gh issue list output');
  });

  it('gh_issue_comment posts a comment to the requested issue number', async () => {
    const repoPath = configureAllowedRepo('autorag-research');

    const runner = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'comment') {
        return { stdout: 'https://github.com/example/repo/issues/17#issuecomment-1', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    _setHostCommandRunnerForTest(runner);

    await processTaskIpc(
      {
        type: 'gh_issue_comment',
        requestId: 'req-gh-comment',
        repo: 'autorag-research',
        issue_number: 17,
        body: 'Initial PM triage complete.',
      },
      'other-group',
      false,
      deps,
    );

    expect(runner).toHaveBeenCalledWith(
      'gh',
      ['issue', 'comment', '17', '--body', 'Initial PM triage complete.'],
      expect.objectContaining({ cwd: repoPath }),
    );

    const response = readTaskResponse('req-gh-comment');
    expect(response.ok).toBe(true);
    expect(response.stdout).toContain('issuecomment');
  });

  it('gh_pr_diff fetches the PR diff for the requested PR number', async () => {
    const repoPath = configureAllowedRepo('autorag-research');

    const runner = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === 'pr' && args[1] === 'diff') {
        return { stdout: 'diff --git a/src/a.ts b/src/a.ts\n+new line', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    _setHostCommandRunnerForTest(runner);

    await processTaskIpc(
      {
        type: 'gh_pr_diff',
        requestId: 'req-gh-pr-diff',
        repo: 'autorag-research',
        pr_number: 42,
      },
      'other-group',
      false,
      deps,
    );

    expect(runner).toHaveBeenCalledWith(
      'gh',
      ['pr', 'diff', '42'],
      expect.objectContaining({ cwd: repoPath }),
    );

    const response = readTaskResponse('req-gh-pr-diff');
    expect(response.ok).toBe(true);
    expect(response.stdout).toContain('diff --git');
  });

  it('gh_pr_review posts a structured comment review to the PR', async () => {
    const repoPath = configureAllowedRepo('autorag-research');
    const reviewBody =
      '## Summary\n- Looks mostly good.\n\n## Issues\n- warning: missing null guard.\n\n## Overall Assessment\nRequest updates.';

    const runner = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === 'pr' && args[1] === 'review') {
        return { stdout: 'review submitted', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    _setHostCommandRunnerForTest(runner);

    await processTaskIpc(
      {
        type: 'gh_pr_review',
        requestId: 'req-gh-pr-review',
        repo: 'autorag-research',
        pr_number: 42,
        body: reviewBody,
        review_event: 'comment',
      },
      'other-group',
      false,
      deps,
    );

    expect(runner).toHaveBeenCalledWith(
      'gh',
      ['pr', 'review', '42', '--comment', '--body', reviewBody],
      expect.objectContaining({ cwd: repoPath }),
    );

    const response = readTaskResponse('req-gh-pr-review');
    expect(response.ok).toBe(true);
    expect(response.stdout).toContain('review submitted');
  });
});
