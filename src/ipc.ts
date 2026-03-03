import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';

import { CronExpressionParser } from 'cron-parser';

import {
  DATA_DIR,
  HOST_REPOS_DIR,
  IPC_POLL_INTERVAL,
  MAX_PING_PONG_TURNS,
  MAIN_GROUP_FOLDER,
  TIMEZONE,
} from './config.js';
import { AvailableGroup } from './container-runner.js';
import {
  createTask,
  deleteTask,
  getAgentsByChannel,
  getChannelsForAgent,
  getTaskById,
  storeChatMetadata,
  storeMessageDirect,
  updateTask,
} from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { formatOutbound } from './router.js';
import { RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendFile: (jid: string, filePath: string, comment?: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroupMetadata: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
  ) => void;
  clearSession: (chatJid: string, groupFolder: string) => void;
}

let ipcWatcherRunning = false;
const pingPongCounts = new Map<string, number>();
const CODEX_EXEC_TIMEOUT_MS = 10 * 60 * 1000;
const HOST_OP_TIMEOUT_MS = 30 * 1000;
const HOST_CMD_MAX_BUFFER = 10 * 1024 * 1024;
const REPO_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const VALID_ISSUE_STATES = new Set(['open', 'closed', 'all']);
const VALID_PR_REVIEW_EVENTS = new Set([
  'comment',
  'approve',
  'request-changes',
]);

interface HostCommandResult {
  stdout: string;
  stderr: string;
}

interface HostCommandError extends Error {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
}

interface IpcTaskResponse {
  requestId: string;
  ok: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
  exitCode?: number | null;
}

interface ParsedGitHubIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: string;
}

type HostCommandRunner = (
  command: string,
  args: string[],
  options: {
    cwd?: string;
    timeoutMs: number;
  },
) => Promise<HostCommandResult>;

const defaultHostCommandRunner: HostCommandRunner = (
  command,
  args,
  options,
) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: HOST_CMD_MAX_BUFFER,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout, stderr });
          return;
        }

        const hostError = new Error(
          stderr?.trim() || error.message || `Command failed: ${command}`,
        ) as HostCommandError;
        hostError.stdout = stdout;
        hostError.stderr = stderr;
        const rawCode = (error as NodeJS.ErrnoException).code;
        hostError.exitCode = typeof rawCode === 'number' ? rawCode : null;
        reject(hostError);
      },
    );
  });

let hostCommandRunner: HostCommandRunner = defaultHostCommandRunner;

function normalizeAgentFolder(value: string): string {
  return value.trim().replace(/^@+/, '');
}

function toAgentMention(aliases: string[] | undefined, trigger: string | undefined, folder: string): string {
  if (aliases && aliases.length > 0) {
    const alias = aliases[0];
    return alias.startsWith('@') ? alias : `@${alias}`;
  }
  const trimmed = trigger?.trim();
  if (!trimmed) return `@${folder}`;
  return trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
}

function resolveAgentMention(
  folder: string,
  registeredGroups: Record<string, RegisteredGroup>,
): string {
  const group = Object.values(registeredGroups).find((g) => g.folder === folder);
  return toAgentMention(group?.aliases, group?.trigger, folder);
}

/** @internal - for tests only */
export function _resetPingPongCounts(): void {
  pingPongCounts.clear();
}

/** @internal - for tests only */
export function _setHostCommandRunnerForTest(
  runner?: HostCommandRunner,
): void {
  hostCommandRunner = runner ?? defaultHostCommandRunner;
}

function normalizeRepoName(value: string): string | null {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, '');
  if (!trimmed) return null;

  const segments = trimmed.split('/');
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        !REPO_SEGMENT_PATTERN.test(segment),
    )
  ) {
    return null;
  }

  return segments.join('/');
}

function getAllowedRepos(sourceGroup: string, groups: Record<string, RegisteredGroup>): Set<string> {
  const allowed = new Set<string>();

  for (const group of Object.values(groups)) {
    if (group.folder !== sourceGroup) continue;
    const raw = group.containerConfig?.envVars?.ALLOWED_REPOS;
    if (!raw) continue;
    for (const repo of raw.split(',')) {
      const normalized = normalizeRepoName(repo);
      if (normalized) allowed.add(normalized);
    }
  }

  return allowed;
}

