import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AgentScheduleConfig,
  ScheduleTaskConfig,
  bootstrapAllAgentSchedules,
  bootstrapGroupSchedule,
  computeNextRun,
  configIdToDbId,
  parseScheduleConfig,
} from './agent-schedule-bootstrap.js';
import { _initTestDatabase, createTask, getAllTasks, getTaskById } from './db.js';
import { RegisteredGroup } from './types.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const MARKETER_GROUP: RegisteredGroup = {
  name: 'Marketer',
  folder: 'marketer',
  trigger: '@Andy',
  aliases: ['marketer'],
  added_at: '2024-01-01T00:00:00.000Z',
  gateway: { rules: [{ match: 'any_message' }] },
};

const MARKETER_JID = 'marketer@g.us';

const VALID_CRON_TASK: ScheduleTaskConfig = {
  id: 'test-weekly-research',
  name: 'Weekly Research',
  description: 'Test research task',
  enabled: true,
  schedule_type: 'cron',
  schedule_value: '0 8 * * 1', // Every Monday at 8am
  context_mode: 'group',
  prompt: 'Do weekly research.',
};

const VALID_INTERVAL_TASK: ScheduleTaskConfig = {
  id: 'test-comment-sweep',
  name: 'Comment Sweep',
  enabled: true,
  schedule_type: 'interval',
  schedule_value: '3600000', // 1 hour
  context_mode: 'isolated',
  prompt: 'Check comments on recent posts.',
};

const VALID_ONCE_TASK: ScheduleTaskConfig = {
  id: 'test-one-time',
  name: 'One-time Task',
  enabled: true,
  schedule_type: 'once',
  schedule_value: '2099-01-01T00:00:00.000Z',
  prompt: 'Do something once.',
};

// ─── Test helpers ─────────────────────────────────────────────────────────────

let tmpDir: string;

function writeTmpSchedule(folder: string, config: AgentScheduleConfig): string {
  const groupDir = path.join(tmpDir, 'groups', folder);
  fs.mkdirSync(groupDir, { recursive: true });
  const filePath = path.join(groupDir, 'schedule.json');
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2));
  return filePath;
}

// Mock GROUPS_DIR to point at our temp directory
vi.mock('./config.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./config.js')>();
  return {
    ...original,
    get GROUPS_DIR() {
      return path.join(tmpDir, 'groups');
    },
    TIMEZONE: 'UTC',
  };
});

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-test-'));
  fs.mkdirSync(path.join(tmpDir, 'groups'), { recursive: true });
  _initTestDatabase();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── configIdToDbId ───────────────────────────────────────────────────────────

describe('configIdToDbId', () => {
  it('prepends bootstrap- prefix', () => {
    expect(configIdToDbId('marketer-weekly-research')).toBe('bootstrap-marketer-weekly-research');
  });

  it('handles simple ids', () => {
    expect(configIdToDbId('task')).toBe('bootstrap-task');
  });
});

// ─── parseScheduleConfig ──────────────────────────────────────────────────────

describe('parseScheduleConfig', () => {
  it('returns null for non-existent file', () => {
    expect(parseScheduleConfig('/does/not/exist/schedule.json')).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    const filePath = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(filePath, 'not json {{{');
    expect(parseScheduleConfig(filePath)).toBeNull();
  });

  it('returns null when tasks field is missing', () => {
    const filePath = path.join(tmpDir, 'no-tasks.json');
    fs.writeFileSync(filePath, JSON.stringify({ version: '1' }));
    expect(parseScheduleConfig(filePath)).toBeNull();
  });

  it('returns null when tasks is not an array', () => {
    const filePath = path.join(tmpDir, 'bad-tasks.json');
    fs.writeFileSync(filePath, JSON.stringify({ version: '1', tasks: {} }));
    expect(parseScheduleConfig(filePath)).toBeNull();
  });

  it('parses valid config successfully', () => {
    const config: AgentScheduleConfig = {
      version: '1',
      tasks: [VALID_CRON_TASK],
    };
    const filePath = writeTmpSchedule('marketer', config);
    const result = parseScheduleConfig(filePath);
    expect(result).not.toBeNull();
    expect(result!.tasks).toHaveLength(1);
    expect(result!.tasks[0].id).toBe('test-weekly-research');
  });

  it('parses config with empty tasks array', () => {
    const filePath = path.join(tmpDir, 'empty.json');
    fs.writeFileSync(filePath, JSON.stringify({ version: '1', tasks: [] }));
    const result = parseScheduleConfig(filePath);
    expect(result).not.toBeNull();
    expect(result!.tasks).toHaveLength(0);
  });
});

