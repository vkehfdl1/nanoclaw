/**
 * Agent Schedule Bootstrap
 *
 * Reads `schedule.json` files from agent group folders and registers any
 * missing recurring tasks in the database at system startup.
 *
 * This enables declarative, file-based task configuration for agents like
 * Marketer that need periodic self-initiated tasks (e.g., weekly SNS research,
 * monthly brand reviews, comment monitoring sweeps).
 *
 * Design:
 * - Each agent group may have a `schedule.json` alongside its `CLAUDE.md`
 * - Tasks are identified by a stable `id` field in the config
 * - The DB task ID is derived from the config ID: `bootstrap-{configId}`
 * - Idempotent: if a task with that ID already exists, it is skipped
 * - Disabled tasks (enabled: false) are never registered
 * - If the group is not yet registered (no chat_jid), bootstrap is skipped
 *   for that group — tasks will be registered on next startup after registration
 */

import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { GROUPS_DIR, TIMEZONE } from './config.js';
import { createTask, getTaskById } from './db.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ScheduleTaskConfig {
  /** Stable identifier used to derive the DB task ID. Must be unique within the file. */
  id: string;
  /** Human-readable name for logging and documentation. */
  name: string;
  /** Optional description of what this task does. */
  description?: string;
  /** Whether this task is active. Defaults to true if omitted. */
  enabled?: boolean;
  /** Cron expression, millisecond interval, or ISO timestamp. */
  schedule_type: 'cron' | 'interval' | 'once';
  /** Value matching schedule_type: cron expression, ms number as string, or ISO date string. */
  schedule_value: string;
  /** Whether to run in an isolated context or reuse the group session. Default: 'group'. */
  context_mode?: 'group' | 'isolated';
  /** The prompt to send the agent when this task fires. */
  prompt: string;
}

export interface AgentScheduleConfig {
  /** Schema version — currently always "1". */
  version: string;
  /** Optional description of this schedule config. */
  description?: string;
  /** List of task definitions. */
  tasks: ScheduleTaskConfig[];
}

