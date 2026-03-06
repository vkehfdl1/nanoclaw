import fs from 'fs';
import { Server } from 'http';
import path from 'path';

import {
  ASSISTANT_NAME,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  SLACK_APP_TOKEN,
  SLACK_BOT_TOKEN,
} from './config.js';
import { evaluateGateway, matchesAlias } from './gateway.js';
import { SlackChannel } from './channels/slack.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import { cleanupOrphans, ensureContainerRuntimeRunning } from './container-runtime.js';
import {
  cleanupOldSessions,
  getAgentsByChannel,
  getAgentCursor,
  getAllChats,
  getAllRegisteredGroups,
  getAllTasks,
  getAllUniqueAgents,
  getMessageById,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  getSession,
  getThreadMessages,
  initDatabase,
  deleteSession,
  setAgentCursor,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { bootstrapAllAgentSchedules } from './agent-schedule-bootstrap.js';
import { startIpcWatcher } from './ipc.js';
import { prependChannelMembersToPrompt } from './channel-members.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import { startGithubWebhookServer, stopGithubWebhookServer } from './github-webhooks.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let registeredGroups: Record<string, RegisteredGroup> = {};
let messageLoopRunning = false;

let slack: SlackChannel | undefined;
let githubWebhookServer: Server | null = null;
const channels: Channel[] = [];
const queue = new GroupQueue();
const recentIpcDeliveries = new Map<string, number>();

function makeDeliveryKey(groupFolder: string, chatJid: string, threadTs?: string): string {
  return `${groupFolder}::${chatJid}::${threadTs ?? '__channel__'}`;
}

function noteIpcDelivery(groupFolder: string, chatJid: string, threadTs?: string): void {
  recentIpcDeliveries.set(makeDeliveryKey(groupFolder, chatJid, threadTs), Date.now());
}

function hadIpcDeliverySince(
  groupFolder: string,
  chatJid: string,
  threadTs: string | undefined,
  sinceMs: number,
): boolean {
  const deliveredAt = recentIpcDeliveries.get(makeDeliveryKey(groupFolder, chatJid, threadTs));
  return deliveredAt !== undefined && deliveredAt >= sinceMs;
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveLastTimestamp(): void {
  setRouterState('last_timestamp', lastTimestamp);
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(groups: Record<string, RegisteredGroup>): void {
  registeredGroups = groups;
}

function isClearCommand(content: string, group: RegisteredGroup): boolean {
  const trimmed = content.trim();
  if (/^\/clear(?:\s+.*)?$/i.test(trimmed)) return true;

  // Check for "alias /clear" pattern
  const aliases = group.aliases ?? [];
  for (const alias of aliases) {
    const lower = trimmed.toLowerCase();
    const aliasLower = alias.toLowerCase();
    if (lower.startsWith(aliasLower)) {
      const rest = trimmed.slice(alias.length).trim();
      if (/^\/clear(?:\s+.*)?$/i.test(rest)) return true;
    }
  }
  return false;
}

function findRegisteredAgent(
  chatJid: string,
  agentFolder: string,
): RegisteredGroup | undefined {
  const channelAgents = getAgentsByChannel(chatJid);
  const exact = channelAgents.find((g) => g.folder === agentFolder);
  if (exact) return exact;

  const direct = registeredGroups[chatJid];
  if (direct && direct.folder === agentFolder) return direct;

  return Object.values(registeredGroups).find((g) => g.folder === agentFolder);
}

function isAssignedChannel(agentFolder: string, chatJid: string): boolean {
  return getAgentsByChannel(chatJid).some((g) => g.folder === agentFolder);
}

function getAgentRoutes(): Array<{ chatJid: string; group: RegisteredGroup }> {
  const routes: Array<{ chatJid: string; group: RegisteredGroup }> = [];
  const seen = new Set<string>();

  for (const chatJid of Object.keys(registeredGroups)) {
    const fromDb = getAgentsByChannel(chatJid);
    const agents = fromDb.length > 0 ? fromDb : [registeredGroups[chatJid]];
    const sorted = [...agents].sort((a, b) => {
      if (a.added_at !== b.added_at) return a.added_at.localeCompare(b.added_at);
      if (a.folder !== b.folder) return a.folder.localeCompare(b.folder);
      return a.name.localeCompare(b.name);
    });
    for (const group of sorted) {
      if (!group) continue;
      const key = `${chatJid}::${group.folder}`;
      if (seen.has(key)) continue;
      seen.add(key);
      routes.push({ chatJid, group });
    }
  }

  return routes;
}

/**
 * Clear sessions for an agent. If threadTs is provided, only clear that thread.
 * Channel-level /clear wipes all sessions for the agent in that channel.
 */
function clearGroupSession(chatJid: string, groupFolder: string, threadTs?: string): void {
  if (threadTs) {
    deleteSession(groupFolder, chatJid, threadTs);
  } else {
    // Channel-level clear: delete all sessions for this agent in this channel
    deleteSession(groupFolder, chatJid);
  }
  // If a container is active, ask it to close so it doesn't continue on stale context.
  queue.closeStdin(groupFolder);
  logger.info({ chatJid, groupFolder, threadTs }, 'Session cleared');
}

/**
 * Helper to send a message, optionally in a thread.
 */
async function sendToChannel(
  channel: Channel,
  chatJid: string,
  text: string,
  agentLabel: string,
  threadTs?: string,
): Promise<void> {
  await channel.sendMessage(chatJid, text, { agentLabel, threadTs });
}

/**
 * Determine if a message is channel-level (starts its own thread) vs a thread reply.
 */
function isChannelLevelMessage(msg: NewMessage): boolean {
  return !msg.thread_ts || msg.thread_ts === msg.id;
}

function mergeConversationContext(
  channelMessages: NewMessage[],
  threadMessages: NewMessage[],
): NewMessage[] {
  const merged = new Map<string, NewMessage>();
  for (const msg of [...channelMessages, ...threadMessages]) {
    merged.set(`${msg.chat_jid}::${msg.id}`, msg);
  }
  return [...merged.values()].sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp.localeCompare(b.timestamp);
    return a.id.localeCompare(b.id);
  });
}

function isReplyToAgentOwnedThread(
  chatJid: string,
  threadTs: string,
  group: RegisteredGroup,
): boolean {
  if (threadTs === '__channel__') return false;
  const root = getMessageById(chatJid, threadTs);
  if (!root?.is_bot_message) return false;
  return (root.agent_source ?? '').trim().toLowerCase() === group.name.trim().toLowerCase();
}

export function _mergeConversationContextForTests(
  channelMessages: NewMessage[],
  threadMessages: NewMessage[],
): NewMessage[] {
  return mergeConversationContext(channelMessages, threadMessages);
}

export function _isReplyToAgentOwnedThreadForTests(
  chatJid: string,
  threadTs: string,
  group: RegisteredGroup,
): boolean {
  return isReplyToAgentOwnedThread(chatJid, threadTs, group);
}

export function _hadIpcDeliverySinceForTests(
  groupFolder: string,
  chatJid: string,
  threadTs: string | undefined,
  sinceMs: number,
): boolean {
  return hadIpcDeliverySince(groupFolder, chatJid, threadTs, sinceMs);
}

export function _noteIpcDeliveryForTests(
  groupFolder: string,
  chatJid: string,
  threadTs?: string,
): void {
  noteIpcDelivery(groupFolder, chatJid, threadTs);
}

/**
 * Process messages for a specific conversation (thread or channel-level batch).
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(
  chatJid: string,
  agentFolder: string,
  threadTs: string,
): Promise<boolean> {
  const group = findRegisteredAgent(chatJid, agentFolder);
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    console.log(`Warning: no channel owns JID ${chatJid}, skipping messages`);
    return true;
  }

  const assigned = isAssignedChannel(agentFolder, chatJid);

  // Build context based on assigned vs cross-channel
  let contextMessages: NewMessage[];
  if (assigned) {
    // Assigned channel: unified context — all messages (channel + threads) since cursor
    const sinceTimestamp = getAgentCursor(agentFolder, chatJid);
    const channelMessages = getMessagesSince(chatJid, sinceTimestamp);
    if (threadTs !== '__channel__') {
      const threadMessages = getThreadMessages(chatJid, threadTs);
      contextMessages = mergeConversationContext(channelMessages, threadMessages);
    } else {
      contextMessages = channelMessages;
    }
  } else {
    // Cross-channel: thread context only
    contextMessages = getThreadMessages(chatJid, threadTs);
  }

  if (contextMessages.length === 0) return true;

  // Check for /clear command
  const latestClear = [...contextMessages]
    .reverse()
    .find((m) => isClearCommand(m.content, group));
  if (latestClear) {
    if (assigned) {
      clearGroupSession(chatJid, group.folder); // clear unified session
      setAgentCursor(agentFolder, chatJid, latestClear.timestamp);
    } else {
      clearGroupSession(chatJid, group.folder, threadTs);
    }
    const clearReplyTs = threadTs === '__channel__' ? undefined : threadTs;
    await sendToChannel(
      channel,
      chatJid,
      'Session cleared. I will continue in a fresh session from your next message.',
      group.name,
      clearReplyTs,
    );
    return true;
  }

  // Gateway evaluation: cross-channel agents must pass gateway checks.
  // Assigned channel agents skip — gateway was already checked in the message loop.
  if (!assigned) {
    const hasMatch = contextMessages.some((m) => evaluateGateway(m, group, chatJid));
    if (!hasMatch) return true;
  }

  const prompt = await prependChannelMembersToPrompt(
    chatJid,
    formatMessages(contextMessages),
    SLACK_BOT_TOKEN,
  );

  // For channel-level conversations, the reply goes to a thread under the first channel-level message
  // For thread conversations, the reply goes to the same thread
  const replyThreadTs = threadTs === '__channel__'
    ? (contextMessages.find((m) => isChannelLevelMessage(m))?.id ?? contextMessages[0]?.id)
    : threadTs;

  // Advance cursor for assigned channels (unified session tracks all messages)
  const previousCursor = getAgentCursor(agentFolder, chatJid);
  if (assigned) {
    setAgentCursor(
      agentFolder,
      chatJid,
      contextMessages[contextMessages.length - 1].timestamp,
    );
  }

  logger.info(
    { group: group.name, threadTs, messageCount: contextMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const runStartedAt = Date.now();

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug({ group: group.name }, 'Idle timeout, closing container stdin');
      queue.closeStdin(group.folder);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(group, prompt, chatJid, replyThreadTs, async (result) => {
    if (result.result) {
      const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
      const text = formatOutbound(raw);
      const ipcDelivered = hadIpcDeliverySince(group.folder, chatJid, replyThreadTs, runStartedAt);
      logger.info(
        {
          group: group.name,
          removedInternal: text !== raw.trim(),
          preview: text.slice(0, 200),
          userVisibleDelivery: ipcDelivered ? 'ipc' : 'logs_only',
        },
        'Agent output processed',
      );
      if (text) {
        if (ipcDelivered) {
          outputSentToUser = true;
          logger.info(
            { group: group.name, chatJid, threadTs: replyThreadTs },
            'Retaining final output for logs because IPC message was already delivered',
          );
        } else {
          logger.info(
            { group: group.name, chatJid, threadTs: replyThreadTs },
            'Retaining final output for logs only; no automatic Slack delivery',
          );
        }
      }
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(group.folder);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    if (outputSentToUser) {
      logger.warn({ group: group.name }, 'Agent error after output was sent, skipping cursor rollback to prevent duplicates');
      return true;
    }
    if (assigned) {
      setAgentCursor(agentFolder, chatJid, previousCursor);
    }
    logger.warn({ group: group.name }, 'Agent error, rolled back message cursor for retry');
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  threadTs: string | undefined,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  // Assigned channels use a unified session key; cross-channel uses per-thread key
  const assigned = isAssignedChannel(group.folder, chatJid);
  const sessionThreadKey = assigned ? '__channel__' : (threadTs ?? '__channel__');
  const sessionId = getSession(group.folder, chatJid, sessionThreadKey);

  const shouldAcceptSessionUpdate = (): boolean => {
    // If a clear happened while this run was active, keep the session cleared.
    const current = getSession(group.folder, chatJid, sessionThreadKey);
    if (sessionId && !current) {
      return false;
    }
    return true;
  };

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (
          output.newSessionId &&
          output.status !== 'error' &&
          shouldAcceptSessionUpdate()
        ) {
          setSession(group.folder, chatJid, sessionThreadKey, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        threadTs,
        isMain,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) =>
        queue.registerProcess(group.folder, proc, containerName, group.folder, chatJid, threadTs),
      wrappedOnOutput,
    );

    if (
      output.newSessionId &&
      output.status !== 'error' &&
      shouldAcceptSessionUpdate()
    ) {
      setSession(group.folder, chatJid, sessionThreadKey, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

/**
 * Group messages into conversations by thread.
 * Channel-level messages (thread_ts === id) within the same chatJid are batched
 * together under the first message's ts as the thread anchor.
 * Thread replies are grouped by their thread_ts.
 */
function groupByConversation(
  messages: NewMessage[],
): Map<string, { chatJid: string; threadTs: string; messages: NewMessage[] }> {
  const conversations = new Map<string, { chatJid: string; threadTs: string; messages: NewMessage[] }>();
  // Collect channel-level messages per chatJid for batching
  const channelBatches = new Map<string, NewMessage[]>();

  for (const msg of messages) {
    if (isChannelLevelMessage(msg)) {
      const batch = channelBatches.get(msg.chat_jid) || [];
      batch.push(msg);
      channelBatches.set(msg.chat_jid, batch);
    } else {
      // Thread reply — group by thread_ts
      const key = `${msg.chat_jid}::${msg.thread_ts}`;
      const existing = conversations.get(key);
      if (existing) {
        existing.messages.push(msg);
      } else {
        conversations.set(key, {
          chatJid: msg.chat_jid,
          threadTs: msg.thread_ts!,
          messages: [msg],
        });
      }
    }
  }

  // Batch channel-level messages: all channel-level msgs in same chatJid become one conversation
  // anchored at '__channel__' (context will be built from DB using cursor)
  for (const [chatJid, batch] of channelBatches) {
    const key = `${chatJid}::__channel__`;
    const existing = conversations.get(key);
    if (existing) {
      existing.messages.push(...batch);
    } else {
      conversations.set(key, {
        chatJid,
        threadTs: '__channel__',
        messages: batch,
      });
    }
  }

  return conversations;
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const routes = getAgentRoutes();
      const jids = [...new Set(routes.map((route) => route.chatJid))];
      const { messages, newTimestamp } = getNewMessages(jids, lastTimestamp);

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveLastTimestamp();

        // Group messages by conversation (thread or channel-level batch)
        const conversations = groupByConversation(messages);

        for (const [, convo] of conversations) {
          const { chatJid, threadTs, messages: convoMessages } = convo;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            console.log(`Warning: no channel owns JID ${chatJid}, skipping messages`);
            continue;
          }

          const routesForChannel = routes.filter((route) => route.chatJid === chatJid);
          const registeredFolders = new Set(routesForChannel.map((r) => r.group.folder));

          for (const route of routesForChannel) {
            const group = route.group;
            const agentFolder = group.folder;
            const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

            const agentAssigned = isAssignedChannel(agentFolder, chatJid);

            // Quick clear check on the batch
            const latestClear = [...convoMessages]
              .reverse()
              .find((m) => isClearCommand(m.content, group));
            if (latestClear) {
              if (agentAssigned) {
                clearGroupSession(chatJid, group.folder); // clear unified session
                setAgentCursor(agentFolder, chatJid, latestClear.timestamp);
              } else {
                const clearThreadTs = threadTs === '__channel__' ? undefined : threadTs;
                clearGroupSession(chatJid, group.folder, clearThreadTs);
              }
              const clearReplyTs = threadTs === '__channel__' ? undefined : threadTs;
              await sendToChannel(
                channel,
                chatJid,
                'Session cleared. I will continue in a fresh session from your next message.',
                group.name,
                clearReplyTs,
              );
              continue;
            }

            // Gateway evaluation: same logic as processGroupMessages —
            // main skips only for channel-level in its own channel.
            if (threadTs !== '__channel__' || !isMainGroup) {
              const hasMatch = convoMessages.some((m) =>
                evaluateGateway(m, group, chatJid),
              );
              const ownsThread = agentAssigned && isReplyToAgentOwnedThread(chatJid, threadTs, group);
              if (!hasMatch && !ownsThread) continue;
            }

            if (agentAssigned) {
              // Assigned channel: unified session, always enqueue (no pipe attempt)
              queue.enqueueMessageCheck(chatJid, agentFolder, threadTs, true);
            } else if (threadTs === '__channel__') {
              // Cross-channel, channel-level: always enqueue
              queue.enqueueMessageCheck(chatJid, agentFolder, threadTs);
            } else {
              // Cross-channel, thread: try to pipe to active container for this thread
              const threadMessages = getThreadMessages(chatJid, threadTs);
              const formatted = await prependChannelMembersToPrompt(
                chatJid,
                formatMessages(threadMessages),
                SLACK_BOT_TOKEN,
              );

              if (queue.sendMessage(agentFolder, chatJid, threadTs, formatted)) {
                logger.debug(
                  { chatJid, agentFolder, threadTs, count: threadMessages.length },
                  'Piped thread messages to active container',
                );
                channel.setTyping?.(chatJid, true)?.catch((err) =>
                  logger.warn({ chatJid, agentFolder, err }, 'Failed to set typing indicator'),
                );
              } else {
                queue.enqueueMessageCheck(chatJid, agentFolder, threadTs);
              }
            }
          }

          // Ad-hoc alias mention: agents NOT registered in this channel but
          // mentioned by alias in any of the new messages get enqueued too.
          // Foreign agents always get the thread context.
          const allAgents = getAllUniqueAgents();
          for (const agent of allAgents) {
            if (registeredFolders.has(agent.folder)) continue;
            const hasMention = convoMessages.some((m) =>
              matchesAlias(m.content, agent.aliases),
            );
            if (!hasMention) continue;
            // Foreign mention: use the thread context
            // For channel-level mentions, use the first message's id as thread anchor
            const mentionThreadTs = threadTs === '__channel__'
              ? convoMessages[0]?.id ?? threadTs
              : threadTs;
            queue.enqueueMessageCheck(chatJid, agent.folder, mentionThreadTs);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  const routes = getAgentRoutes();
  for (const { chatJid, group } of routes) {
    const sinceTimestamp = getAgentCursor(group.folder, chatJid);
    const pending = getMessagesSince(chatJid, sinceTimestamp);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, chatJid, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      // Group pending messages by conversation for proper thread routing
      const conversations = groupByConversation(pending);
      for (const [, convo] of conversations) {
        queue.enqueueMessageCheck(convo.chatJid, group.folder, convo.threadTs, true);
      }
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Clean up stale sessions (older than 7 days)
  const cleaned = cleanupOldSessions(7);
  if (cleaned > 0) {
    logger.info({ cleaned }, 'Cleaned up stale sessions');
  }

  // Bootstrap scheduled tasks from agent schedule.json configs (idempotent)
  bootstrapAllAgentSchedules(registeredGroups);

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    await stopGithubWebhookServer(githubWebhookServer);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (_chatJid: string, msg: NewMessage) => storeMessage(msg),
    onChatMetadata: (chatJid: string, timestamp: string, name?: string, channel?: string, isGroup?: boolean) =>
      storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  if (!SLACK_BOT_TOKEN || !SLACK_APP_TOKEN) {
    throw new Error(
      'Slack configuration is required. Set SLACK_BOT_TOKEN and SLACK_APP_TOKEN.',
    );
  }

  // Create and connect channel (Slack only)
  slack = new SlackChannel({
    ...channelOpts,
    botToken: SLACK_BOT_TOKEN,
    appToken: SLACK_APP_TOKEN,
  });
  channels.push(slack);
  await slack.connect();
  logger.info('Slack channel connected');

  githubWebhookServer = startGithubWebhookServer({
    registeredGroups: () => registeredGroups,
    queue,
    onProcess: (groupKey, proc, containerName, groupFolder) =>
      queue.registerProcess(groupKey, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText, options) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        console.log(`Warning: no channel owns JID ${jid}, cannot send message`);
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text, options);
    },
  });

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    queue,
    onProcess: (groupKey, proc, containerName, groupFolder) =>
      queue.registerProcess(groupKey, proc, containerName, groupFolder),
  });
  startIpcWatcher({
    sendMessage: (jid, text, options) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      const outbound = formatOutbound(text);
      if (!outbound) return Promise.resolve();
      return channel.sendMessage(jid, outbound, options);
    },
    onMessageSent: (sourceGroup, jid, threadTs) => {
      noteIpcDelivery(sourceGroup, jid, threadTs);
    },
    sendFile: (jid, filePath, comment) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (!channel.sendFile) throw new Error(`Channel ${channel.name} does not support file upload`);
      return channel.sendFile(jid, filePath, comment);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroupMetadata: (force) => {
      if (slack) return slack.syncChannels();
      return Promise.resolve();
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag) => writeGroupsSnapshot(gf, im, ag),
    clearSession: (jid, groupFolder) => clearGroupSession(jid, groupFolder),
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
