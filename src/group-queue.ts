import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, MAX_CONCURRENT_CONTAINERS } from './config.js';
import { logger } from './logger.js';

interface QueuedTask {
  id: string;
  groupKey: string;
  fn: () => Promise<void>;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

interface PendingConversation {
  chatJid: string;
  threadTs: string;
  replyAnchorTs?: string;
}

interface EnqueueMessageOptions {
  isAssigned?: boolean;
  replyAnchorTs?: string;
}

interface GroupState {
  active: boolean;
  idleWaiting: boolean;
  isTaskContainer: boolean;
  pendingConversations: PendingConversation[];
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  containerName: string | null;
  groupFolder: string | null;
  activeChatJid: string | null;
  activeThreadTs: string | null;
  retryCount: number;
}

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private waitingGroups: string[] = [];
  private processMessagesFn: ((
    chatJid: string,
    groupKey: string,
    threadTs: string,
    replyAnchorTs?: string,
  ) => Promise<boolean>) | null = null;
  private shuttingDown = false;

  private getGroup(groupKey: string): GroupState {
    let state = this.groups.get(groupKey);
    if (!state) {
      state = {
        active: false,
        idleWaiting: false,
        isTaskContainer: false,
        pendingConversations: [],
        pendingTasks: [],
        process: null,
        containerName: null,
        groupFolder: null,
        activeChatJid: null,
        activeThreadTs: null,
        retryCount: 0,
      };
      this.groups.set(groupKey, state);
    }
    return state;
  }

  setProcessMessagesFn(
    fn: (
      chatJid: string,
      groupKey: string,
      threadTs: string,
      replyAnchorTs?: string,
    ) => Promise<boolean>,
  ): void {
    this.processMessagesFn = fn;
  }

  enqueueMessageCheck(
    chatJid: string,
    groupKey: string,
    threadTs: string,
    isAssignedOrOptions?: boolean | EnqueueMessageOptions,
  ): void {
    if (this.shuttingDown) return;

    const options = typeof isAssignedOrOptions === 'boolean'
      ? { isAssigned: isAssignedOrOptions }
      : (isAssignedOrOptions ?? {});
    const state = this.getGroup(groupKey);
    const existing = state.pendingConversations.find(
      (c) => c.chatJid === chatJid && c.threadTs === threadTs,
    );
    if (!existing) {
      state.pendingConversations.push({
        chatJid,
        threadTs,
        replyAnchorTs: options.replyAnchorTs,
      });
    } else if (!existing.replyAnchorTs && options.replyAnchorTs) {
      existing.replyAnchorTs = options.replyAnchorTs;
    }

    if (state.active) {
      // If the container is idle and the new conversation is for a different
      // channel/thread, preempt so the queued conversation starts sooner.
      // For assigned channels, same chatJid = same unified session, no preemption needed.
      if (state.idleWaiting) {
        const sameConversation = options.isAssigned
          ? state.activeChatJid === chatJid
          : state.activeChatJid === chatJid && state.activeThreadTs === threadTs;
        if (!sameConversation) {
          this.closeStdin(groupKey);
        }
      }
      logger.debug({ groupKey, chatJid, threadTs }, 'Container active, conversation queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      if (!this.waitingGroups.includes(groupKey)) {
        this.waitingGroups.push(groupKey);
      }
      logger.debug(
        { groupKey, chatJid, threadTs, activeCount: this.activeCount },
        'At concurrency limit, conversation queued',
      );
      return;
    }

    this.runForGroup(groupKey, 'messages').catch((err) =>
      logger.error({ groupKey, err }, 'Unhandled error in runForGroup'),
    );
  }

  enqueueTask(groupKey: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupKey);

