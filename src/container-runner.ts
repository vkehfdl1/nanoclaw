/**
 * Container Runner for NanoClaw
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, exec, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  SECONDBRAIN_DIR,
  TIMEZONE,
} from './config.js';
import { readEnvFile } from './env.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { CONTAINER_RUNTIME_BIN, readonlyMountArgs, stopContainer } from './container-runtime.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  threadTs?: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

export interface TaskSnippetInput {
  taskId: string;
  groupFolder: string;
  chatJid: string;
  scheduleType: 'cron' | 'interval' | 'once';
  scheduleValue: string;
  snippet: string;
  snippetLanguage?: 'javascript' | 'bash' | null;
  isMain: boolean;
}

export interface TaskSnippetOutput {
  status: 'pass' | 'skip' | 'error';
  payload?: unknown;
  error?: string;
  traceback?: string;
  logFile?: string;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
  excludePatterns?: string[];
}

function normalizeExcludePattern(pattern: string): string | null {
  const trimmed = pattern.trim().replace(/^\/+/, '');
  if (!trimmed) return null;

  const normalized = path.posix.normalize(trimmed);
  if (
    normalized === '.' ||
    normalized.startsWith('../') ||
    normalized.includes('/../')
  ) {
    return null;
  }

  return normalized;
}

function getTmpfsOverlayPaths(mount: VolumeMount): string[] {
  if (!mount.excludePatterns || mount.excludePatterns.length === 0) return [];

  const overlays = new Set<string>();
  for (const rawPattern of mount.excludePatterns) {
    const pattern = normalizeExcludePattern(rawPattern);
    if (!pattern) continue;
    // Docker cannot create tmpfs mountpoints on top of a read-only bind mount
    // when the target path does not already exist. Skip absent paths.
    const hostOverlayPath = path.join(mount.hostPath, pattern);
    if (!fs.existsSync(hostOverlayPath)) continue;
    overlays.add(path.posix.join(mount.containerPath, pattern));
  }
  return [...overlays];
}

function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);

  if (isMain) {
    // Main gets the project root read-only. Writable paths the agent needs
    // (group folder, IPC, .claude/) are mounted separately below.
    // Read-only prevents the agent from modifying host application code
    // (src/, dist/, package.json, etc.) which would bypass the sandbox
    // entirely on next restart.
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

  }

  // Shared global CLAUDE.md context for all agents.
  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    mounts.push({
      hostPath: globalDir,
      containerPath: '/workspace/global',
      readonly: true,
    });
  }

  // Per-group Claude sessions directory (isolated from other groups)
  // Each group gets their own .claude/ to prevent cross-group session access
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(settingsFile, JSON.stringify({
      env: {
        // Enable agent swarms (subagent orchestration)
        // https://code.claude.com/docs/en/agent-teams#orchestrate-teams-of-claude-code-sessions
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
        // Load CLAUDE.md from additional mounted directories
        // https://code.claude.com/docs/en/memory#load-memory-from-additional-directories
        CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
        // Enable Claude's memory feature (persists user preferences between sessions)
        // https://code.claude.com/docs/en/memory#manage-auto-memory
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
      },
    }, null, 2) + '\n');
  }

  // Sync built-in and host-level skills into each group's .claude/skills/
  const skillsDst = path.join(groupSessionsDir, 'skills');
  const homeDir = process.env.HOME || os.homedir();
  const skillSources = [
    path.join(process.cwd(), 'container', 'skills'),
    path.join(homeDir, '.agent', 'skills'),
    path.join(homeDir, '.agents', 'skills'),
  ];
  const seenSources = new Set<string>();

  for (const sourcePath of skillSources) {
    if (!fs.existsSync(sourcePath)) continue;

    let dedupeKey = sourcePath;
    try {
      dedupeKey = fs.realpathSync(sourcePath);
    } catch {
      // Keep unresolved path if realpath fails
    }
    if (seenSources.has(dedupeKey)) continue;
    seenSources.add(dedupeKey);

    for (const skillDir of fs.readdirSync(sourcePath)) {
      const srcDir = path.join(sourcePath, skillDir);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(srcDir);
      } catch (err) {
        logger.warn(
          { sourcePath, skillDir, err },
          'Skipping unreadable skill entry during skill sync',
        );
        continue;
      }
      if (!stat.isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      try {
        fs.cpSync(srcDir, dstDir, { recursive: true });
      } catch (err) {
        logger.warn(
          { sourcePath, skillDir, err },
          'Failed to copy skill entry during skill sync',
        );
      }
    }
  }
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'responses'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // SecondBrain shared knowledge base (read-write for all agents)
  fs.mkdirSync(path.join(SECONDBRAIN_DIR, 'inbox'), { recursive: true });
  mounts.push({
    hostPath: SECONDBRAIN_DIR,
    containerPath: '/workspace/secondbrain',
    readonly: false,
  });

  // Copy agent-runner source into a per-group writable location so agents
  // can customize it (add tools, change behavior) without affecting other
  // groups. Recompiled on container startup via entrypoint.sh.
  const agentRunnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src');
  const groupAgentRunnerDir = path.join(DATA_DIR, 'sessions', group.folder, 'agent-runner-src');
  if (!fs.existsSync(groupAgentRunnerDir) && fs.existsSync(agentRunnerSrc)) {
    fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
  }
  mounts.push({
    hostPath: groupAgentRunnerDir,
    containerPath: '/app/src',
    readonly: false,
  });

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

/**
 * Read allowed secrets from .env for passing to the container via stdin.
 * Secrets are never written to disk or mounted as files.
 */
