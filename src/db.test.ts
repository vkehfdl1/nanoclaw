import { describe, it, expect, beforeEach } from 'vitest';

import {
  _ensureDefaultAgentRegistrationsForTests,
  _initTestDatabase,
  claimDueTasks,
  createGithubEventRun,
  createGithubWebhookDelivery,
  createTask,
  deleteTask,
  findPmAgentByGithubRepo,
  getAgentsByChannel,
  getAllChats,
  getAllRegisteredGroups,
  getAllUniqueAgents,
  getChannelsForAgent,
  getGithubEventRun,
  getGithubWebhookDelivery,
  getMessagesSince,
  getNewMessages,
  getTaskById,
  setRegisteredGroup,
  storeChatMetadata,
  storeMessage,
  updateGithubEventRun,
  updateGithubWebhookDelivery,
  updateTask,
  updateTaskAfterRun,
} from './db.js';

beforeEach(() => {
  _initTestDatabase();
});

// Helper to store a message using the normalized NewMessage interface
function store(overrides: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
}) {
  storeMessage({
    id: overrides.id,
    chat_jid: overrides.chat_jid,
    sender: overrides.sender,
    sender_name: overrides.sender_name,
    content: overrides.content,
    timestamp: overrides.timestamp,
    is_from_me: overrides.is_from_me ?? false,
  });
}

// --- storeMessage (NewMessage format) ---

describe('storeMessage', () => {
  it('stores a message and retrieves it', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: '123@slack.user',
      sender_name: 'Alice',
      content: 'hello world',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince('group@g.us', '2024-01-01T00:00:00.000Z');
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('msg-1');
    expect(messages[0].sender).toBe('123@slack.user');
    expect(messages[0].sender_name).toBe('Alice');
    expect(messages[0].content).toBe('hello world');
  });

  it('filters out empty content', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-2',
      chat_jid: 'group@g.us',
      sender: '111@slack.user',
      sender_name: 'Dave',
      content: '',
      timestamp: '2024-01-01T00:00:04.000Z',
    });

    const messages = getMessagesSince('group@g.us', '2024-01-01T00:00:00.000Z');
    expect(messages).toHaveLength(0);
  });

  it('stores is_from_me flag', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-3',
      chat_jid: 'group@g.us',
      sender: 'me@slack.user',
      sender_name: 'Me',
      content: 'my message',
      timestamp: '2024-01-01T00:00:05.000Z',
      is_from_me: true,
    });

    const messages = getMessagesSince('group@g.us', '2024-01-01T00:00:00.000Z');
    expect(messages).toHaveLength(1);
  });

  it('upserts on duplicate id+chat_jid', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@slack.user',
      sender_name: 'Alice',
      content: 'original',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@slack.user',
      sender_name: 'Alice',
      content: 'updated',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince('group@g.us', '2024-01-01T00:00:00.000Z');
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('updated');
  });
});

// --- getMessagesSince ---

describe('getMessagesSince', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'm1', chat_jid: 'group@g.us', sender: 'Alice@slack.user',
      sender_name: 'Alice', content: 'first', timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'm2', chat_jid: 'group@g.us', sender: 'Bob@slack.user',
      sender_name: 'Bob', content: 'second', timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'm3', chat_jid: 'group@g.us', sender: 'Bot@slack.user',
      sender_name: 'Bot', content: '*Dobby:* bot reply', timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true, agent_source: 'Dobby',
    });
    store({
      id: 'm4', chat_jid: 'group@g.us', sender: 'Carol@slack.user',
      sender_name: 'Carol', content: 'third', timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns messages after the given timestamp', () => {
    const msgs = getMessagesSince('group@g.us', '2024-01-01T00:00:02.000Z');
    // Should include m3 (bot message now included) and m4
    expect(msgs).toHaveLength(2);
  });

  it('includes bot messages (no longer filtered)', () => {
    const msgs = getMessagesSince('group@g.us', '2024-01-01T00:00:00.000Z');
    const botMsgs = msgs.filter((m) => m.is_bot_message);
    expect(botMsgs).toHaveLength(1);
    expect(botMsgs[0].agent_source).toBe('Dobby');
  });

  it('returns all messages when sinceTimestamp is empty', () => {
    const msgs = getMessagesSince('group@g.us', '');
    // All 4 messages including bot
    expect(msgs).toHaveLength(4);
  });
});