export interface BootstrapResult {
  /** Number of tasks registered this run. */
  registered: number;
  /** Number of tasks skipped (already existed). */
  skipped: number;
  /** Number of tasks skipped because they are disabled. */
  disabled: number;
  /** Number of tasks that failed to register (invalid config). */
  failed: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Convert a config task ID to a stable DB task ID.
 * Using a fixed prefix makes it easy to identify bootstrapped tasks
 * and avoids collisions with dynamically-created tasks.
 */
export function configIdToDbId(configId: string): string {
  return `bootstrap-${configId}`;
}

/**
 * Parse and validate a schedule config file.
 * Returns null if the file is missing, unreadable, or malformed.
 */
export function parseScheduleConfig(filePath: string): AgentScheduleConfig | null {
  if (!fs.existsSync(filePath)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    logger.warn({ filePath, err }, 'Failed to parse schedule.json');
    return null;
  }

  if (typeof raw !== 'object' || raw === null || !('tasks' in raw)) {
    logger.warn({ filePath }, 'schedule.json is missing required "tasks" field');
    return null;
  }

  const config = raw as AgentScheduleConfig;

  if (!Array.isArray(config.tasks)) {
    logger.warn({ filePath }, 'schedule.json "tasks" must be an array');
    return null;
  }

  return config;
}

/**
 * Compute the `next_run` ISO timestamp for a schedule config task.
 * Returns null if the schedule_value is invalid.
 */
export function computeNextRun(task: ScheduleTaskConfig): string | null {
  if (task.schedule_type === 'cron') {
    try {
      const interval = CronExpressionParser.parse(task.schedule_value, { tz: TIMEZONE });
      return interval.next().toISOString();
    } catch {
      logger.warn({ taskId: task.id, scheduleValue: task.schedule_value }, 'Invalid cron expression in schedule config');
      return null;
    }
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (isNaN(ms) || ms <= 0) {
      logger.warn({ taskId: task.id, scheduleValue: task.schedule_value }, 'Invalid interval in schedule config (must be positive integer ms)');
      return null;
    }
    return new Date(Date.now() + ms).toISOString();
  }

  if (task.schedule_type === 'once') {
    const d = new Date(task.schedule_value);
    if (isNaN(d.getTime())) {
      logger.warn({ taskId: task.id, scheduleValue: task.schedule_value }, 'Invalid ISO timestamp in schedule config');
      return null;
    }
    return d.toISOString();
  }

  logger.warn({ taskId: task.id, scheduleType: task.schedule_type }, 'Unknown schedule_type in config');
  return null;
}

// ─── Core bootstrap logic ─────────────────────────────────────────────────────

/**
 * Bootstrap scheduled tasks for a single agent group.
 *
 * @param groupFolder - The group folder name (e.g. "marketer")
 * @param chatJid     - The group's registered chat JID (used as chat_jid in tasks)
 * @returns BootstrapResult summary
 */
export function bootstrapGroupSchedule(
  groupFolder: string,
  chatJid: string,
): BootstrapResult {
  const result: BootstrapResult = { registered: 0, skipped: 0, disabled: 0, failed: 0 };

  const scheduleFile = path.join(GROUPS_DIR, groupFolder, 'schedule.json');
  const config = parseScheduleConfig(scheduleFile);

  if (!config) {
    // No schedule.json or unreadable — nothing to bootstrap for this group
    return result;
  }

  logger.info(
    { groupFolder, taskCount: config.tasks.length },
    'Bootstrapping agent schedule',
  );

  for (const taskConfig of config.tasks) {
    if (!taskConfig.id || !taskConfig.prompt || !taskConfig.schedule_type || !taskConfig.schedule_value) {
      logger.warn(
        { groupFolder, task: taskConfig },
        'Skipping schedule config task with missing required fields (id, prompt, schedule_type, schedule_value)',
      );
      result.failed++;
      continue;
    }

    // Disabled tasks are never registered
    if (taskConfig.enabled === false) {
      logger.debug({ groupFolder, taskId: taskConfig.id }, 'Task disabled in schedule config, skipping');
      result.disabled++;
      continue;
    }

    const dbId = configIdToDbId(taskConfig.id);

    // Idempotency: skip if already registered
    if (getTaskById(dbId)) {
      logger.debug({ groupFolder, taskId: taskConfig.id, dbId }, 'Task already registered, skipping');
      result.skipped++;
      continue;
    }

    const nextRun = computeNextRun(taskConfig);
    if (nextRun === null) {
      // computeNextRun already logged the reason
      result.failed++;
      continue;
    }

    const contextMode = taskConfig.context_mode === 'isolated' ? 'isolated' : 'group';

    try {
      createTask({
        id: dbId,
        group_folder: groupFolder,
        chat_jid: chatJid,
        prompt: taskConfig.prompt,
        schedule_type: taskConfig.schedule_type,
        schedule_value: taskConfig.schedule_value,
        context_mode: contextMode,
        next_run: nextRun,
        status: 'active',
        created_at: new Date().toISOString(),
      });

      logger.info(
        { groupFolder, taskId: taskConfig.id, dbId, scheduleType: taskConfig.schedule_type, scheduleValue: taskConfig.schedule_value, nextRun },
        `Bootstrapped scheduled task: ${taskConfig.name}`,
      );
      result.registered++;
    } catch (err) {
      logger.error({ groupFolder, taskId: taskConfig.id, err }, 'Failed to create bootstrapped task');
      result.failed++;
    }
  }

  return result;
}

/**
 * Bootstrap scheduled tasks for all registered agent groups that have a
 * `schedule.json` in their group folder.
 *
 * Called once at system startup after the database and registered groups
 * are loaded.
 *
 * @param registeredGroups - Map of chatJid → RegisteredGroup from the DB
 */
export function bootstrapAllAgentSchedules(
  registeredGroups: Record<string, RegisteredGroup>,
): void {
  let totalRegistered = 0;
  let totalSkipped = 0;
  let totalDisabled = 0;
  let totalFailed = 0;

  // Build a folder → chatJid lookup for quick access
  const folderToJid = new Map<string, string>();
  for (const [jid, group] of Object.entries(registeredGroups)) {
    folderToJid.set(group.folder, jid);
  }

  // Scan groups directory for schedule.json files
  let groupFolders: string[];
  try {
    groupFolders = fs
      .readdirSync(GROUPS_DIR)
      .filter((f) => {
        const stat = fs.statSync(path.join(GROUPS_DIR, f));
        return stat.isDirectory();
      });
  } catch (err) {
    logger.error({ err }, 'Failed to read groups directory during schedule bootstrap');
    return;
  }

  for (const groupFolder of groupFolders) {
    const scheduleFile = path.join(GROUPS_DIR, groupFolder, 'schedule.json');
    if (!fs.existsSync(scheduleFile)) continue;

    const chatJid = folderToJid.get(groupFolder);
    if (!chatJid) {
      logger.info(
        { groupFolder },
        'Group has schedule.json but is not registered yet — skipping bootstrap (will retry on next startup after registration)',
      );
      continue;
    }

    const result = bootstrapGroupSchedule(groupFolder, chatJid);
    totalRegistered += result.registered;
    totalSkipped += result.skipped;
    totalDisabled += result.disabled;
    totalFailed += result.failed;
  }

  if (totalRegistered > 0 || totalFailed > 0) {
    logger.info(
      { totalRegistered, totalSkipped, totalDisabled, totalFailed },
      'Agent schedule bootstrap complete',
    );
  } else {
    logger.debug(
      { totalSkipped, totalDisabled },
      'Agent schedule bootstrap: no new tasks registered',
    );
  }
}