    // Prevent double-queuing of the same task
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ groupKey, taskId }, 'Task already queued, skipping');
      return;
    }

    if (state.active) {
      state.pendingTasks.push({ id: taskId, groupKey, fn });
      if (state.idleWaiting) {
        this.closeStdin(groupKey);
      }
      logger.debug({ groupKey, taskId }, 'Container active, task queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingTasks.push({ id: taskId, groupKey, fn });
      if (!this.waitingGroups.includes(groupKey)) {
        this.waitingGroups.push(groupKey);
      }
      logger.debug(
        { groupKey, taskId, activeCount: this.activeCount },
        'At concurrency limit, task queued',
      );
      return;
    }

    // Run immediately
    this.runTask(groupKey, { id: taskId, groupKey, fn }).catch((err) =>
      logger.error({ groupKey, taskId, err }, 'Unhandled error in runTask'),
    );
  }

  registerProcess(
    groupKey: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder?: string,
    activeChatJid?: string,
    activeThreadTs?: string,
  ): void {
    const state = this.getGroup(groupKey);
    state.process = proc;
    state.containerName = containerName;
    if (groupFolder) state.groupFolder = groupFolder;
    else if (!state.groupFolder) state.groupFolder = groupKey;
    if (activeChatJid) state.activeChatJid = activeChatJid;
    if (activeThreadTs) state.activeThreadTs = activeThreadTs;
  }

  /**
   * Mark the container as idle-waiting (finished work, waiting for IPC input).
   * If tasks are pending, preempt the idle container immediately.
   */
  notifyIdle(groupKey: string): void {
    const state = this.getGroup(groupKey);
    state.idleWaiting = true;
    if (state.pendingTasks.length > 0) {
      this.closeStdin(groupKey);
    }
  }

  /**
   * Send a follow-up message to the active container via IPC file.
   * Returns true if the message was written, false if no active container.
   * Only pipes to the same (chatJid, threadTs) conversation.
   */
  sendMessage(groupKey: string, chatJid: string, threadTs: string, text: string): boolean {
    const state = this.getGroup(groupKey);
    if (!state.active || !state.groupFolder || state.isTaskContainer) return false;
    if (state.activeChatJid && state.activeChatJid !== chatJid) return false;
    if (state.activeThreadTs && state.activeThreadTs !== threadTs) return false;
    state.idleWaiting = false; // Agent is about to receive work, no longer idle

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify({ type: 'message', text }));
      fs.renameSync(tempPath, filepath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Signal the active container to wind down by writing a close sentinel.
   */
  closeStdin(groupKey: string): void {
    const state = this.getGroup(groupKey);
    if (!state.active || !state.groupFolder) return;

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  }

  private async runForGroup(
    groupKey: string,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const state = this.getGroup(groupKey);
    const conversation = state.pendingConversations.shift();
    if (!conversation) {
      this.drainWaiting();
      return;
    }
    const { chatJid, threadTs, replyAnchorTs } = conversation;
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = false;
    state.activeChatJid = chatJid;
    state.activeThreadTs = threadTs;
    this.activeCount++;

    logger.debug(
      { groupKey, chatJid, threadTs, reason, activeCount: this.activeCount },
      'Starting container for group',
    );

    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(chatJid, groupKey, threadTs, replyAnchorTs);
        if (success) {
          state.retryCount = 0;
        } else {
          this.scheduleRetry(groupKey, state, chatJid, threadTs, replyAnchorTs);
        }
      }
    } catch (err) {
      logger.error({ groupKey, chatJid, threadTs, err }, 'Error processing messages for group');
      this.scheduleRetry(groupKey, state, chatJid, threadTs, replyAnchorTs);
    } finally {
      state.active = false;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      state.activeChatJid = null;
      state.activeThreadTs = null;
      this.activeCount--;
      this.drainGroup(groupKey);
    }
  }

  private async runTask(groupKey: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(groupKey);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = true;
    state.activeChatJid = null;
    this.activeCount++;

    logger.debug(
      { groupKey, taskId: task.id, activeCount: this.activeCount },
      'Running queued task',
    );

    try {
      await task.fn();
    } catch (err) {
      logger.error({ groupKey, taskId: task.id, err }, 'Error running task');
    } finally {
      state.active = false;
      state.isTaskContainer = false;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      state.activeChatJid = null;
      this.activeCount--;
      this.drainGroup(groupKey);
    }
  }

  private scheduleRetry(
    groupKey: string,
    state: GroupState,
    chatJid: string,
    threadTs: string,
    replyAnchorTs?: string,
  ): void {
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      logger.error(
        { groupKey, chatJid, threadTs, retryCount: state.retryCount },
        'Max retries exceeded, dropping messages (will retry on next incoming message)',
      );
      state.retryCount = 0;
      return;
    }

    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    logger.info(
      { groupKey, chatJid, threadTs, retryCount: state.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    setTimeout(() => {
      if (!this.shuttingDown) {
        this.enqueueMessageCheck(chatJid, groupKey, threadTs, { replyAnchorTs });
      }
    }, delayMs);
  }

  private drainGroup(groupKey: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupKey);

    // Tasks first (they won't be re-discovered from SQLite like messages)
    if (state.pendingTasks.length > 0) {
      const task = state.pendingTasks.shift()!;
      this.runTask(groupKey, task).catch((err) =>
        logger.error({ groupKey, taskId: task.id, err }, 'Unhandled error in runTask (drain)'),
      );
      return;
    }

    // Then pending conversations
    if (state.pendingConversations.length > 0) {
      this.runForGroup(groupKey, 'drain').catch((err) =>
        logger.error({ groupKey, err }, 'Unhandled error in runForGroup (drain)'),
      );
      return;
    }

    // Nothing pending for this group; check if other groups are waiting for a slot
    this.drainWaiting();
  }

  private drainWaiting(): void {
    while (
      this.waitingGroups.length > 0 &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS
    ) {
      const nextGroupKey = this.waitingGroups.shift()!;
      const state = this.getGroup(nextGroupKey);

      // Prioritize tasks over conversations
      if (state.pendingTasks.length > 0) {
        const task = state.pendingTasks.shift()!;
        this.runTask(nextGroupKey, task).catch((err) =>
          logger.error({ groupKey: nextGroupKey, taskId: task.id, err }, 'Unhandled error in runTask (waiting)'),
        );
      } else if (state.pendingConversations.length > 0) {
        this.runForGroup(nextGroupKey, 'drain').catch((err) =>
          logger.error({ groupKey: nextGroupKey, err }, 'Unhandled error in runForGroup (waiting)'),
        );
      }
      // If neither pending, skip this group
    }
  }

  async shutdown(_gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    // Count active containers but don't kill them — they'll finish on their own
    // via idle timeout or container timeout. The --rm flag cleans them up on exit.
    // This prevents service restarts from killing working agents.
    const activeContainers: string[] = [];
    for (const [, state] of this.groups) {
      if (state.process && !state.process.killed && state.containerName) {
        activeContainers.push(state.containerName);
      }
    }

    logger.info(
      { activeCount: this.activeCount, detachedContainers: activeContainers },
      'GroupQueue shutting down (containers detached, not killed)',
    );
  }
}
