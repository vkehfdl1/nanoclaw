import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { spawn } from 'child_process';
import fs from 'fs';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  SECONDBRAIN_DIR: '/tmp/nanoclaw-test-secondbrain',
  TIMEZONE: 'America/Los_Angeles',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      cpSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn((_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
      if (cb) cb(null);
      return new EventEmitter();
    }),
  };
});

import { runContainerAgent, runTaskSnippet, ContainerOutput } from './container-runner.js';
import type { RegisteredGroup } from './types.js';
import { validateAdditionalMounts } from './mount-security.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  aliases: ['andy'],
  added_at: new Date().toISOString(),
  gateway: { rules: [{ match: 'self_mention' }] },
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(proc: ReturnType<typeof createFakeProcess>, output: ContainerOutput) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });

  it('mounts global CLAUDE context for main agents', async () => {
    vi.mocked(fs.existsSync).mockImplementation((filePath) => (
      String(filePath) === '/tmp/nanoclaw-test-groups/global'
    ));

    const resultPromise = runContainerAgent(
      testGroup,
      {
        ...testInput,
        isMain: true,
      },
      () => {},
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'ok',
      newSessionId: 'session-global',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');

    const spawnArgs = vi.mocked(spawn).mock.calls.at(-1)?.[1] as string[];
    expect(spawnArgs).toContain('/tmp/nanoclaw-test-groups/global:/workspace/global:ro');
  });

  it('adds tmpfs overlays for additional mount excludePatterns', async () => {
    vi.mocked(fs.existsSync).mockImplementation((filePath) => {
      const p = String(filePath);
      return p.endsWith('/node_modules') ||
        p.endsWith('/.venv') ||
        p.endsWith('/.git/objects');
    });

    vi.mocked(validateAdditionalMounts).mockReturnValueOnce([
      {
        hostPath: '/host/repos/autorag-research',
        containerPath: '/workspace/extra/autorag-research',
        readonly: true,
        excludePatterns: ['node_modules', '.venv', '.git/objects', '../bad'],
      },
    ]);

    const groupWithMounts: RegisteredGroup = {
      ...testGroup,
      containerConfig: {
        additionalMounts: [{ hostPath: '/ignored/by/mock' }],
      },
    };

    const resultPromise = runContainerAgent(
      groupWithMounts,
      testInput,
      () => {},
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'ok',
      newSessionId: 'session-tmpfs',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');

    const spawnArgs = vi.mocked(spawn).mock.calls.at(-1)?.[1] as string[];
    const tmpfsPaths: string[] = [];
    for (let i = 0; i < spawnArgs.length; i += 1) {
      if (spawnArgs[i] === '--tmpfs') {
        tmpfsPaths.push(spawnArgs[i + 1]);
      }
    }

    expect(tmpfsPaths).toContain('/workspace/extra/autorag-research/node_modules');
    expect(tmpfsPaths).toContain('/workspace/extra/autorag-research/.venv');
    expect(tmpfsPaths).toContain('/workspace/extra/autorag-research/.git/objects');
    expect(tmpfsPaths.some((p) => p.includes('../bad'))).toBe(false);
  });

  it('refreshes the per-group agent runner snapshot from the latest source', async () => {
    vi.mocked(fs.existsSync).mockImplementation((filePath) => (
      String(filePath).endsWith('/container/agent-runner/src')
    ));

    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'ok',
      newSessionId: 'session-sync',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(vi.mocked(fs.cpSync)).toHaveBeenCalledWith(
      expect.stringMatching(/container\/agent-runner\/src$/),
      '/tmp/nanoclaw-test-data/sessions/test-group/agent-runner-src',
      expect.objectContaining({ recursive: true, force: true }),
    );
  });

  it('runs javascript task snippets with node as the container entrypoint', async () => {
    const resultPromise = runTaskSnippet(testGroup, {
      taskId: 'snippet-task',
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      scheduleType: 'cron',
      scheduleValue: '*/15 * * * *',
      snippet: 'return false;',
      snippetLanguage: 'javascript',
      isMain: false,
    });

    fakeProc.stdout.push('{"ok":true,"should_run":false,"payload":false}\n');
    fakeProc.emit('close', 0);

    const result = await resultPromise;
    expect(result).toEqual({ status: 'skip', payload: false });

    const spawnArgs = vi.mocked(spawn).mock.calls.at(-1)?.[1] as string[];
    expect(spawnArgs).toContain('--entrypoint');
    expect(spawnArgs).toContain('node');
  });
});
