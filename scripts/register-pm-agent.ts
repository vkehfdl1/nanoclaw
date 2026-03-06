#!/usr/bin/env tsx
/**
 * register-pm-agent.ts
 *
 * Registers a new PM agent scoped to a specific Slack channel and GitHub project.
 *
 * Usage:
 *   tsx scripts/register-pm-agent.ts \
 *     --name my-project \
 *     --channel C1234567890 \
 *     --repo owner/my-repo \
 *     --codebase /path/to/codebase \
 *     [--secondbrain /path/to/secondbrain/inbox] \
 *     [--bot-name "@PM-MyProject"] \
 *     [--model claude-opus-4-6]
 *
 * After running this script:
 *   1. The group is registered in the database and will be active on next restart.
 *   2. Invite the Slack bot to the channel if you haven't already.
 *   3. @mention the bot in the channel to start interacting.
 */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import {
  DEFAULT_PM_EXCLUDE_PATTERNS,
  deriveRepoAlias,
} from '../src/pm-agent-config.ts';
import { DEFAULT_PM_AGENT_MODEL } from '../src/pm-agent-runtime.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const GROUPS_DIR = path.join(PROJECT_ROOT, 'groups');
const TEMPLATES_DIR = path.join(PROJECT_ROOT, 'templates', 'pm-agent');
const STORE_DIR = path.join(PROJECT_ROOT, 'store');
const DB_PATH = path.join(STORE_DIR, 'messages.db');

// ─── Argument Parsing ────────────────────────────────────────────────────────