// --- getNewMessages ---

describe('getNewMessages', () => {
  beforeEach(() => {
    storeChatMetadata('group1@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group2@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'a1', chat_jid: 'group1@g.us', sender: 'user@slack.user',
      sender_name: 'User', content: 'g1 msg1', timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'a2', chat_jid: 'group2@g.us', sender: 'user@slack.user',
      sender_name: 'User', content: 'g2 msg1', timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'a3', chat_jid: 'group1@g.us', sender: 'user@slack.user',
      sender_name: 'User', content: '*Bot:* bot reply', timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'a4', chat_jid: 'group1@g.us', sender: 'user@slack.user',
      sender_name: 'User', content: 'g1 msg2', timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns new messages across multiple groups (including bot messages)', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:00.000Z',
    );
    // Includes bot message now (4 total)
    expect(messages).toHaveLength(4);
    expect(newTimestamp).toBe('2024-01-01T00:00:04.000Z');
  });

  it('filters by timestamp', () => {
    const { messages } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:03.000Z',
    );
    // Only g1 msg2 (after ts)
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('g1 msg2');
  });

  it('returns empty for no registered groups', () => {
    const { messages, newTimestamp } = getNewMessages([], '');
    expect(messages).toHaveLength(0);
    expect(newTimestamp).toBe('');
  });

  it('returns bot messages with is_bot_message flag set', () => {
    const { messages } = getNewMessages(
      ['group1@g.us'],
      '2024-01-01T00:00:02.000Z',
    );
    const botMsgs = messages.filter((m) => m.is_bot_message);
    expect(botMsgs).toHaveLength(1);
  });
});

describe('GitHub PM helpers', () => {
  it('finds a PM agent by configured GITHUB_REPO', () => {
    setRegisteredGroup('slack:C123', {
      name: 'PM',
      folder: 'pm-test',
      trigger: '@PM',
      aliases: ['pm'],
      added_at: '2024-01-01T00:00:00.000Z',
      gateway: { rules: [{ match: 'self_mention' }] },
      role: 'pm-agent',
      containerConfig: {
        envVars: {
          GITHUB_REPO: 'Owner/Repo',
          ALLOWED_REPOS: 'repo',
        },
      },
    });

    const group = findPmAgentByGithubRepo('owner/repo');
    expect(group?.jid).toBe('slack:C123');
    expect(group?.folder).toBe('pm-test');
  });

  it('stores and updates GitHub webhook deliveries and event runs', () => {
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
      payload_json: '{"ok":true}',
    });

    updateGithubWebhookDelivery('delivery-1', {
      status: 'queued',
      resource_key: 'github:issue:owner/repo#42',
    });

    const runId = createGithubEventRun({
      delivery_id: 'delivery-1',
      group_folder: 'pm-test',
      resource_type: 'issue',
      resource_key: 'github:issue:owner/repo#42',
      chat_jid: 'slack:C123',
      thread_ts: 'github:issue:owner/repo#42',
      session_mode: 'isolated',
      trigger_kind: 'issue-opened',
      status: 'queued',
      result: null,
      error: null,
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
    });

    updateGithubEventRun(runId, {
      status: 'success',
      result: 'done',
      updated_at: '2024-01-01T00:05:00.000Z',
    });

    expect(getGithubWebhookDelivery('delivery-1')?.status).toBe('queued');
    expect(getGithubWebhookDelivery('delivery-1')?.resource_key).toBe('github:issue:owner/repo#42');
    expect(getGithubEventRun(runId)?.status).toBe('success');
    expect(getGithubEventRun(runId)?.result).toBe('done');
  });
});