function resolveRepoPath(repo: string): string {
  const repoPath = path.resolve(HOST_REPOS_DIR, repo);
  const relative = path.relative(HOST_REPOS_DIR, repoPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Repo path escapes host repo base directory');
  }
  return repoPath;
}

function authorizeRepoAccess(
  sourceGroup: string,
  repoRaw: string | undefined,
  groups: Record<string, RegisteredGroup>,
): { ok: true; repo: string; repoPath: string } | { ok: false; error: string } {
  if (!repoRaw) {
    return { ok: false, error: 'Missing required field: repo' };
  }

  const repo = normalizeRepoName(repoRaw);
  if (!repo) {
    return { ok: false, error: `Invalid repo name: "${repoRaw}"` };
  }

  const allowedRepos = getAllowedRepos(sourceGroup, groups);
  if (!allowedRepos.has(repo)) {
    return {
      ok: false,
      error: `Repo "${repo}" is not allowed for agent "${sourceGroup}"`,
    };
  }

  let repoPath: string;
  try {
    repoPath = resolveRepoPath(repo);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (!fs.existsSync(repoPath)) {
    return { ok: false, error: `Repo path not found: ${repoPath}` };
  }

  try {
    if (!fs.statSync(repoPath).isDirectory()) {
      return { ok: false, error: `Repo path is not a directory: ${repoPath}` };
    }
  } catch (err) {
    return {
      ok: false,
      error: `Failed to access repo path: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { ok: true, repo, repoPath };
}

function writeTaskResponse(
  sourceGroup: string,
  requestId: string,
  response: Omit<IpcTaskResponse, 'requestId'>,
): void {
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    logger.warn(
      { sourceGroup, requestId },
      'Invalid IPC requestId in response write',
    );
    return;
  }

  const responsesDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'responses');
  fs.mkdirSync(responsesDir, { recursive: true });
  const responsePath = path.join(responsesDir, `${requestId}.json`);
  const tempPath = `${responsePath}.tmp`;
  const payload: IpcTaskResponse = { requestId, ...response };
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2));
  fs.renameSync(tempPath, responsePath);
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function getHostCommandErrorDetails(
  err: unknown,
): { error: string; stdout?: string; stderr?: string; exitCode?: number | null } {
  const details: { error: string; stdout?: string; stderr?: string; exitCode?: number | null } = {
    error: getErrorMessage(err),
  };
  if (err && typeof err === 'object') {
    const maybe = err as HostCommandError;
    if (typeof maybe.stdout === 'string') details.stdout = maybe.stdout;
    if (typeof maybe.stderr === 'string') details.stderr = maybe.stderr;
    if (
      maybe.exitCode === null ||
      typeof maybe.exitCode === 'number'
    ) {
      details.exitCode = maybe.exitCode;
    }
  }
  return details;
}

function parseGitHubIssueListOutput(stdout: string): ParsedGitHubIssue[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`Invalid JSON: ${getErrorMessage(err)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error('Expected JSON array from gh issue list');
  }

  return parsed.map((rawIssue, index) => {
    if (!rawIssue || typeof rawIssue !== 'object') {
      throw new Error(`Issue ${index + 1} is not an object`);
    }

    const issue = rawIssue as Record<string, unknown>;
    const rawNumber = issue.number;
    if (!Number.isInteger(rawNumber) || Number(rawNumber) <= 0) {
      throw new Error(`Issue ${index + 1} has invalid number`);
    }

    const title = typeof issue.title === 'string' ? issue.title.trim() : '';
    if (!title) {
      throw new Error(`Issue ${index + 1} is missing title`);
    }

    const body = typeof issue.body === 'string' ? issue.body : '';
    const rawState = typeof issue.state === 'string' ? issue.state.trim() : '';
    const state = rawState ? rawState.toLowerCase() : 'open';

    const labels = Array.isArray(issue.labels)
      ? issue.labels
        .map((label) => {
          if (typeof label === 'string') return label.trim();
          if (label && typeof label === 'object' && typeof (label as { name?: unknown }).name === 'string') {
            return (label as { name: string }).name.trim();
          }
          return '';
        })
        .filter((label) => label.length > 0)
      : [];

    return {
      number: Number(rawNumber),
      title,
      body,
      labels,
      state,
    };
  });
}

async function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs: number },
): Promise<HostCommandResult> {
  return hostCommandRunner(command, args, options);
}

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    for (const sourceGroup of groupFolders) {
      const isMain = sourceGroup === MAIN_GROUP_FOLDER;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Authorization: verify this group can send to this chatJid
              const targetGroup = registeredGroups[data.chatJid];
              const authorized = isMain || (targetGroup && targetGroup.folder === sourceGroup);

              if (data.type === 'message' && data.chatJid && data.text) {
                if (authorized) {
                  const outbound = formatOutbound(data.text);
                  if (outbound) {
                    await deps.sendMessage(data.chatJid, outbound);
                    logger.info(
                      { chatJid: data.chatJid, sourceGroup },
                      'IPC message sent',
                    );
                  } else {
                    logger.info(
                      { chatJid: data.chatJid, sourceGroup },
                      'IPC message dropped after sanitization',
                    );
                  }
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              } else if (data.type === 'file' && data.chatJid && data.filePath) {
                if (authorized) {
                  await deps.sendFile(data.chatJid, data.filePath, data.comment);
                  logger.info(
                    { chatJid: data.chatJid, filePath: data.filePath, sourceGroup },
                    'IPC file sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC file attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    requestId?: string;
    request_id?: string;
    prompt?: string;
    repo?: string;
    branch?: string;
    title?: string;
    body?: string;
    base?: string;
    head?: string;
    state?: string;
    issue_number?: number;
    issueNumber?: number;
    pr_number?: number;
    prNumber?: number;
    review_event?: string;
    reviewEvent?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    targetAgent?: string;
    text?: string;
    channelJid?: string;
    sourceChatJid?: string;
    threadTs?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    aliases?: string[];
    requiresTrigger?: boolean;
    gateway?: RegisteredGroup['gateway'];
    containerConfig?: RegisteredGroup['containerConfig'];
    role?: string;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();
  const requestId = data.requestId ?? data.request_id;

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const scheduled = new Date(data.schedule_value);
          if (isNaN(scheduled.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = scheduled.toISOString();
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'clear_session': {
      const targetJid = (isMain && data.targetJid)
        ? data.targetJid
        : data.targetJid || data.chatJid;
      if (!targetJid) {
        logger.warn({ sourceGroup }, 'clear_session missing target JID');
        break;
      }

      const targetGroupEntry = registeredGroups[targetJid];
      if (!targetGroupEntry) {
        logger.warn({ targetJid }, 'Cannot clear session: target group not registered');
        break;
      }

      const targetFolder = targetGroupEntry.folder;
      if (!isMain && targetFolder !== sourceGroup) {
        logger.warn(
          { sourceGroup, targetFolder },
          'Unauthorized clear_session attempt blocked',
        );
        break;
      }

      deps.clearSession(targetJid, targetFolder);
      logger.info(
        { sourceGroup, targetJid, targetFolder },
        'Session cleared via IPC',
      );
      break;
    }

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroupMetadata(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Auto-convert trigger to aliases if aliases not provided
        const aliases = data.aliases ?? [data.trigger.replace(/^@/, '')];
        const gateway = data.gateway ?? {
          rules: [data.requiresTrigger === false
            ? { match: 'any_message' as const }
            : { match: 'self_mention' as const }],
        };
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          aliases,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
          gateway,
          role: data.role,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'send_agent_message': {
      const messageText = data.text?.trim();
      if (!data.targetAgent || !messageText) {
        logger.warn(
          { sourceGroup, targetAgent: data.targetAgent },
          'Invalid send_agent_message request - missing required fields',
        );
        break;
      }

      const targetAgent = normalizeAgentFolder(data.targetAgent);
      if (!targetAgent) {
        logger.warn(
          { sourceGroup, targetAgent: data.targetAgent },
          'Invalid send_agent_message request - empty target agent',
        );
        break;
      }

      const targetChannels = getChannelsForAgent(targetAgent);
      if (targetChannels.length === 0) {
        logger.warn(
          { sourceGroup, targetAgent },
          'Cannot send cross-agent message: target agent has no registered channels',
        );
        break;
      }

      let targetJid: string;
      if (data.channelJid) {
        if (!targetChannels.includes(data.channelJid)) {
          logger.warn(
            { sourceGroup, targetAgent, channelJid: data.channelJid },
            'Cannot send cross-agent message: target agent not registered in requested channel',
          );
          break;
        }
        targetJid = data.channelJid;
      } else {
        targetJid = targetChannels[0];
      }

      const threadTs = data.threadTs?.trim();
      const threadKey = threadTs || data.sourceChatJid || targetJid;
      const pingPongKey = `${sourceGroup}::${targetAgent}::${threadKey}`;
      const nextCount = (pingPongCounts.get(pingPongKey) ?? 0) + 1;
      if (nextCount > MAX_PING_PONG_TURNS) {
        logger.warn(
          {
            sourceGroup,
            targetAgent,
            targetJid,
            threadKey,
            nextCount,
            maxPingPongTurns: MAX_PING_PONG_TURNS,
          },
          'Cross-agent message blocked: ping-pong limit exceeded',
        );
        break;
      }
      pingPongCounts.set(pingPongKey, nextCount);

      const sourceMention = resolveAgentMention(sourceGroup, registeredGroups);
      const targetRegistration = getAgentsByChannel(targetJid).find(
        (g) => g.folder === targetAgent,
      );
      const targetMention = toAgentMention(targetRegistration?.aliases, targetRegistration?.trigger, targetAgent);
      const addressedText = messageText.toLowerCase().startsWith(targetMention.toLowerCase())
        ? messageText
        : `${targetMention} ${messageText}`;
      const prefixed = `[from ${sourceMention}] ${addressedText}`;
      const outbound = formatOutbound(prefixed);
      if (!outbound) {
        logger.info(
          { sourceGroup, targetAgent, targetJid },
          'Cross-agent message dropped after sanitization',
        );
        break;
      }

      await deps.sendMessage(targetJid, outbound);

      const now = new Date().toISOString();
      storeChatMetadata(targetJid, now);
      const messageId = `cross-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      storeMessageDirect({
        id: messageId,
        chat_jid: targetJid,
        sender: `agent:${sourceGroup}`,
        sender_name: sourceMention,
        content: outbound,
        timestamp: now,
        is_from_me: true,
        is_bot_message: true,
        is_cross_agent: true,
        agent_source: sourceGroup,
        thread_ts: threadTs,
      });

      logger.info(
        {
          sourceGroup,
          targetAgent,
          targetJid,
          threadKey,
          pingPongCount: nextCount,
        },
        'Cross-agent IPC message sent',
      );
      break;
    }

    case 'codex_exec': {
      if (!requestId) {
        logger.warn({ sourceGroup, type: data.type }, 'Missing requestId for IPC task');
        break;
      }

      const auth = authorizeRepoAccess(sourceGroup, data.repo, registeredGroups);
      if (!auth.ok) {
        logger.warn(
          { sourceGroup, repo: data.repo, reason: auth.error },
          'Unauthorized codex_exec request blocked',
        );
        writeTaskResponse(sourceGroup, requestId, { ok: false, error: auth.error });
        break;
      }

      const prompt = data.prompt?.trim();
      if (!prompt) {
        writeTaskResponse(sourceGroup, requestId, {
          ok: false,
          error: 'Missing required field: prompt',
        });
        break;
      }

      try {
        const branch = data.branch?.trim();
        if (branch) {
          await runCommand('git', ['checkout', branch], {
            cwd: auth.repoPath,
            timeoutMs: HOST_OP_TIMEOUT_MS,
          });
        }

        const result = await runCommand(
          'codex',
          [
            'exec',
            '--full-auto',
            '--sandbox',
            'danger-full-access',
            '--cd',
            auth.repoPath,
            prompt,
          ],
          { timeoutMs: CODEX_EXEC_TIMEOUT_MS },
        );
        writeTaskResponse(sourceGroup, requestId, {
          ok: true,
          stdout: result.stdout,
          stderr: result.stderr || undefined,
        });
      } catch (err) {
        const details = getHostCommandErrorDetails(err);
        writeTaskResponse(sourceGroup, requestId, {
          ok: false,
          ...details,
        });
      }
      break;
    }

    case 'git_create_branch': {
      if (!requestId) {
        logger.warn({ sourceGroup, type: data.type }, 'Missing requestId for IPC task');
        break;
      }
      const auth = authorizeRepoAccess(sourceGroup, data.repo, registeredGroups);
      if (!auth.ok) {
        logger.warn(
          { sourceGroup, repo: data.repo, reason: auth.error },
          'Unauthorized git_create_branch request blocked',
        );
        writeTaskResponse(sourceGroup, requestId, { ok: false, error: auth.error });
        break;
      }
      const branch = data.branch?.trim();
      if (!branch) {
        writeTaskResponse(sourceGroup, requestId, {
          ok: false,
          error: 'Missing required field: branch',
        });
        break;
      }
      try {
        const result = await runCommand(
          'git',
          ['checkout', '-b', branch],
          { cwd: auth.repoPath, timeoutMs: HOST_OP_TIMEOUT_MS },
        );
        writeTaskResponse(sourceGroup, requestId, {
          ok: true,
          stdout: result.stdout,
          stderr: result.stderr || undefined,
        });
      } catch (err) {
        const details = getHostCommandErrorDetails(err);
        writeTaskResponse(sourceGroup, requestId, { ok: false, ...details });
      }
      break;
    }

    case 'git_checkout': {
      if (!requestId) {
        logger.warn({ sourceGroup, type: data.type }, 'Missing requestId for IPC task');
        break;
      }
      const auth = authorizeRepoAccess(sourceGroup, data.repo, registeredGroups);
      if (!auth.ok) {
        logger.warn(
          { sourceGroup, repo: data.repo, reason: auth.error },
          'Unauthorized git_checkout request blocked',
        );
        writeTaskResponse(sourceGroup, requestId, { ok: false, error: auth.error });
        break;
      }
      const branch = data.branch?.trim();
      if (!branch) {
        writeTaskResponse(sourceGroup, requestId, {
          ok: false,
          error: 'Missing required field: branch',
        });
        break;
      }
      try {
        const result = await runCommand(
          'git',
          ['checkout', branch],
          { cwd: auth.repoPath, timeoutMs: HOST_OP_TIMEOUT_MS },
        );
        writeTaskResponse(sourceGroup, requestId, {
          ok: true,
          stdout: result.stdout,
          stderr: result.stderr || undefined,
        });
      } catch (err) {
        const details = getHostCommandErrorDetails(err);
        writeTaskResponse(sourceGroup, requestId, { ok: false, ...details });
      }
      break;
    }

    case 'git_pull': {
      if (!requestId) {
        logger.warn({ sourceGroup, type: data.type }, 'Missing requestId for IPC task');
        break;
      }
      const auth = authorizeRepoAccess(sourceGroup, data.repo, registeredGroups);
      if (!auth.ok) {
        logger.warn(
          { sourceGroup, repo: data.repo, reason: auth.error },
          'Unauthorized git_pull request blocked',
        );
        writeTaskResponse(sourceGroup, requestId, { ok: false, error: auth.error });
        break;
      }
      try {
        let branch = data.branch?.trim();
        if (!branch) {
          const current = await runCommand(
            'git',
            ['rev-parse', '--abbrev-ref', 'HEAD'],
            { cwd: auth.repoPath, timeoutMs: HOST_OP_TIMEOUT_MS },
          );
          branch = current.stdout.trim();
        }
        if (!branch) {
          writeTaskResponse(sourceGroup, requestId, {
            ok: false,
            error: 'Unable to determine current branch for git_pull',
          });
          break;
        }
        const result = await runCommand(
          'git',
          ['pull', 'origin', branch],
          { cwd: auth.repoPath, timeoutMs: HOST_OP_TIMEOUT_MS },
        );
        writeTaskResponse(sourceGroup, requestId, {
          ok: true,
          stdout: result.stdout,
          stderr: result.stderr || undefined,
        });
      } catch (err) {
        const details = getHostCommandErrorDetails(err);
        writeTaskResponse(sourceGroup, requestId, { ok: false, ...details });
      }
      break;
    }

    case 'gh_create_pr': {
      if (!requestId) {
        logger.warn({ sourceGroup, type: data.type }, 'Missing requestId for IPC task');
        break;
      }
      const auth = authorizeRepoAccess(sourceGroup, data.repo, registeredGroups);
      if (!auth.ok) {
        logger.warn(
          { sourceGroup, repo: data.repo, reason: auth.error },
          'Unauthorized gh_create_pr request blocked',
        );
        writeTaskResponse(sourceGroup, requestId, { ok: false, error: auth.error });
        break;
      }

      const title = data.title?.trim();
      const body = data.body;
      const base = data.base?.trim();
      const head = data.head?.trim();
      if (!title || !body || !base || !head) {
        writeTaskResponse(sourceGroup, requestId, {
          ok: false,
          error: 'Missing required fields: title, body, base, head',
        });
        break;
      }

      try {
        const result = await runCommand(
          'gh',
          ['pr', 'create', '--title', title, '--body', body, '--base', base, '--head', head],
          { cwd: auth.repoPath, timeoutMs: HOST_OP_TIMEOUT_MS },
        );
        writeTaskResponse(sourceGroup, requestId, {
          ok: true,
          stdout: result.stdout,
          stderr: result.stderr || undefined,
        });
      } catch (err) {
        const details = getHostCommandErrorDetails(err);
        writeTaskResponse(sourceGroup, requestId, { ok: false, ...details });
      }
      break;
    }

    case 'gh_issue_list': {
      if (!requestId) {
        logger.warn({ sourceGroup, type: data.type }, 'Missing requestId for IPC task');
        break;
      }
      const auth = authorizeRepoAccess(sourceGroup, data.repo, registeredGroups);
      if (!auth.ok) {
        logger.warn(
          { sourceGroup, repo: data.repo, reason: auth.error },
          'Unauthorized gh_issue_list request blocked',
        );
        writeTaskResponse(sourceGroup, requestId, { ok: false, error: auth.error });
        break;
      }

      const state = data.state?.trim() || 'open';
      if (!VALID_ISSUE_STATES.has(state)) {
        writeTaskResponse(sourceGroup, requestId, {
          ok: false,
          error: `Invalid issue state: "${state}"`,
        });
        break;
      }

      try {
        const result = await runCommand(
          'gh',
          [
            'issue',
            'list',
            '--state',
            state,
            '--json',
            'number,title,body,state,labels,url',
          ],
          { cwd: auth.repoPath, timeoutMs: HOST_OP_TIMEOUT_MS },
        );
        try {
          const issues = parseGitHubIssueListOutput(result.stdout);
          writeTaskResponse(sourceGroup, requestId, {
            ok: true,
            stdout: JSON.stringify(issues, null, 2),
            stderr: result.stderr || undefined,
          });
        } catch (parseErr) {
          writeTaskResponse(sourceGroup, requestId, {
            ok: false,
            error: `Failed to parse gh issue list output: ${getErrorMessage(parseErr)}`,
            stdout: result.stdout || undefined,
            stderr: result.stderr || undefined,
          });
        }
      } catch (err) {
        const details = getHostCommandErrorDetails(err);
        writeTaskResponse(sourceGroup, requestId, { ok: false, ...details });
      }
      break;
    }

    case 'gh_issue_comment': {
      if (!requestId) {
        logger.warn({ sourceGroup, type: data.type }, 'Missing requestId for IPC task');
        break;
      }
      const auth = authorizeRepoAccess(sourceGroup, data.repo, registeredGroups);
      if (!auth.ok) {
        logger.warn(
          { sourceGroup, repo: data.repo, reason: auth.error },
          'Unauthorized gh_issue_comment request blocked',
        );
        writeTaskResponse(sourceGroup, requestId, { ok: false, error: auth.error });
        break;
      }

      const issueNumber =
        data.issue_number ??
        data.issueNumber;
      const body = data.body;
      if (!issueNumber || !Number.isInteger(issueNumber) || issueNumber <= 0 || !body?.trim()) {
        writeTaskResponse(sourceGroup, requestId, {
          ok: false,
          error: 'Missing required fields: issue_number (positive integer), body',
        });
        break;
      }

      try {
        const result = await runCommand(
          'gh',
          ['issue', 'comment', String(issueNumber), '--body', body],
          { cwd: auth.repoPath, timeoutMs: HOST_OP_TIMEOUT_MS },
        );
        writeTaskResponse(sourceGroup, requestId, {
          ok: true,
          stdout: result.stdout,
          stderr: result.stderr || undefined,
        });
      } catch (err) {
        const details = getHostCommandErrorDetails(err);
        writeTaskResponse(sourceGroup, requestId, { ok: false, ...details });
      }
      break;
    }

    case 'gh_pr_diff': {
      if (!requestId) {
        logger.warn({ sourceGroup, type: data.type }, 'Missing requestId for IPC task');
        break;
      }
      const auth = authorizeRepoAccess(sourceGroup, data.repo, registeredGroups);
      if (!auth.ok) {
        logger.warn(
          { sourceGroup, repo: data.repo, reason: auth.error },
          'Unauthorized gh_pr_diff request blocked',
        );
        writeTaskResponse(sourceGroup, requestId, { ok: false, error: auth.error });
        break;
      }

      const prNumber =
        data.pr_number ??
        data.prNumber;
      if (!prNumber || !Number.isInteger(prNumber) || prNumber <= 0) {
        writeTaskResponse(sourceGroup, requestId, {
          ok: false,
          error: 'Missing required field: pr_number (positive integer)',
        });
        break;
      }

      try {
        const result = await runCommand(
          'gh',
          ['pr', 'diff', String(prNumber)],
          { cwd: auth.repoPath, timeoutMs: HOST_OP_TIMEOUT_MS },
        );
        writeTaskResponse(sourceGroup, requestId, {
          ok: true,
          stdout: result.stdout,
          stderr: result.stderr || undefined,
        });
      } catch (err) {
        const details = getHostCommandErrorDetails(err);
        writeTaskResponse(sourceGroup, requestId, { ok: false, ...details });
      }
      break;
    }

    case 'gh_pr_review': {
      if (!requestId) {
        logger.warn({ sourceGroup, type: data.type }, 'Missing requestId for IPC task');
        break;
      }
      const auth = authorizeRepoAccess(sourceGroup, data.repo, registeredGroups);
      if (!auth.ok) {
        logger.warn(
          { sourceGroup, repo: data.repo, reason: auth.error },
          'Unauthorized gh_pr_review request blocked',
        );
        writeTaskResponse(sourceGroup, requestId, { ok: false, error: auth.error });
        break;
      }

      const prNumber =
        data.pr_number ??
        data.prNumber;
      const body = data.body;
      if (!prNumber || !Number.isInteger(prNumber) || prNumber <= 0 || !body?.trim()) {
        writeTaskResponse(sourceGroup, requestId, {
          ok: false,
          error: 'Missing required fields: pr_number (positive integer), body',
        });
        break;
      }

      const reviewEventRaw = (data.review_event ?? data.reviewEvent ?? 'comment')
        .trim()
        .toLowerCase();
      if (!VALID_PR_REVIEW_EVENTS.has(reviewEventRaw)) {
        writeTaskResponse(sourceGroup, requestId, {
          ok: false,
          error: `Invalid review_event: "${reviewEventRaw}"`,
        });
        break;
      }

      const reviewFlag = reviewEventRaw === 'request-changes'
        ? '--request-changes'
        : `--${reviewEventRaw}`;

      try {
        const result = await runCommand(
          'gh',
          ['pr', 'review', String(prNumber), reviewFlag, '--body', body],
          { cwd: auth.repoPath, timeoutMs: HOST_OP_TIMEOUT_MS },
        );
        writeTaskResponse(sourceGroup, requestId, {
          ok: true,
          stdout: result.stdout,
          stderr: result.stderr || undefined,
        });
      } catch (err) {
        const details = getHostCommandErrorDetails(err);
        writeTaskResponse(sourceGroup, requestId, { ok: false, ...details });
      }
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
