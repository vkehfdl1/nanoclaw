import { ChildProcess } from 'child_process';

import { MAIN_GROUP_FOLDER } from './config.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  createGithubEventRun,
  getAgentsByChannel,
  getAllTasks,
  getSession,
  setSession,
  updateGithubEventRun,
  updateGithubWebhookDelivery,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { resolvePrimaryRepoAlias } from './pm-agent-config.js';
import { markSeenIssueNumber } from './pm-runtime-state.js';
import { buildGithubEventPrompt } from './github-webhook-prompts.js';
import { OutboundMessageOptions, GithubNormalizedEvent, RegisteredGroup } from './types.js';

export interface GithubEventRunnerDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  queue: GroupQueue;
  onProcess: (
    groupKey: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  sendMessage: (
    jid: string,
    text: string,
    options?: OutboundMessageOptions,
  ) => Promise<void>;
}

function findRegisteredGroup(
  event: GithubNormalizedEvent,
  groups: Record<string, RegisteredGroup>,
): RegisteredGroup | undefined {
  const fromChat = getAgentsByChannel(event.chatJid).find(
    (group) => group.folder === event.groupFolder,
  );
  if (fromChat) return fromChat;

  return Object.values(groups).find((group) => group.folder === event.groupFolder);
}

function summarizeEvent(event: GithubNormalizedEvent): string {
  return `${event.repositoryFullName} ${event.resourceType} #${event.resourceNumber} (${event.triggerKind})`;
}

async function runGithubEvent(
  event: GithubNormalizedEvent,
  runId: number,
  deps: GithubEventRunnerDeps,
): Promise<void> {
  const startedAt = new Date().toISOString();
  updateGithubEventRun(runId, {
    status: 'running',
    updated_at: startedAt,
    error: null,
  });

  const groups = deps.registeredGroups();
  const group = findRegisteredGroup(event, groups);
  if (!group) {
    const error = `Registered group not found for ${event.groupFolder}`;
    updateGithubEventRun(runId, {
      status: 'error',
      updated_at: new Date().toISOString(),
      error,
    });
    updateGithubWebhookDelivery(event.deliveryId, {
      status: 'failed',
      error,
    });
    throw new Error(error);
  }

  const repoAlias = resolvePrimaryRepoAlias(group, event.repositoryFullName);
  const prompt = buildGithubEventPrompt(event, repoAlias);
  const isMain = group.folder === MAIN_GROUP_FOLDER;

  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((task) => ({
      id: task.id,
      groupFolder: task.group_folder,
      prompt: task.prompt,
      schedule_type: task.schedule_type,
      schedule_value: task.schedule_value,
      status: task.status,
      next_run: task.next_run,
    })),
  );

  const sessionKey = event.resourceKey;
  const sessionId = getSession(group.folder, event.chatJid, sessionKey);
  let result: string | null = null;
  let error: string | null = null;
  let outputSent = false;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  const EVENT_CLOSE_DELAY_MS = 10_000;

  const scheduleClose = () => {
    if (closeTimer) return;
    closeTimer = setTimeout(() => {
      logger.debug({ runId, resourceKey: event.resourceKey }, 'Closing GitHub event container after result');
      deps.queue.closeStdin(group.folder);
    }, EVENT_CLOSE_DELAY_MS);
  };

  const persistSession = (output: ContainerOutput) => {
    if (!output.newSessionId) return;
    setSession(group.folder, event.chatJid, sessionKey, output.newSessionId);
  };

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid: event.chatJid,
        isMain,
        assistantName: group.name,
      },
      (proc, containerName) =>
        deps.onProcess(group.folder, proc, containerName, group.folder),
      async (streamedOutput: ContainerOutput) => {
        persistSession(streamedOutput);
        if (streamedOutput.result) {
          result = streamedOutput.result;
          await deps.sendMessage(event.chatJid, streamedOutput.result, {
            agentLabel: group.name,
          });
          outputSent = true;
          scheduleClose();
        }
        if (streamedOutput.status === 'success') {
          deps.queue.notifyIdle(group.folder);
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
      },
    );

    if (closeTimer) clearTimeout(closeTimer);
    persistSession(output);
    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      result = output.result;
    }
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
  }

  if (error) {
    updateGithubEventRun(runId, {
      status: 'error',
      updated_at: new Date().toISOString(),
      error,
      result,
    });
    updateGithubWebhookDelivery(event.deliveryId, {
      status: 'failed',
      error,
    });

    if (!outputSent) {
      await deps.sendMessage(
        event.chatJid,
        `GitHub event processing failed for ${summarizeEvent(event)}: ${error}`,
        { agentLabel: group.name },
      );
    }
    return;
  }

  if (event.resourceType === 'issue') {
    markSeenIssueNumber(group.folder, event.resourceNumber);
  }

  updateGithubEventRun(runId, {
    status: 'success',
    updated_at: new Date().toISOString(),
    result: result || 'Completed with no final output',
    error: null,
  });
  updateGithubWebhookDelivery(event.deliveryId, {
    status: 'processed',
    error: null,
  });
}

export function enqueueGithubEvent(
  event: GithubNormalizedEvent,
  deps: GithubEventRunnerDeps,
): number {
  const now = new Date().toISOString();
  const runId = createGithubEventRun({
    delivery_id: event.deliveryId,
    group_folder: event.groupFolder,
    resource_type: event.resourceType,
    resource_key: event.resourceKey,
    chat_jid: event.chatJid,
    thread_ts: event.resourceKey,
    session_mode: 'isolated',
    trigger_kind: event.triggerKind,
    status: 'queued',
    result: null,
    error: null,
    created_at: now,
    updated_at: now,
  });

  updateGithubWebhookDelivery(event.deliveryId, {
    action: event.action,
    repository_full_name: event.repositoryFullName,
    installation_id: event.installationId,
    resource_key: event.resourceKey,
    status: 'queued',
    error: null,
  });

  deps.queue.enqueueTask(
    event.groupFolder,
    `github-event:${event.deliveryId}`,
    () => runGithubEvent(event, runId, deps),
  );

  logger.info(
    {
      deliveryId: event.deliveryId,
      resourceKey: event.resourceKey,
      runId,
    },
    'Queued GitHub event for PM agent',
  );

  return runId;
}
