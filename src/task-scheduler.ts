import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';

import {
  ASSISTANT_NAME,
  MAIN_GROUP_FOLDER,
  SCHEDULER_POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import {
  ContainerOutput,
  TaskSnippetOutput,
  runContainerAgent,
  runTaskSnippet,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAgentsByChannel,
  getAllTasks,
  getDueTasks,
  getSession,
  getTaskById,
  logTaskRun,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup, ScheduledTask } from './types.js';

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  queue: GroupQueue;
  onProcess: (groupKey: string, proc: ChildProcess, containerName: string, groupFolder: string) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
  runAgent?: typeof runContainerAgent;
  runSnippet?: typeof runTaskSnippet;
}

interface SnippetFixPayload {
  code_snippet: string;
  snippet_venv_path?: string | null;
}

function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  }
  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    return new Date(Date.now() + ms).toISOString();
  }
  // 'once' tasks have no next run
  return null;
}

function formatSnippetPayload(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

function attachSnippetPayload(prompt: string, payload: unknown): string {
  return `${prompt}\n\n[SNIPPET_GATE_PAYLOAD]\n${formatSnippetPayload(payload)}\n[/SNIPPET_GATE_PAYLOAD]`;
}

function parseSnippetFixPayload(text: string): SnippetFixPayload | null {
  const trimmed = text.trim();
  const parseCandidate = (candidate: string): SnippetFixPayload | null => {
    try {
      const parsed = JSON.parse(candidate) as Partial<SnippetFixPayload>;
      if (!parsed || typeof parsed !== 'object') return null;
      if (typeof parsed.code_snippet !== 'string' || !parsed.code_snippet.trim()) {
        return null;
      }
      const venv = parsed.snippet_venv_path;
      if (venv !== undefined && venv !== null && typeof venv !== 'string') {
        return null;
      }
      return {
        code_snippet: parsed.code_snippet,
        snippet_venv_path: venv ?? undefined,
      };
    } catch {
      return null;
    }
  };

  const exact = parseCandidate(trimmed);
  if (exact) return exact;

  const fenced = trimmed.match(/```json\s*([\s\S]*?)```/i);
  if (fenced) {
    const parsed = parseCandidate(fenced[1].trim());
    if (parsed) return parsed;
  }

  return null;
}

function buildSnippetAutoFixPrompt(
  task: ScheduledTask,
  snippetError: TaskSnippetOutput,
): string {
  const snippet = task.code_snippet || '';
  const traceback = snippetError.traceback || '(none)';
  const logFile = snippetError.logFile || '(unknown)';
  const error = snippetError.error || 'Snippet execution failed';

  return [
    'You are fixing a scheduled task code snippet.',
    'Return ONLY JSON with this exact schema and no extra text:',
    '{"snippet_auto_fix_json":true,"code_snippet":"<python function body>","snippet_venv_path":"/workspace/group/.venv or null"}',
    '',
    'Rules:',
    '- Provide only function BODY lines. The host wraps it as def __nanoclaw_task_snippet(context): ...',
    '- The snippet should return exactly False to skip silently when there is nothing to do.',
    '- Any non-False return will be passed as [SNIPPET_GATE_PAYLOAD] to the scheduled prompt.',
    '- Do not call send_message or send_agent_message.',
    '',
    `Task ID: ${task.id}`,
    `Task Prompt: ${task.prompt}`,
    `Schedule: ${task.schedule_type} ${task.schedule_value}`,
    `Current snippet_venv_path: ${task.snippet_venv_path || '(none)'}`,
    '',
    'Current broken snippet:',
    '```python',
    snippet,
    '```',
    '',
    `Error: ${error}`,
    `Traceback: ${traceback}`,
    `Log file: ${logFile}`,
  ].join('\n');
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const runAgent = deps.runAgent ?? runContainerAgent;
  const runSnippet = deps.runSnippet ?? runTaskSnippet;
  const startTime = Date.now();
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(task.group_folder);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Stop retry churn for malformed legacy rows.
    updateTask(task.id, { status: 'paused' });
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder, error },
      'Task has invalid group folder',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    return;
  }
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  const groupsInChat = getAgentsByChannel(task.chat_jid);
  const groupFromChat = groupsInChat.find(
    (g) => g.folder === task.group_folder,
  );
  // Fallback to in-memory state in case chat_jid was changed but folder remains valid.
  const groupFromMemory = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );
  const group = groupFromChat ?? groupFromMemory;

  if (!group) {
    logger.error(
      {
        taskId: task.id,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        knownFoldersInChat: groupsInChat.map((g) => g.folder),
        knownFoldersInMemory: Object.values(groups).map((g) => g.folder),
      },
      'Group not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`,
    });
    return;
  }

  let currentTask = task;
  const finalizeRun = (runResult: string | null, runError: string | null): void => {
    const durationMs = Date.now() - startTime;
    logTaskRun({
      task_id: currentTask.id,
      run_at: new Date().toISOString(),
      duration_ms: durationMs,
      status: runError ? 'error' : 'success',
      result: runResult,
      error: runError,
    });
    const nextRun = computeNextRun(currentTask);
    const resultSummary = runError
      ? `Error: ${runError}`
      : runResult
        ? runResult.slice(0, 200)
        : 'Completed';
    updateTaskAfterRun(currentTask.id, nextRun, resultSummary);
  };

  let promptToRun = currentTask.prompt;

  const trimmedSnippet = currentTask.code_snippet?.trim();
  if (trimmedSnippet) {
    logger.info(
      { taskId: currentTask.id, group: currentTask.group_folder },
      'Evaluating scheduled task code snippet gate',
    );

    const evaluateSnippet = async (): Promise<TaskSnippetOutput> =>
      runSnippet(group, {
        taskId: currentTask.id,
        groupFolder: currentTask.group_folder,
        chatJid: currentTask.chat_jid,
        scheduleType: currentTask.schedule_type,
        scheduleValue: currentTask.schedule_value,
        snippet: currentTask.code_snippet || '',
        snippetLanguage: currentTask.snippet_language || 'python',
        snippetVenvPath: currentTask.snippet_venv_path,
        isMain: currentTask.group_folder === MAIN_GROUP_FOLDER,
      });

    let snippetOutput = await evaluateSnippet();
    if (snippetOutput.status === 'error') {
      logger.error(
        {
          taskId: currentTask.id,
          error: snippetOutput.error,
          logFile: snippetOutput.logFile,
        },
        'Scheduled task snippet execution failed; invoking auto-fix agent',
      );

      let fixResult: string | null = null;
      let fixError: string | null = null;
      try {
        const fixOutput = await runAgent(
          group,
          {
            prompt: buildSnippetAutoFixPrompt(currentTask, snippetOutput),
            groupFolder: currentTask.group_folder,
            chatJid: currentTask.chat_jid,
            isMain: currentTask.group_folder === MAIN_GROUP_FOLDER,
            isScheduledTask: true,
            assistantName: ASSISTANT_NAME,
          },
          (proc, containerName) =>
            deps.onProcess(
              currentTask.group_folder,
              proc,
              containerName,
              currentTask.group_folder,
            ),
          async (streamedOutput: ContainerOutput) => {
            if (streamedOutput.result) {
              fixResult = streamedOutput.result;
            }
            if (streamedOutput.status === 'success') {
              deps.queue.notifyIdle(currentTask.group_folder);
            }
            if (streamedOutput.status === 'error') {
              fixError = streamedOutput.error || 'Unknown error';
            }
          },
        );
        if (fixOutput.status === 'error') {
          fixError = fixOutput.error || 'Unknown error';
        }
      } catch (err) {
        fixError = err instanceof Error ? err.message : String(err);
      }

      if (fixError || !fixResult) {
        const error = fixError || 'Auto-fix agent produced no snippet patch result';
        logger.error(
          { taskId: currentTask.id, error },
          'Scheduled task snippet auto-fix failed',
        );
        finalizeRun(
          null,
          `Snippet execution failed and auto-fix failed: ${error}`,
        );
        return;
      }

      const patch = parseSnippetFixPayload(fixResult);
      if (!patch) {
        finalizeRun(
          null,
          'Snippet execution failed and auto-fix output was not valid JSON',
        );
        return;
      }

      updateTask(currentTask.id, {
        code_snippet: patch.code_snippet,
        snippet_language: 'python',
        snippet_venv_path: patch.snippet_venv_path ?? null,
      });
      const refreshed = getTaskById(currentTask.id);
      if (refreshed) currentTask = refreshed;
      logger.info(
        { taskId: currentTask.id },
        'Scheduled task snippet updated by auto-fix agent; re-running snippet gate',
      );
      snippetOutput = await evaluateSnippet();
      if (snippetOutput.status === 'error') {
        finalizeRun(
          null,
          `Snippet execution failed after auto-fix: ${snippetOutput.error || 'Unknown error'}${snippetOutput.logFile ? ` (log: ${snippetOutput.logFile})` : ''}`,
        );
        return;
      }
    }

    if (snippetOutput.status === 'skip') {
      logger.info(
        { taskId: currentTask.id, group: currentTask.group_folder },
        'Snippet gate returned false; skipping scheduled task run silently',
      );
      finalizeRun('Skipped by code snippet (returned false)', null);
      return;
    }

    if (snippetOutput.status === 'pass') {
      promptToRun = attachSnippetPayload(currentTask.prompt, snippetOutput.payload);
    }
  }

  // Update tasks snapshot for container to read (filtered by group)
  const isMain = currentTask.group_folder === MAIN_GROUP_FOLDER;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    currentTask.group_folder,
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

  let result: string | null = null;
  let error: string | null = null;

  // For group context mode, use the group's scheduled task session
  const sessionId =
    currentTask.context_mode === 'group'
      ? getSession(currentTask.group_folder, currentTask.chat_jid, '__scheduled__')
      : undefined;

  // After the task produces a result, close the container promptly.
  // Tasks are single-turn — no need to wait IDLE_TIMEOUT (30 min) for the
  // query loop to time out. A short delay handles any final MCP calls.
  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    if (closeTimer) return; // already scheduled
    closeTimer = setTimeout(() => {
      logger.debug({ taskId: currentTask.id }, 'Closing task container after result');
      deps.queue.closeStdin(currentTask.group_folder);
    }, TASK_CLOSE_DELAY_MS);
  };

  try {
    const output = await runAgent(
      group,
      {
        prompt: promptToRun,
        sessionId,
        groupFolder: currentTask.group_folder,
        chatJid: currentTask.chat_jid,
        isMain,
        isScheduledTask: true,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) =>
        deps.onProcess(
          currentTask.group_folder,
          proc,
          containerName,
          currentTask.group_folder,
        ),
      async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.result) {
          result = streamedOutput.result;
          // Forward result to user (sendMessage handles formatting)
          await deps.sendMessage(currentTask.chat_jid, streamedOutput.result);
          scheduleClose();
        }
        if (streamedOutput.status === 'success') {
          deps.queue.notifyIdle(currentTask.group_folder);
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
      },
    );

    if (closeTimer) clearTimeout(closeTimer);

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      // Messages are sent via MCP tool (IPC), result text is just logged
      result = output.result;
    }

    logger.info(
      { taskId: currentTask.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: currentTask.id, error }, 'Task failed');
  }

  finalizeRun(result, error);
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        deps.queue.enqueueTask(
          currentTask.group_folder,
          currentTask.id,
          () => runTask(currentTask, deps),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
}

/** @internal - for tests only. */
export async function _runTaskForTests(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  await runTask(task, deps);
}