// ─── computeNextRun ───────────────────────────────────────────────────────────

describe('computeNextRun', () => {
  describe('cron schedule', () => {
    it('returns a future ISO timestamp for valid cron expression', () => {
      const nextRun = computeNextRun(VALID_CRON_TASK);
      expect(nextRun).not.toBeNull();
      expect(new Date(nextRun!).getTime()).toBeGreaterThan(Date.now() - 1000);
    });

    it('returns null for invalid cron expression', () => {
      const task: ScheduleTaskConfig = { ...VALID_CRON_TASK, schedule_value: 'not a cron' };
      expect(computeNextRun(task)).toBeNull();
    });
  });

  describe('interval schedule', () => {
    it('returns a future ISO timestamp for valid ms interval', () => {
      const before = Date.now();
      const nextRun = computeNextRun(VALID_INTERVAL_TASK);
      expect(nextRun).not.toBeNull();
      const nextMs = new Date(nextRun!).getTime();
      expect(nextMs).toBeGreaterThanOrEqual(before + 3600000 - 1000);
      expect(nextMs).toBeLessThanOrEqual(Date.now() + 3600000 + 1000);
    });

    it('returns null for non-numeric interval', () => {
      const task: ScheduleTaskConfig = { ...VALID_INTERVAL_TASK, schedule_value: 'abc' };
      expect(computeNextRun(task)).toBeNull();
    });

    it('returns null for zero interval', () => {
      const task: ScheduleTaskConfig = { ...VALID_INTERVAL_TASK, schedule_value: '0' };
      expect(computeNextRun(task)).toBeNull();
    });

    it('returns null for negative interval', () => {
      const task: ScheduleTaskConfig = { ...VALID_INTERVAL_TASK, schedule_value: '-1000' };
      expect(computeNextRun(task)).toBeNull();
    });
  });

  describe('once schedule', () => {
    it('returns the ISO timestamp for a valid future date', () => {
      const nextRun = computeNextRun(VALID_ONCE_TASK);
      expect(nextRun).toBe('2099-01-01T00:00:00.000Z');
    });

    it('returns null for invalid date string', () => {
      const task: ScheduleTaskConfig = { ...VALID_ONCE_TASK, schedule_value: 'not-a-date' };
      expect(computeNextRun(task)).toBeNull();
    });
  });

  describe('unknown schedule_type', () => {
    it('returns null for unknown type', () => {
      const task = { ...VALID_CRON_TASK, schedule_type: 'weekly' as ScheduleTaskConfig['schedule_type'] };
      expect(computeNextRun(task)).toBeNull();
    });
  });
});

// ─── bootstrapGroupSchedule ───────────────────────────────────────────────────