// --- storeChatMetadata ---

describe('storeChatMetadata', () => {
  it('stores chat with JID as default name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].jid).toBe('group@g.us');
    expect(chats[0].name).toBe('group@g.us');
  });

  it('stores chat with explicit name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z', 'My Group');
    const chats = getAllChats();
    expect(chats[0].name).toBe('My Group');
  });

  it('updates name on subsequent call with name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z', 'Updated Name');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].name).toBe('Updated Name');
  });

  it('preserves newer timestamp on conflict', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:05.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z');
    const chats = getAllChats();
    expect(chats[0].last_message_time).toBe('2024-01-01T00:00:05.000Z');
  });
});

// --- Registered group lookups ---

describe('registered_groups one-to-one lookups', () => {
  it('moves an agent folder to the newest registered channel JID', () => {
    setRegisteredGroup('slack:C111', {
      name: 'PM Agent',
      folder: 'pm-autorag',
      trigger: '@young-gu',
      aliases: ['young-gu', '영구'],
      added_at: '2024-01-01T00:00:00.000Z',
      requiresTrigger: false,
      gateway: { rules: [{ match: 'any_message' }] },
      role: 'pm-agent',
    });
    setRegisteredGroup('slack:C222', {
      name: 'PM Agent',
      folder: 'pm-autorag',
      trigger: '@young-gu',
      aliases: ['young-gu', '영구'],
      added_at: '2024-01-01T00:00:00.000Z',
      requiresTrigger: false,
      gateway: { rules: [{ match: 'any_message' }] },
      role: 'pm-agent',
    });

    const all = getAllRegisteredGroups();
    expect(all['slack:C222']).toBeDefined();
    expect(all['slack:C222'].folder).toBe('pm-autorag');
    expect(all['slack:C111']).toBeUndefined();
  });

  it('getChannelsForAgent returns the single registered channel JID for a folder', () => {
    setRegisteredGroup('slack:C111', {
      name: 'PM Agent',
      folder: 'pm-autorag',
      trigger: '@young-gu',
      aliases: ['young-gu'],
      added_at: '2024-01-01T00:00:00.000Z',
      gateway: { rules: [{ match: 'self_mention' }] },
    });
    setRegisteredGroup('slack:C222', {
      name: 'PM Agent',
      folder: 'pm-autorag',
      trigger: '@young-gu',
      aliases: ['young-gu'],
      added_at: '2024-01-01T00:00:00.000Z',
      gateway: { rules: [{ match: 'self_mention' }] },
    });

    const channels = getChannelsForAgent('pm-autorag');
    expect(channels).toEqual(['slack:C222']);
  });

  it('replaces an existing channel agent when the channel is re-registered', () => {
    setRegisteredGroup('slack:C111', {
      name: 'PM Agent',
      folder: 'pm-autorag',
      trigger: '@young-gu',
      aliases: ['young-gu'],
      added_at: '2024-01-01T00:00:00.000Z',
      gateway: { rules: [{ match: 'self_mention' }] },
      role: 'pm-agent',
    });
    setRegisteredGroup('slack:C111', {
      name: 'Marketer',
      folder: 'marketer',
      trigger: '@marketer',
      aliases: ['marketer'],
      added_at: '2024-01-01T00:00:01.000Z',
      gateway: { rules: [{ match: 'self_mention' }] },
      role: 'marketer',
    });

    const agents = getAgentsByChannel('slack:C111');
    expect(agents).toHaveLength(1);
    expect(agents[0].folder).toBe('marketer');
    expect(agents[0].role).toBe('marketer');
    expect(getChannelsForAgent('pm-autorag')).toEqual([]);
  });

  it('updates an existing channel registration in place', () => {
    setRegisteredGroup('slack:C111', {
      name: 'PM Agent',
      folder: 'pm-autorag',
      trigger: '@young-gu',
      aliases: ['young-gu'],
      added_at: '2024-01-01T00:00:00.000Z',
      gateway: { rules: [{ match: 'self_mention' }] },
      role: 'pm-agent',
    });
    setRegisteredGroup('slack:C111', {
      name: 'Young-gu',
      folder: 'pm-autorag',
      trigger: '@young-gu',
      aliases: ['young-gu', '영구'],
      added_at: '2024-01-01T00:00:02.000Z',
      gateway: { rules: [{ match: 'any_message' }, { match: 'self_mention' }] },
      role: 'pm-agent',
      requiresTrigger: false,
    });

    const agents = getAgentsByChannel('slack:C111');
    expect(agents).toHaveLength(1);
    expect(agents[0].folder).toBe('pm-autorag');
    expect(agents[0].name).toBe('Young-gu');
    expect(agents[0].requiresTrigger).toBe(false);
  });
});