function readSecrets(): Record<string, string> {
  return readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);
}

function buildContainerArgs(
  group: RegisteredGroup,
  mounts: VolumeMount[],
  containerName: string,
  commandArgs?: string[],
  entrypoint?: string,
): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Set container timezone for local-time parsing/rendering consistency
  args.push('-e', `TZ=${TIMEZONE}`);

  // Pass model override if configured (per-group takes precedence)
  const extraEnv = readEnvFile(['CLAUDE_MODEL', 'GITHUB_TOKEN']);
  const groupModel = group.containerConfig?.model?.trim();
  const selectedModel = groupModel || extraEnv.CLAUDE_MODEL;
  if (selectedModel) {
    args.push('-e', `CLAUDE_MODEL=${selectedModel}`);
  }
  if (extraEnv.GITHUB_TOKEN) {
    args.push('-e', `GITHUB_TOKEN=${extraEnv.GITHUB_TOKEN}`);
  }

  // Per-group environment variables (e.g., GITHUB_REPO, SLACK_CHANNEL_ID for PM agents).
  // These are injected directly — do not put secrets here; use .env for secrets.
  if (group.containerConfig?.envVars) {
    for (const [key, value] of Object.entries(group.containerConfig.envVars)) {
      args.push('-e', `${key}=${value}`);
    }
  }

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  for (const mount of mounts) {
    for (const overlayPath of getTmpfsOverlayPaths(mount)) {
      args.push('--tmpfs', overlayPath);
    }
  }

  if (entrypoint) {
    args.push('--entrypoint', entrypoint);
  }

  args.push(CONTAINER_IMAGE);
  if (commandArgs && commandArgs.length > 0) {
    args.push(...commandArgs);
  }

  return args;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = buildVolumeMounts(group, input.isMain);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-${safeName}-${Date.now()}`;
  const containerArgs = buildContainerArgs(group, mounts, containerName);

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    // Pass secrets via stdin (never written to disk or mounted as files)
    input.secrets = readSecrets();
    container.stdin.write(JSON.stringify(input));
    container.stdin.end();
    // Remove secrets from input so they don't appear in logs
    delete input.secrets;

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break; // Incomplete pair, wait for more data

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            // Activity detected — reset the hard timeout
            resetTimeout();
            // Call onOutput for all markers (including null results)
            // so idle timers start even for "silent" query completions.
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error({ group: group.name, containerName }, 'Container timeout, stopping gracefully');
      exec(stopContainer(containerName), { timeout: 15000 }, (err) => {
        if (err) {
          logger.warn({ group: group.name, containerName, err }, 'Graceful stop failed, force killing');
          container.kill('SIGKILL');
        }
      });
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the timeout whenever there's activity (streaming output)
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    container.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(timeoutLog, [
          `=== Container Run Log (TIMEOUT) ===`,
          `Timestamp: ${new Date().toISOString()}`,
          `Group: ${group.name}`,
          `Container: ${containerName}`,
          `Duration: ${duration}ms`,
          `Exit Code: ${code}`,
          `Had Streaming Output: ${hadStreamingOutput}`,
        ].join('\n'));

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // container being reaped after the idle period expired.
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          });
          return;
        }

        logger.error(
          { group: group.name, containerName, duration, code },
          'Container timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose = process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        logLines.push(
          `=== Input ===`,
          JSON.stringify(input, null, 2),
          ``,
          `=== Container Args ===`,
          containerArgs.join(' '),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr,
            stdout,
            logFile,
          },
          'Container exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle, return completion marker
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Container completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse container output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error({ group: group.name, containerName, error: err }, 'Container spawn error');
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}

const SNIPPET_RUNNER_SCRIPT = [
  '#!/usr/bin/env node',
  "'use strict';",
  "const fs = require('fs');",
  '',
  'function emit(payload) {',
  "  process.stdout.write(JSON.stringify(payload) + '\\n');",
  '}',
  '',
  'function toJsonSafe(value) {',
  '  try { JSON.stringify(value); return value; }',
  '  catch { return String(value); }',
  '}',
  '',
  'function main() {',
  '  const args = process.argv.slice(2);',
  '  let snippetPath, contextPath;',
  '  for (let i = 0; i < args.length; i++) {',
  "    if (args[i] === '--snippet') snippetPath = args[i + 1];",
  "    if (args[i] === '--context') contextPath = args[i + 1];",
  '  }',
  '  if (!snippetPath || !contextPath) {',
  "    emit({ ok: false, error: 'Missing --snippet or --context argument' });",
  '    process.exit(1);',
  '  }',
  '',
  '  try {',
  "    const context = JSON.parse(fs.readFileSync(contextPath, 'utf-8'));",
  "    const snippet = fs.readFileSync(snippetPath, 'utf-8').trim();",
  '    if (!snippet) {',
  '      emit({ ok: true, should_run: false, payload: false });',
  '      return;',
  '    }',
  '',
  "    const fn = new Function('context', 'require',",
  "      'return (async () => { ' + snippet + ' })();'",
  '    );',
  '    Promise.resolve(fn(context, require)).then((result) => {',
  '      const shouldRun = !(result === false);',
  '      emit({ ok: true, should_run: shouldRun, payload: toJsonSafe(result) });',
  '    }).catch((err) => {',
  "      emit({ ok: false, error: String(err), traceback: err.stack || '' });",
  '    });',
  '  } catch (err) {',
  "    emit({ ok: false, error: String(err), traceback: err.stack || '' });",
  '  }',
  '}',
  '',
  'main();',
].join('\n');

interface SnippetRunnerResponse {
  ok: boolean;
  should_run?: boolean;
  payload?: unknown;
  error?: string;
  traceback?: string;
}

// Bash snippet runner — uses Node.js to wrap the bash execution and produce JSON output.
// This avoids complex shell quoting inside a JS string literal.
const BASH_SNIPPET_RUNNER_SCRIPT = [
  '#!/usr/bin/env node',
  "'use strict';",
  "const { execSync } = require('child_process');",
  "const fs = require('fs');",
  '',
  'function emit(payload) {',
  "  process.stdout.write(JSON.stringify(payload) + '\\n');",
  '}',
  '',
  'const snippetPath = process.argv[2];',
  'const contextPath = process.argv[3];',
  'if (!snippetPath || !contextPath) {',
  "  emit({ ok: false, error: 'Missing snippet or context path' });",
  '  process.exit(1);',
  '}',
  '',
  'try {',
  "  const env = { ...process.env, NANOCLAW_CONTEXT_FILE: contextPath };",
  '  let output;',
  '  try {',
  "    output = execSync('bash ' + JSON.stringify(snippetPath), {",
  '      env,',
  '      encoding: "utf-8",',
  '      timeout: 40000,',
  '      stdio: ["pipe", "pipe", "pipe"],',
  '    }).trim();',
  '  } catch (err) {',
  '    const stderr = err.stderr ? err.stderr.toString().slice(-500) : String(err);',
  "    emit({ ok: false, error: stderr, traceback: '' });",
  '    process.exit(0);',
  '  }',
  '',
  "  if (output === 'false') {",
  '    emit({ ok: true, should_run: false, payload: false });',
  '    process.exit(0);',
  '  }',
  '',
  '  let payload;',
  '  try { payload = JSON.parse(output); } catch { payload = output; }',
  '  emit({ ok: true, should_run: true, payload: payload });',
  '} catch (err) {',
  "  emit({ ok: false, error: String(err), traceback: err.stack || '' });",
  '}',
].join('\n');

function parseSnippetRunnerResponse(stdout: string): SnippetRunnerResponse | null {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]) as SnippetRunnerResponse;
      if (parsed && typeof parsed === 'object' && typeof parsed.ok === 'boolean') {
        return parsed;
      }
    } catch {
      // keep scanning upward for the JSON line
    }
  }
  return null;
}

function writeSnippetLog(
  groupDir: string,
  taskId: string,
  snippet: string,
  context: object,
  stdout: string,
  stderr: string,
  error?: string,
): string {
  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = path.join(logsDir, `snippet-${taskId}-${timestamp}.log`);
  const lines = [
    '=== Task Snippet Run ===',
    `Timestamp: ${new Date().toISOString()}`,
    `Task ID: ${taskId}`,
    error ? `Error: ${error}` : '',
    '',
    '=== Context ===',
    JSON.stringify(context, null, 2),
    '',
    '=== Snippet ===',
    snippet,
    '',
    '=== Stdout ===',
    stdout || '(empty)',
    '',
    '=== Stderr ===',
    stderr || '(empty)',
    '',
  ].filter(Boolean);
  fs.writeFileSync(logFile, lines.join('\n'));
  return logFile;
}

export async function runTaskSnippet(
  group: RegisteredGroup,
  input: TaskSnippetInput,
): Promise<TaskSnippetOutput> {
  const lang = input.snippetLanguage || 'javascript';
  if (lang !== 'javascript' && lang !== 'bash') {
    return {
      status: 'error',
      error: `Unsupported snippet language: ${lang}`,
    };
  }

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const runtimeHostDir = path.join(groupDir, '.nanoclaw', 'snippet-runtime');
  fs.mkdirSync(runtimeHostDir, { recursive: true });

  // Write the appropriate runner script
  const runnerFileName = lang === 'bash' ? 'run_snippet.sh' : 'run_snippet.js';
  const runnerScript = lang === 'bash' ? BASH_SNIPPET_RUNNER_SCRIPT : SNIPPET_RUNNER_SCRIPT;
  const runnerHostPath = path.join(runtimeHostDir, runnerFileName);
  // Always overwrite to pick up runner changes
  fs.writeFileSync(runnerHostPath, runnerScript, { mode: 0o755 });

  const ext = lang === 'bash' ? '.sh' : '.js';
  const unique = `${input.taskId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const snippetHostPath = path.join(runtimeHostDir, `${unique}${ext}`);
  const contextHostPath = path.join(runtimeHostDir, `${unique}.context.json`);
  const runtimeContainerDir = `/workspace/group/.nanoclaw/snippet-runtime`;
  const snippetContainerPath = `${runtimeContainerDir}/${unique}${ext}`;
  const contextContainerPath = `${runtimeContainerDir}/${unique}.context.json`;

  const context = {
    task_id: input.taskId,
    group_folder: input.groupFolder,
    chat_jid: input.chatJid,
    schedule_type: input.scheduleType,
    schedule_value: input.scheduleValue,
    run_started_at: new Date().toISOString(),
  };
  fs.writeFileSync(snippetHostPath, input.snippet);
  fs.writeFileSync(contextHostPath, JSON.stringify(context, null, 2));

  const mounts = buildVolumeMounts(group, input.isMain);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-snippet-${safeName}-${Date.now()}`;

  const commandArgs = lang === 'bash'
    ? [
        `${runtimeContainerDir}/${runnerFileName}`,
        snippetContainerPath,
        contextContainerPath,
      ]
    : [
        `${runtimeContainerDir}/${runnerFileName}`,
        '--snippet',
        snippetContainerPath,
        '--context',
        contextContainerPath,
      ];
  const containerArgs = buildContainerArgs(
    group,
    mounts,
    containerName,
    commandArgs,
    'node',
  );

  const timeoutMs = 45_000;

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      exec(stopContainer(containerName), { timeout: 15000 }, (err) => {
        if (err) {
          container.kill('SIGKILL');
        }
      });
    }, timeoutMs);

    container.stdout.on('data', (data) => {
      const chunk = data.toString();
      if (stdoutTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
      if (chunk.length > remaining) {
        stdout += chunk.slice(0, remaining);
        stdoutTruncated = true;
      } else {
        stdout += chunk;
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
      } else {
        stderr += chunk;
      }
    });

    container.on('close', (code) => {
      clearTimeout(timeout);

      try {
        fs.unlinkSync(snippetHostPath);
      } catch {
        // ignore cleanup errors
      }
      try {
        fs.unlinkSync(contextHostPath);
      } catch {
        // ignore cleanup errors
      }

      if (timedOut) {
        const error = `Snippet runner timed out after ${timeoutMs}ms`;
        const logFile = writeSnippetLog(
          groupDir,
          input.taskId,
          input.snippet,
          context,
          stdout,
          stderr,
          error,
        );
        resolve({ status: 'error', error, logFile });
        return;
      }

      const parsed = parseSnippetRunnerResponse(stdout);
      if (!parsed) {
        const error = `Failed to parse snippet runner output (exit ${code ?? 'unknown'})`;
        const logFile = writeSnippetLog(
          groupDir,
          input.taskId,
          input.snippet,
          context,
          stdout,
          stderr,
          error,
        );
        resolve({ status: 'error', error, logFile });
        return;
      }

      if (!parsed.ok) {
        const error = parsed.error || 'Snippet execution failed';
        const logFile = writeSnippetLog(
          groupDir,
          input.taskId,
          input.snippet,
          context,
          stdout,
          stderr,
          error,
        );
        resolve({
          status: 'error',
          error,
          traceback: parsed.traceback,
          logFile,
        });
        return;
      }

      if (parsed.should_run === false) {
        resolve({ status: 'skip', payload: false });
        return;
      }

      resolve({ status: 'pass', payload: parsed.payload });
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      const error = `Snippet runner failed to start: ${err.message}`;
      const logFile = writeSnippetLog(
        groupDir,
        input.taskId,
        input.snippet,
        context,
        stdout,
        stderr,
        error,
      );
      resolve({ status: 'error', error, logFile });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
