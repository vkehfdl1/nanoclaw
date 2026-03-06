import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SCHEDULER_POLL_INTERVAL } from './config.js';
import {
  _initTestDatabase,
  createTask,
  getTaskById,
  setRegisteredGroup,
} from './db.js';
import {
  _runTaskForTests,
  _resetSchedulerLoopForTests,
  startSchedulerLoop,
} from './task-scheduler.js';
import type { RegisteredGroup } from './types.js';

const MARKETER_GROUP: RegisteredGroup = {
  name: 'Marketer',
  folder: 'marketer',
  trigger: '@marketer',
  aliases: ['marketer'],
  added_at: '2024-01-01T00:00:00.000Z',
  gateway: { rules: [{ match: 'self_mention' }] },
};

describe('task scheduler', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pauses due tasks with invalid group folders to prevent retry churn', async () => {
    createTask({
      id: 'task-invalid-folder',
      group_folder: '../../outside',
      chat_jid: 'bad@g.us',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('task-invalid-folder');
    expect(task?.status).toBe('paused');
  });

  it('does not enqueue the same due task again while it is already running', async () => {
    createTask({
      id: 'task-running-claim',
      group_folder: 'marketer',
      chat_jid: 'slack:C111',
      prompt: 'run once',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn();

    startSchedulerLoop({
      registeredGroups: () => ({ 'slack:C111': MARKETER_GROUP }),
      queue: { enqueueTask } as any,
      onProcess: () => {},
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(enqueueTask).toHaveBeenCalledTimes(1);
    expect(getTaskById('task-running-claim')?.status).toBe('running');

    await vi.advanceTimersByTimeAsync(SCHEDULER_POLL_INTERVAL + 10);
    expect(enqueueTask).toHaveBeenCalledTimes(1);
    expect(getTaskById('task-running-claim')?.status).toBe('running');
  });

  it('skips task silently when code snippet returns false', async () => {
    setRegisteredGroup('slack:C111', MARKETER_GROUP);
    createTask({
      id: 'task-snippet-skip',
      group_folder: 'marketer',
      chat_jid: 'slack:C111',
      prompt: 'Send report',
      code_snippet: 'return false',
      snippet_language: 'javascript',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const runAgent = vi.fn(async () => ({
      status: 'success' as const,
      result: null,
    }));
    const runSnippet = vi.fn(async () => ({
      status: 'skip' as const,
      payload: false,
    }));
    const sendMessage = vi.fn(async () => {});

    await _runTaskForTests(getTaskById('task-snippet-skip')!, {
      registeredGroups: () => ({ 'slack:C111': MARKETER_GROUP }),
      queue: { closeStdin: vi.fn(), notifyIdle: vi.fn() } as any,
      onProcess: () => {},
      runAgent,
      runSnippet,
    });

    expect(runSnippet).toHaveBeenCalledTimes(1);
    expect(runAgent).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    const task = getTaskById('task-snippet-skip');
    expect(task?.status).toBe('completed');
    expect(task?.last_result).toContain('Skipped by code snippet');
  });

  it('calls agent immediately to self-fix snippet errors, then runs task when fixed', async () => {
    setRegisteredGroup('slack:C111', MARKETER_GROUP);
    createTask({
      id: 'task-snippet-autofix',
      group_folder: 'marketer',
      chat_jid: 'slack:C111',
      prompt: 'Summarize updates',
      code_snippet: 'return context.missing.value',
      snippet_language: 'javascript',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const runSnippet = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'error' as const,
        error: "TypeError: Cannot read properties of undefined (reading 'value')",
        logFile: '/workspace/group/logs/snippet-error.log',
      })
      .mockResolvedValueOnce({
        status: 'pass' as const,
        payload: { count: 2, items: ['a', 'b'] },
      });

    const runAgent = vi.fn(
      async (
        _group: RegisteredGroup,
        input: { prompt: string },
        _onProcess: unknown,
        onOutput?: (output: { status: 'success' | 'error'; result: string | null }) => Promise<void>,
      ) => {
        if (input.prompt.includes('snippet_auto_fix_json')) {
          await onOutput?.({
            status: 'success',
            result: JSON.stringify({
              code_snippet: 'return {count: 2, items: ["a", "b"]}',
              snippet_language: 'javascript',
            }),
          });
          return { status: 'success' as const, result: null };
        }

        await onOutput?.({ status: 'success', result: 'Task completed.' });
        return { status: 'success' as const, result: null };
      },
    );

    const sendMessage = vi.fn(async () => {});

    await _runTaskForTests(getTaskById('task-snippet-autofix')!, {
      registeredGroups: () => ({ 'slack:C111': MARKETER_GROUP }),
      queue: { closeStdin: vi.fn(), notifyIdle: vi.fn() } as any,
      onProcess: () => {},
      runAgent,
      runSnippet,
    });

    expect(runSnippet).toHaveBeenCalledTimes(2);
    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(sendMessage).not.toHaveBeenCalled();

    const updated = getTaskById('task-snippet-autofix');
    expect(updated?.code_snippet).toContain('return {count: 2');
    expect(updated?.status).toBe('completed');
    expect(updated?.last_result).toContain('Task completed.');

    const secondRunPrompt = runAgent.mock.calls[1]?.[1]?.prompt as string;
    expect(secondRunPrompt).toContain('[SNIPPET_GATE_PAYLOAD]');
    expect(secondRunPrompt).toContain('"count": 2');
  });
});