describe('bootstrapGroupSchedule', () => {
  it('registers a new cron task from config', () => {
    const config: AgentScheduleConfig = { version: '1', tasks: [VALID_CRON_TASK] };
    writeTmpSchedule('marketer', config);

    const result = bootstrapGroupSchedule('marketer', MARKETER_JID);

    expect(result.registered).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);

    const dbId = configIdToDbId(VALID_CRON_TASK.id);
    const task = getTaskById(dbId);
    expect(task).toBeDefined();
    expect(task!.group_folder).toBe('marketer');
    expect(task!.chat_jid).toBe(MARKETER_JID);
    expect(task!.schedule_type).toBe('cron');
    expect(task!.schedule_value).toBe('0 8 * * 1');
    expect(task!.context_mode).toBe('group');
    expect(task!.status).toBe('active');
    expect(task!.next_run).toBeTruthy();
  });

  it('registers an interval task from config', () => {
    const config: AgentScheduleConfig = { version: '1', tasks: [VALID_INTERVAL_TASK] };
    writeTmpSchedule('marketer', config);

    const result = bootstrapGroupSchedule('marketer', MARKETER_JID);

    expect(result.registered).toBe(1);
    const task = getTaskById(configIdToDbId(VALID_INTERVAL_TASK.id));
    expect(task!.schedule_type).toBe('interval');
    expect(task!.context_mode).toBe('isolated');
  });

  it('registers a once task from config', () => {
    const config: AgentScheduleConfig = { version: '1', tasks: [VALID_ONCE_TASK] };
    writeTmpSchedule('marketer', config);

    const result = bootstrapGroupSchedule('marketer', MARKETER_JID);

    expect(result.registered).toBe(1);
    const task = getTaskById(configIdToDbId(VALID_ONCE_TASK.id));
    expect(task!.schedule_type).toBe('once');
    expect(task!.next_run).toBe('2099-01-01T00:00:00.000Z');
  });

  it('skips tasks that are already registered (idempotent)', () => {
    const config: AgentScheduleConfig = { version: '1', tasks: [VALID_CRON_TASK] };
    writeTmpSchedule('marketer', config);

    // First bootstrap
    const first = bootstrapGroupSchedule('marketer', MARKETER_JID);
    expect(first.registered).toBe(1);
    expect(first.skipped).toBe(0);

    // Second bootstrap — should skip
    const second = bootstrapGroupSchedule('marketer', MARKETER_JID);
    expect(second.registered).toBe(0);
    expect(second.skipped).toBe(1);

    // Only one task in DB
    expect(getAllTasks()).toHaveLength(1);
  });

  it('skips disabled tasks', () => {
    const disabledTask: ScheduleTaskConfig = { ...VALID_CRON_TASK, id: 'disabled-task', enabled: false };
    const config: AgentScheduleConfig = { version: '1', tasks: [disabledTask] };
    writeTmpSchedule('marketer', config);

    const result = bootstrapGroupSchedule('marketer', MARKETER_JID);
    expect(result.disabled).toBe(1);
    expect(result.registered).toBe(0);
    expect(getAllTasks()).toHaveLength(0);
  });

  it('treats missing enabled field as enabled', () => {
    const taskWithoutEnabled: ScheduleTaskConfig = { ...VALID_ONCE_TASK, id: 'no-enabled' };
    delete (taskWithoutEnabled as Partial<ScheduleTaskConfig>).enabled;
    const config: AgentScheduleConfig = { version: '1', tasks: [taskWithoutEnabled] };
    writeTmpSchedule('marketer', config);

    const result = bootstrapGroupSchedule('marketer', MARKETER_JID);
    expect(result.registered).toBe(1);
    expect(result.disabled).toBe(0);
  });

  it('fails tasks with missing required fields', () => {
    const badTask = { id: 'bad-task', name: 'Bad' } as ScheduleTaskConfig; // missing prompt, schedule_type, schedule_value
    const config: AgentScheduleConfig = { version: '1', tasks: [badTask] };
    writeTmpSchedule('marketer', config);

    const result = bootstrapGroupSchedule('marketer', MARKETER_JID);
    expect(result.failed).toBe(1);
    expect(result.registered).toBe(0);
  });

  it('fails tasks with invalid cron expression', () => {
    const badCron: ScheduleTaskConfig = { ...VALID_CRON_TASK, id: 'bad-cron', schedule_value: 'not-a-cron' };
    const config: AgentScheduleConfig = { version: '1', tasks: [badCron] };
    writeTmpSchedule('marketer', config);

    const result = bootstrapGroupSchedule('marketer', MARKETER_JID);
    expect(result.failed).toBe(1);
    expect(getAllTasks()).toHaveLength(0);
  });

  it('handles multiple tasks, registering valid ones and failing invalid ones', () => {
    const badTask: ScheduleTaskConfig = { ...VALID_CRON_TASK, id: 'bad', schedule_value: 'invalid cron' };
    const config: AgentScheduleConfig = { version: '1', tasks: [VALID_CRON_TASK, badTask, VALID_INTERVAL_TASK] };
    writeTmpSchedule('marketer', config);

    const result = bootstrapGroupSchedule('marketer', MARKETER_JID);
    expect(result.registered).toBe(2);
    expect(result.failed).toBe(1);
    expect(getAllTasks()).toHaveLength(2);
  });

  it('returns zeros when no schedule.json exists', () => {
    // No file written — group dir might not even exist
    const result = bootstrapGroupSchedule('nonexistent-group', 'jid@g.us');
    expect(result).toEqual({ registered: 0, skipped: 0, disabled: 0, failed: 0 });
    expect(getAllTasks()).toHaveLength(0);
  });

  it('defaults context_mode to "group" when not specified', () => {
    const noContextTask: ScheduleTaskConfig = { ...VALID_CRON_TASK, id: 'no-context' };
    delete (noContextTask as Partial<ScheduleTaskConfig>).context_mode;
    const config: AgentScheduleConfig = { version: '1', tasks: [noContextTask] };
    writeTmpSchedule('marketer', config);

    bootstrapGroupSchedule('marketer', MARKETER_JID);
    const task = getTaskById(configIdToDbId('no-context'));
    expect(task!.context_mode).toBe('group');
  });

  it('uses "isolated" context_mode when specified', () => {
    const config: AgentScheduleConfig = { version: '1', tasks: [VALID_INTERVAL_TASK] };
    writeTmpSchedule('marketer', config);

    bootstrapGroupSchedule('marketer', MARKETER_JID);
    const task = getTaskById(configIdToDbId(VALID_INTERVAL_TASK.id));
    expect(task!.context_mode).toBe('isolated');
  });

  it('skips already-registered task even if manually created with same db id', () => {
    const dbId = configIdToDbId(VALID_CRON_TASK.id);

    // Manually create a task with the same DB ID
    createTask({
      id: dbId,
      group_folder: 'marketer',
      chat_jid: MARKETER_JID,
      prompt: 'Old prompt',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      context_mode: 'isolated',
      next_run: '2099-01-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const config: AgentScheduleConfig = { version: '1', tasks: [VALID_CRON_TASK] };
    writeTmpSchedule('marketer', config);

    const result = bootstrapGroupSchedule('marketer', MARKETER_JID);
    expect(result.skipped).toBe(1);
    expect(result.registered).toBe(0);

    // Original task should be unchanged
    const task = getTaskById(dbId);
    expect(task!.prompt).toBe('Old prompt');
  });
});

// ─── bootstrapAllAgentSchedules ───────────────────────────────────────────────

describe('bootstrapAllAgentSchedules', () => {
  it('bootstraps tasks for all registered groups with a schedule.json', () => {
    // Set up marketer group with a schedule
    const marketerConfig: AgentScheduleConfig = { version: '1', tasks: [VALID_CRON_TASK] };
    writeTmpSchedule('marketer', marketerConfig);

    // Set up another group with a schedule
    const otherTask: ScheduleTaskConfig = { ...VALID_ONCE_TASK, id: 'other-task' };
    const otherConfig: AgentScheduleConfig = { version: '1', tasks: [otherTask] };
    writeTmpSchedule('other-group', otherConfig);

    // Set up a group WITHOUT a schedule.json
    const noScheduleDir = path.join(tmpDir, 'groups', 'no-schedule');
    fs.mkdirSync(noScheduleDir, { recursive: true });

    const groups: Record<string, RegisteredGroup> = {
      [MARKETER_JID]: MARKETER_GROUP,
      'other@g.us': { name: 'Other', folder: 'other-group', trigger: '@Andy', aliases: ['andy'], added_at: '2024-01-01T00:00:00.000Z', gateway: { rules: [{ match: 'self_mention' }] } },
      'noschedule@g.us': { name: 'No Schedule', folder: 'no-schedule', trigger: '@Andy', aliases: ['andy'], added_at: '2024-01-01T00:00:00.000Z', gateway: { rules: [{ match: 'self_mention' }] } },
    };

    bootstrapAllAgentSchedules(groups);

    const allTasks = getAllTasks();
    // Should have registered 2 tasks (one per group with a schedule)
    expect(allTasks).toHaveLength(2);

    const marketerDbId = configIdToDbId(VALID_CRON_TASK.id);
    const otherDbId = configIdToDbId('other-task');
    expect(getTaskById(marketerDbId)).toBeDefined();
    expect(getTaskById(otherDbId)).toBeDefined();
  });

  it('skips groups that have a schedule.json but are not registered', () => {
    // Only write the schedule, don't register the group
    const config: AgentScheduleConfig = { version: '1', tasks: [VALID_CRON_TASK] };
    writeTmpSchedule('unregistered-group', config);

    // Empty registered groups — nothing is registered
    bootstrapAllAgentSchedules({});

    expect(getAllTasks()).toHaveLength(0);
  });

  it('is idempotent across multiple calls', () => {
    const config: AgentScheduleConfig = { version: '1', tasks: [VALID_CRON_TASK] };
    writeTmpSchedule('marketer', config);

    const groups: Record<string, RegisteredGroup> = {
      [MARKETER_JID]: MARKETER_GROUP,
    };

    bootstrapAllAgentSchedules(groups);
    bootstrapAllAgentSchedules(groups);
    bootstrapAllAgentSchedules(groups);

    // Should still only have one task registered
    expect(getAllTasks()).toHaveLength(1);
  });

  it('handles empty registered groups gracefully', () => {
    bootstrapAllAgentSchedules({});
    expect(getAllTasks()).toHaveLength(0);
  });

  it('handles groups dir with no schedule files', () => {
    // Create directories without schedule.json
    fs.mkdirSync(path.join(tmpDir, 'groups', 'main'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'groups', 'dobby'), { recursive: true });

    const groups: Record<string, RegisteredGroup> = {
      'main@g.us': { name: 'Main', folder: 'main', trigger: 'always', aliases: ['main'], added_at: '2024-01-01T00:00:00.000Z', gateway: { rules: [{ match: 'any_message' }] } },
    };

    bootstrapAllAgentSchedules(groups);
    expect(getAllTasks()).toHaveLength(0);
  });

  it('registers tasks for multiple groups in a single call', () => {
    const task1: ScheduleTaskConfig = { ...VALID_CRON_TASK, id: 'marketer-weekly' };
    const task2: ScheduleTaskConfig = { ...VALID_INTERVAL_TASK, id: 'other-interval' };

    writeTmpSchedule('marketer', { version: '1', tasks: [task1] });
    writeTmpSchedule('other', { version: '1', tasks: [task2] });

    const groups: Record<string, RegisteredGroup> = {
      [MARKETER_JID]: MARKETER_GROUP,
      'other@g.us': { name: 'Other', folder: 'other', trigger: '@Andy', aliases: ['andy'], added_at: '2024-01-01T00:00:00.000Z', gateway: { rules: [{ match: 'self_mention' }] } },
    };

    bootstrapAllAgentSchedules(groups);

    expect(getAllTasks()).toHaveLength(2);
    expect(getTaskById(configIdToDbId('marketer-weekly'))?.group_folder).toBe('marketer');
    expect(getTaskById(configIdToDbId('other-interval'))?.group_folder).toBe('other');
  });
});

// ─── Integration: real marketer schedule.json ─────────────────────────────────

describe('real marketer schedule.json', () => {
  it('is parseable and has valid structure', async () => {
    const realSchedulePath = path.resolve(
      process.cwd(),
      'groups/marketer/schedule.json',
    );

    if (!fs.existsSync(realSchedulePath)) {
      // File may not exist in all test environments
      return;
    }

    const raw = JSON.parse(fs.readFileSync(realSchedulePath, 'utf-8')) as AgentScheduleConfig;
    expect(raw.version).toBe('1');
    expect(Array.isArray(raw.tasks)).toBe(true);
    expect(raw.tasks.length).toBeGreaterThan(0);

    for (const task of raw.tasks) {
      expect(task.id).toBeTruthy();
      expect(task.name).toBeTruthy();
      expect(task.prompt).toBeTruthy();
      expect(['cron', 'interval', 'once']).toContain(task.schedule_type);
      expect(task.schedule_value).toBeTruthy();

      if (task.schedule_type === 'cron') {
        // Should parse without throwing
        const { CronExpressionParser } = await import('cron-parser');
        expect(() => CronExpressionParser.parse(task.schedule_value, { tz: 'UTC' })).not.toThrow();
      }
      if (task.schedule_type === 'interval') {
        const ms = parseInt(task.schedule_value, 10);
        expect(ms).toBeGreaterThan(0);
      }
    }
  });

  it('contains only the approved marketer recurring tasks', async () => {
    const realSchedulePath = path.resolve(
      process.cwd(),
      'groups/marketer/schedule.json',
    );

    if (!fs.existsSync(realSchedulePath)) {
      return;
    }

    const raw = JSON.parse(fs.readFileSync(realSchedulePath, 'utf-8')) as AgentScheduleConfig;
    expect(raw.tasks.map((task) => task.id)).toEqual([
      'marketer-daily-sns-trend-check',
      'marketer-weekly-content-planning',
      'marketer-comment-sweep',
    ]);
  });
});