function parseArgs(): {
  displayName: string;
  slug: string;
  channel: string;
  repo: string;
  codebase: string;
  secondbrain: string | null;
  botName: string;
  model: string;
} {
  const args = process.argv.slice(2);
  const get = (flag: string): string | null => {
    const idx = args.indexOf(flag);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
  };

  const name = get('--name');
  const channel = get('--channel');
  const repo = get('--repo');
  const codebase = get('--codebase');

  if (!name || !channel || !repo || !codebase) {
    console.error(
      `Usage: tsx scripts/register-pm-agent.ts \\\n` +
        `  --name <project-name> \\\n` +
        `  --channel <SLACK_CHANNEL_ID> \\\n` +
        `  --repo <owner/repo> \\\n` +
        `  --codebase </path/to/codebase> \\\n` +
        `  [--secondbrain </path/to/secondbrain/inbox>] \\\n` +
        `  [--bot-name "@PM-MyProject"] \\\n` +
        `  [--model claude-opus-4-6]`,
    );
    process.exit(1);
  }

  // Validate channel ID format (Slack channel IDs start with C, G, or D)
  if (!/^[CGDW][A-Z0-9]{8,}$/i.test(channel)) {
    console.warn(
      `⚠️  Warning: "${channel}" doesn't look like a Slack channel ID.\n` +
        `   Slack channel IDs start with C (public), G (private), or D (DM) followed by alphanumeric chars.\n` +
        `   You can find channel IDs by right-clicking a channel → View channel details → bottom of modal.\n`,
    );
  }

  // Validate repo format
  if (!/^[^/]+\/[^/]+$/.test(repo)) {
    console.error(`❌  Invalid --repo format. Expected "owner/repo", got: "${repo}"`);
    process.exit(1);
  }

  const resolvedCodebase = path.resolve(codebase.replace(/^~/, process.env.HOME || '~'));
  if (!fs.existsSync(resolvedCodebase)) {
    console.error(`❌  Codebase path does not exist: ${resolvedCodebase}`);
    process.exit(1);
  }
  try {
    const output = execFileSync(
      'git',
      ['-C', resolvedCodebase, 'rev-parse', '--is-inside-work-tree'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    if (output !== 'true') {
      throw new Error(`unexpected git rev-parse output: ${output}`);
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(
      `❌  Codebase path is not a git working tree: ${resolvedCodebase}\n` +
        `   Details: ${detail}`,
    );
    process.exit(1);
  }

  const secondbrain = get('--secondbrain');
  let resolvedSecondBrain: string | null = null;
  if (secondbrain) {
    resolvedSecondBrain = path.resolve(secondbrain.replace(/^~/, process.env.HOME || '~'));
    if (!fs.existsSync(resolvedSecondBrain)) {
      console.warn(
        `⚠️  SecondBrain path does not exist yet: ${resolvedSecondBrain}\n` +
          `   It will be created automatically when the PM agent writes its first insight.`,
      );
      fs.mkdirSync(resolvedSecondBrain, { recursive: true });
    }
  }

  const safeName = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const botName = get('--bot-name') || `@PM-${name}`;
  const model = get('--model') || DEFAULT_PM_AGENT_MODEL;

  return {
    displayName: name,
    slug: safeName,
    channel,
    repo,
    codebase: resolvedCodebase,
    secondbrain: resolvedSecondBrain,
    botName,
    model,
  };
}

// ─── Group Folder Setup ────────────────────────────────────────────────────────

function createGroupFolder(folderName: string): string {
  const groupDir = path.join(GROUPS_DIR, folderName);

  // Create required directory structure
  const dirs = [
    groupDir,
    path.join(groupDir, 'memory'),
    path.join(groupDir, 'conversations'),
    path.join(groupDir, 'specs'),
    path.join(groupDir, 'downloads'),
    path.join(groupDir, 'logs'),
    path.join(groupDir, '.nanoclaw'),
  ];
  for (const d of dirs) {
    fs.mkdirSync(d, { recursive: true });
  }

  // memory/context.md — current project state
  const contextPath = path.join(groupDir, 'memory', 'context.md');
  if (!fs.existsSync(contextPath)) {
    fs.writeFileSync(
      contextPath,
      `# Project Context\n\n_Initialize this file with your project details._\n\n## Active Sprint\n\n(not set)\n\n## Open Issues\n\n(none yet)\n\n## Team Members\n\n(not set)\n\n## Recent Decisions\n\n(see decisions.md)\n`,
    );
  }

  // memory/decisions.md — append-only architectural decisions
  const decisionsPath = path.join(groupDir, 'memory', 'decisions.md');
  if (!fs.existsSync(decisionsPath)) {
    fs.writeFileSync(
      decisionsPath,
      `# Architectural Decisions\n\n_Append new decisions below. Never edit past entries._\n\n`,
    );
  }

  // memory/standup.md — recent standup notes
  const standupPath = path.join(groupDir, 'memory', 'standup.md');
  if (!fs.existsSync(standupPath)) {
    fs.writeFileSync(
      standupPath,
      `# Standup Notes\n\n_Daily standup summaries appear here._\n\n`,
    );
  }

  // memory/glossary.md — project-specific terminology
  const glossaryPath = path.join(groupDir, 'memory', 'glossary.md');
  if (!fs.existsSync(glossaryPath)) {
    fs.writeFileSync(
      glossaryPath,
      `# Project Glossary\n\n_Add project-specific terms here._\n\n`,
    );
  }

  return groupDir;
}

// ─── Subagents JSON ────────────────────────────────────────────────────────────

function createSubagentsJson(groupDir: string, repo: string, repoAlias: string): void {
  const subagentsPath = path.join(groupDir, '.nanoclaw', 'subagents.json');
  if (!fs.existsSync(subagentsPath)) {
    const subagents = {
      agents: {
        codex: {
          description:
            'Implementation agent. Give it a spec file path. It branches, implements, and opens a PR.',
          prompt:
            `You are Codex, a focused software engineer. You receive a path to a spec file and implement the task described. Read project context from /workspace/extra/${repoAlias}. Follow existing code patterns. Write tests. Create a git branch, commit, push, and open a PR with gh CLI to the repo ${repo}. Return the PR URL when done. Only implement what the spec says.`,
          tools: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'],
          model: 'sonnet',
        },
        reviewer: {
          description:
            'Behavior-first PR review agent. Give it a PR number. It validates the changed behavior by running the system, then posts a GitHub review.',
          prompt:
            `You are Reviewer, a senior engineer doing pull request validation for repo ${repo}. Review behavior first, not code aesthetics. Use gh CLI to read the PR diff and context, then run the changed system locally when possible. For frontend work, open the app and exercise the changed flow directly. For backend work, run the service and validate real endpoints/commands. Tests and code inspection are supporting evidence, not the main proof. Submit the review as APPROVE, REQUEST_CHANGES, or COMMENT. Be specific, cite actual behavior observed, and never auto-merge.`,
          tools: ['Bash', 'Read', 'Grep', 'Glob'],
          model: 'sonnet',
        },
      },
    };
    fs.writeFileSync(subagentsPath, JSON.stringify(subagents, null, 2) + '\n');
  }
}

// ─── CLAUDE.md setup ──────────────────────────────────────────────────────────

function renderPmTemplate(content: string, values: Record<string, string>): string {
  let rendered = content;
  for (const [token, value] of Object.entries(values)) {
    rendered = rendered.split(token).join(value);
  }
  return rendered;
}

function ensureClaudeMd(
  groupDir: string,
  values: Record<string, string>,
): void {
  const targetClaudeMd = path.join(groupDir, 'CLAUDE.md');
  const templateClaudeMd = path.join(TEMPLATES_DIR, 'CLAUDE.md');

  if (!fs.existsSync(targetClaudeMd) && fs.existsSync(templateClaudeMd)) {
    let content = fs.readFileSync(templateClaudeMd, 'utf-8');
    content = renderPmTemplate(content, values);
    content =
      `<!-- This file was generated by register-pm-agent.ts. Edit to customize. -->\n\n` +
      content;
    fs.writeFileSync(targetClaudeMd, content);
  }
}

function ensureScheduleJson(
  groupDir: string,
  values: Record<string, string>,
): void {
  const targetSchedule = path.join(groupDir, 'schedule.json');
  const templateSchedule = path.join(TEMPLATES_DIR, 'schedule.json');

  if (!fs.existsSync(targetSchedule) && fs.existsSync(templateSchedule)) {
    const content = renderPmTemplate(
      fs.readFileSync(templateSchedule, 'utf-8'),
      values,
    );
    fs.writeFileSync(targetSchedule, content.endsWith('\n') ? content : `${content}\n`);
  }
}

// ─── Database Registration ─────────────────────────────────────────────────────

function registerInDatabase(opts: {
  jid: string;
  name: string;
  folder: string;
  trigger: string;
  repo: string;
  repoAlias: string;
  channel: string;
  codebase: string;
  secondbrain: string | null;
  model: string;
}): void {
  if (!fs.existsSync(DB_PATH)) {
    console.error(
      `❌  Database not found at ${DB_PATH}.\n` +
        `   Run 'npm run dev' once to initialize the database, then re-run this script.`,
    );
    process.exit(1);
  }

  const db = new Database(DB_PATH);

  // Build additional mounts
  const additionalMounts: Array<{
    hostPath: string;
    containerPath: string;
    readonly: boolean;
    excludePatterns?: string[];
  }> = [
    {
      hostPath: opts.codebase,
      containerPath: opts.repoAlias,
      readonly: true,
      excludePatterns: DEFAULT_PM_EXCLUDE_PATTERNS,
    },
  ];

  if (opts.secondbrain) {
    additionalMounts.push({
      hostPath: opts.secondbrain,
      containerPath: `${opts.repoAlias}-secondbrain`,
      readonly: false,
    });
  }

  // Build container config
  const containerConfig: {
    model: string;
    additionalMounts: typeof additionalMounts;
    envVars: Record<string, string>;
  } = {
    model: opts.model,
    additionalMounts,
    envVars: {
      GITHUB_REPO: opts.repo,
      ALLOWED_REPOS: opts.repoAlias,
      SLACK_CHANNEL_ID: opts.channel,
      PM_PROJECT_NAME: opts.name,
      ...(opts.secondbrain
        ? { PM_SECONDBRAIN_PATH: `/workspace/extra/${opts.repoAlias}-secondbrain` }
        : {}),
    },
  };
  const aliases = JSON.stringify([opts.repoAlias]);
  const gateway = JSON.stringify({ rules: [{ match: 'self_mention' }] });

  db.prepare(
    `INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, role, aliases, gateway)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(jid) DO UPDATE SET
       name = excluded.name,
       folder = excluded.folder,
       trigger_pattern = excluded.trigger_pattern,
       added_at = excluded.added_at,
       container_config = excluded.container_config,
       requires_trigger = excluded.requires_trigger,
       role = excluded.role,
       aliases = excluded.aliases,
       gateway = excluded.gateway`,
  ).run(
    opts.jid,
    opts.name,
    opts.folder,
    opts.trigger,
    new Date().toISOString(),
    JSON.stringify(containerConfig),
    1, // requiresTrigger = true (only respond to @mentions)
    'pm-agent',
    aliases,
    gateway,
  );

  db.close();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
  const opts = parseArgs();

  const folderName = `pm-${opts.slug}`;
  const jid = `slack:${opts.channel}`;
  const repoAlias = deriveRepoAlias(opts.repo);
  const templateValues = {
    '__PROJECT_NAME__': opts.displayName,
    '__PROJECT_NAME_JSON__': JSON.stringify(opts.displayName).slice(1, -1),
    '__GROUP_FOLDER__': folderName,
    '__REPO_ALIAS__': repoAlias,
    '__BOT_NAME__': opts.botName,
  };

  console.log(`\n🤖  Registering PM agent for project: ${opts.displayName}`);
  console.log(`   Slack channel:  ${opts.channel}  (JID: ${jid})`);
  console.log(`   GitHub repo:    ${opts.repo}`);
  console.log(`   Codebase:       ${opts.codebase}`);
  console.log(`   Model:          ${opts.model}`);
  if (opts.secondbrain) {
    console.log(`   SecondBrain:    ${opts.secondbrain}`);
  }
  console.log(`   Trigger:        ${opts.botName}`);
  console.log(`   Group folder:   groups/${folderName}/`);
  console.log('');

  // 1. Create group folder structure
  const groupDir = createGroupFolder(folderName);
  console.log(`✅  Created group folder: ${groupDir}`);

  // 2. Write subagents.json
  createSubagentsJson(groupDir, opts.repo, repoAlias);
  console.log(`✅  Wrote .nanoclaw/subagents.json (Codex + Reviewer sub-agents)`);

  // 3. Ensure CLAUDE.md + schedule.json from templates
  ensureClaudeMd(groupDir, templateValues);
  console.log(`✅  Ensured CLAUDE.md in group folder`);
  ensureScheduleJson(groupDir, templateValues);
  console.log(`✅  Ensured schedule.json in group folder`);

  // 4. Register in database
  registerInDatabase({
    jid,
    name: opts.displayName,
    folder: folderName,
    trigger: opts.botName,
    repo: opts.repo,
    repoAlias,
    channel: opts.channel,
    codebase: opts.codebase,
    secondbrain: opts.secondbrain,
    model: opts.model,
  });
  console.log(`✅  Registered group in database (JID: ${jid})`);

  console.log(`
✨  PM agent "${opts.displayName}" is ready!

Next steps:
  1. Make sure the Slack bot is invited to #your-channel:
       /invite @your-bot-name

  2. Restart NanoClaw to pick up the new registration:
       npm run dev

  3. @mention the bot in the channel to start:
       ${opts.botName} Hello! Scan open GitHub issues for ${opts.repo}

  4. (Optional) Edit groups/${folderName}/memory/context.md with project details.

Registered config:
  JID:          ${jid}
  Folder:       groups/${folderName}/
  Trigger:      ${opts.botName}
  GitHub repo:  ${opts.repo}
  Codebase:     ${opts.codebase}
  Model:        ${opts.model}
`);
}

main();