describe('default agent registrations', () => {
  it('registers pm-autorag with the expected GitHub repo and project mount', () => {
    _ensureDefaultAgentRegistrationsForTests();

    const channels = getChannelsForAgent('pm-autorag');
    expect(channels).toEqual(['slack:C09RELR4R9N']);

    const agentsInChannel = getAgentsByChannel(channels[0]);
    const pm = agentsInChannel.find((g) => g.folder === 'pm-autorag');
    expect(pm).toBeDefined();
    expect(pm!.name).toBe('영구');
    expect(pm!.containerConfig?.envVars?.GITHUB_REPO).toBe('NomaDamas/AutoRAG-Research');
    expect(pm!.containerConfig?.additionalMounts?.[0]?.hostPath).toBe('~/Projects/AutoRAG-Research');
  });

  it('registers 홍명보 in the marketer channel with expected trigger behavior', () => {
    _ensureDefaultAgentRegistrationsForTests();

    const channels = getChannelsForAgent('marketer');
    expect(channels).toHaveLength(1);

    const marketerChannel = channels[0];
    const agentsInChannel = getAgentsByChannel(marketerChannel);

    // 홍명보: no trigger required (responds to all messages)
    const marketer = agentsInChannel.find((g) => g.folder === 'marketer');
    expect(marketer).toBeDefined();
    expect(marketer!.name).toBe('홍명보');
    expect(marketer!.requiresTrigger).toBe(false);
    expect(marketer!.role).toBe('marketer');
    expect(marketer!.containerConfig?.additionalMounts).toEqual([
      {
        hostPath: '~/.nanoclaw/auth',
        containerPath: 'auth',
        readonly: true,
      },
      {
        hostPath: '~/.nanoclaw/auth-profiles',
        containerPath: 'auth-profiles',
        readonly: false,
      },
    ]);

    // 도비 is no longer auto-registered in the marketer channel.
    const dobby = agentsInChannel.find((g) => g.folder === 'main');
    expect(dobby).toBeUndefined();
  });

  it('stores and retrieves aliases and gateway fields', () => {
    _ensureDefaultAgentRegistrationsForTests();

    const channels = getChannelsForAgent('marketer');
    const agentsInChannel = getAgentsByChannel(channels[0]);

    const marketer = agentsInChannel.find((g) => g.folder === 'marketer');
    expect(marketer).toBeDefined();
    expect(marketer!.aliases).toEqual(['marketer', '홍명보', '명보']);
    expect(marketer!.gateway).toEqual({
      rules: [
        { channel: [channels[0]], match: 'any_message' },
        { match: 'self_mention' },
      ],
    });

    const dobby = agentsInChannel.find((g) => g.folder === 'main');
    expect(dobby).toBeUndefined();
  });
});

describe('aliases/gateway round-trip', () => {
  it('stores and retrieves aliases and gateway via setRegisteredGroup/getAllRegisteredGroups', () => {
    setRegisteredGroup('slack:C_TEST', {
      name: 'Test Agent',
      folder: 'test-agent',
      trigger: '@test',
      aliases: ['test', '테스트'],
      added_at: '2024-01-01T00:00:00.000Z',
      gateway: {
        rules: [
          { channel: ['slack:C_TEST'], match: 'any_message' },
          { match: 'self_mention' },
        ],
      },
    });

    const all = getAllRegisteredGroups();
    const agent = all['slack:C_TEST'];
    expect(agent).toBeDefined();
    expect(agent.aliases).toEqual(['test', '테스트']);
    expect(agent.gateway.rules).toHaveLength(2);
    expect(agent.gateway.rules[0]).toEqual({ channel: ['slack:C_TEST'], match: 'any_message' });
    expect(agent.gateway.rules[1]).toEqual({ match: 'self_mention' });
  });

  it('falls back to trigger-derived aliases when aliases column is null', () => {
    setRegisteredGroup('slack:C_FALLBACK', {
      name: 'Fallback Agent',
      folder: 'fallback',
      trigger: '@fallback-agent',
      aliases: [],
      added_at: '2024-01-01T00:00:00.000Z',
      gateway: { rules: [] },
    });

    const all = getAllRegisteredGroups();
    const agent = all['slack:C_FALLBACK'];
    expect(agent).toBeDefined();
    // Should derive from trigger since aliases was empty
    expect(agent.aliases).toEqual(['fallback-agent']);
  });
});

// --- getAllUniqueAgents ---

describe('getAllUniqueAgents', () => {
  it('returns unique agents deduplicated by folder', () => {
    setRegisteredGroup('slack:C111', {
      name: 'PM Agent',
      folder: 'pm-autorag',
      trigger: '@young-gu',
      aliases: ['young-gu', '영구'],
      added_at: '2024-01-01T00:00:00.000Z',
      gateway: { rules: [{ match: 'self_mention' }] },
    });
    setRegisteredGroup('slack:C222', {
      name: 'PM Agent',
      folder: 'pm-autorag',
      trigger: '@young-gu',
      aliases: ['young-gu', '영구'],
      added_at: '2024-01-01T00:00:00.000Z',
      gateway: { rules: [{ match: 'self_mention' }] },
    });
    setRegisteredGroup('slack:C333', {
      name: 'Marketer',
      folder: 'marketer',
      trigger: '@marketer',
      aliases: ['marketer'],
      added_at: '2024-01-01T00:00:01.000Z',
      gateway: { rules: [{ match: 'self_mention' }] },
    });

    const agents = getAllUniqueAgents();
    expect(agents).toHaveLength(2);
    expect(agents.map((a) => a.folder).sort()).toEqual(['marketer', 'pm-autorag']);
  });
});

// --- Task CRUD ---

describe('task CRUD', () => {
  it('creates and retrieves a task', () => {
    createTask({
      id: 'task-1',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'do something',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2024-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const task = getTaskById('task-1');
    expect(task).toBeDefined();
    expect(task!.prompt).toBe('do something');
    expect(task!.status).toBe('active');
  });

  it('updates task status', () => {
    createTask({
      id: 'task-2',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    updateTask('task-2', { status: 'paused' });
    expect(getTaskById('task-2')!.status).toBe('paused');
  });

  it('claims due tasks only once by marking them running', () => {
    createTask({
      id: 'task-claim-1',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'claim me',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const firstClaim = claimDueTasks();
    expect(firstClaim.map((task) => task.id)).toEqual(['task-claim-1']);
    expect(getTaskById('task-claim-1')!.status).toBe('running');

    const secondClaim = claimDueTasks();
    expect(secondClaim).toEqual([]);
  });

  it('restores recurring running tasks back to active after completion', () => {
    createTask({
      id: 'task-claim-2',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'finish me',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    claimDueTasks();
    updateTaskAfterRun('task-claim-2', '2024-06-02T00:00:00.000Z', 'done');

    const task = getTaskById('task-claim-2');
    expect(task?.status).toBe('active');
    expect(task?.next_run).toBe('2024-06-02T00:00:00.000Z');
  });

  it('deletes a task and its run logs', () => {
    createTask({
      id: 'task-3',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'delete me',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    deleteTask('task-3');
    expect(getTaskById('task-3')).toBeUndefined();
  });
});
