#!/usr/bin/env node
/**
 * secondbrain-write - Shared utility for PM agents to write structured insights to SecondBrain
 *
 * Usage:
 *   echo '<json>' | secondbrain-write
 *   secondbrain-write < /tmp/insight.json
 *   secondbrain-write /tmp/insight.json
 *
 * Supported types:
 *   - slack-summary:    Summarized Slack conversation thread
 *   - github-issue:     GitHub issue triage or resolution insight
 *   - github-pr:        GitHub PR creation, review, or merge insight
 *   - github-review:    GitHub code review completion insight
 *
 * Output:
 *   Writes a Markdown file with YAML frontmatter to /workspace/secondbrain/inbox/
 *   Prints the output file path to stdout on success.
 *
 * Exit codes:
 *   0 - Success
 *   1 - Invalid input or write failure
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

// ---------- Constants ----------

const INBOX_DIR = '/workspace/secondbrain/inbox';
const VALID_TYPES = ['slack-summary', 'github-issue', 'github-pr', 'github-review'];

// ---------- Input reading ----------

function readInput() {
  const arg = process.argv[2];
  let raw;

  if (arg && arg !== '-') {
    // File path argument
    try {
      raw = readFileSync(arg, 'utf8');
    } catch (e) {
      die(`Cannot read file: ${arg}\n${e.message}`);
    }
  } else {
    // Read from stdin
    try {
      raw = readFileSync('/dev/stdin', 'utf8');
    } catch (e) {
      die(`Cannot read from stdin: ${e.message}`);
    }
  }

  return raw.trim();
}

// ---------- Validation ----------

function validate(input) {
  if (!input.type) {
    die(`Missing required field: type\nValid types: ${VALID_TYPES.join(', ')}`);
  }
  if (!VALID_TYPES.includes(input.type)) {
    die(`Invalid type: "${input.type}"\nValid types: ${VALID_TYPES.join(', ')}`);
  }
  if (!input.project) {
    die('Missing required field: project');
  }
  if (!input.title) {
    die('Missing required field: title');
  }
  if (!input.whatHappened) {
    die('Missing required field: whatHappened');
  }

  // Type-specific validation
  if (input.type.startsWith('github-') && !input.ref) {
    die(`Missing required field: ref (issue/PR number) for type "${input.type}"`);
  }
}

// ---------- Markdown generation ----------

function isoDate() {
  return new Date().toISOString();
}

function timestamp() {
  // Produces YYYYMMDD_HHMMSS (e.g. "20260302_015303")
  // Strips dashes, colons, T, and trailing milliseconds+Z before slicing
  const clean = new Date().toISOString().replace(/[-:T]/g, '').replace(/\.\d+Z$/, '');
  return clean.slice(0, 8) + '_' + clean.slice(8, 14);
}

function actionItemsSection(items) {
  if (!items || items.length === 0) return '_None specified_';
  return items.map(i => `- [ ] ${i}`).join('\n');
}

function buildFrontmatter(input) {
  const tags = (input.tags || []).filter(t => typeof t === 'string');
  const tagsYaml = tags.length > 0 ? `\n  - ${tags.join('\n  - ')}` : ' []';

  const lines = [
    '---',
    `type: pm-insight`,
    `source: ${input.type}`,
    `project: ${input.project}`,
    `date: ${isoDate()}`,
    `tags:${tagsYaml}`,
  ];

  // Type-specific frontmatter fields
  if (input.type === 'slack-summary') {
    if (input.channel) lines.push(`slack_channel: ${input.channel}`);
    if (input.threadTs) lines.push(`slack_thread_ts: "${input.threadTs}"`);
    if (input.messageCount) lines.push(`message_count: ${input.messageCount}`);
  } else if (input.type.startsWith('github-')) {
    if (input.repo) lines.push(`github_repo: ${input.repo}`);
    if (input.ref) lines.push(`github_ref: "${input.ref}"`);
    if (input.url) lines.push(`github_url: ${input.url}`);
  }

  lines.push('---');
  return lines.join('\n');
}

function buildBody(input) {
  const sections = [];

  // Title
  sections.push(`# ${input.title}`);
  sections.push('');

  // Type-specific header
  if (input.type === 'slack-summary') {
    sections.push('## Summary');
    sections.push(input.whatHappened);
    sections.push('');

    if (input.outcome) {
      sections.push('## Decision / Outcome');
      sections.push(input.outcome);
      sections.push('');
    }

    sections.push('## Action Items');
    sections.push(actionItemsSection(input.actionItems));
    sections.push('');

    if (input.context) {
      sections.push('## Context');
      sections.push(input.context);
      sections.push('');
    }

    if (input.participants && input.participants.length > 0) {
      sections.push('## Participants');
      sections.push(input.participants.map(p => `- ${p}`).join('\n'));
      sections.push('');
    }

  } else if (input.type === 'github-issue') {
    sections.push(`## What Happened`);
    sections.push(input.whatHappened);
    sections.push('');

    if (input.triage) {
      sections.push('## Triage Assessment');
      sections.push(input.triage);
      sections.push('');
    }

    if (input.outcome) {
      sections.push('## Outcome');
      sections.push(input.outcome);
      sections.push('');
    }

    sections.push('## Action Items');
    sections.push(actionItemsSection(input.actionItems));
    sections.push('');

    if (input.context) {
      sections.push('## Context');
      sections.push(input.context);
      sections.push('');
    }

    if (input.labels && input.labels.length > 0) {
      sections.push('## Labels');
      sections.push(input.labels.map(l => `- \`${l}\``).join('\n'));
      sections.push('');
    }

  } else if (input.type === 'github-pr') {
    sections.push('## What Happened');
    sections.push(input.whatHappened);
    sections.push('');

    if (input.changes) {
      sections.push('## Changes');
      sections.push(input.changes);
      sections.push('');
    }

    if (input.outcome) {
      sections.push('## Outcome');
      sections.push(input.outcome);
      sections.push('');
    }

    sections.push('## Action Items');
    sections.push(actionItemsSection(input.actionItems));
    sections.push('');

    if (input.reviewers && input.reviewers.length > 0) {
      sections.push('## Reviewers');
      sections.push(input.reviewers.map(r => `- ${r}`).join('\n'));
      sections.push('');
    }

    if (input.context) {
      sections.push('## Context');
      sections.push(input.context);
      sections.push('');
    }

  } else if (input.type === 'github-review') {
    sections.push('## Review Summary');
    sections.push(input.whatHappened);
    sections.push('');

    sections.push('## Verdict');
    sections.push(input.verdict || input.outcome || '_Not specified_');
    sections.push('');

    if (input.keyFindings && input.keyFindings.length > 0) {
      sections.push('## Key Findings');
      sections.push(input.keyFindings.map(f => `- ${f}`).join('\n'));
      sections.push('');
    }

    sections.push('## Action Items');
    sections.push(actionItemsSection(input.actionItems));
    sections.push('');

    if (input.context) {
      sections.push('## Context');
      sections.push(input.context);
      sections.push('');
    }
  }

  return sections.join('\n');
}

function buildMarkdown(input) {
  const frontmatter = buildFrontmatter(input);
  const body = buildBody(input);
  return `${frontmatter}\n\n${body}`;
}

// ---------- File writing ----------

function writeInsight(input) {
  const ts = timestamp();
  // Sanitize type for filename: github-pr → github_pr
  const typeSlug = input.type.replace(/-/g, '_');
  const filename = `pm_${typeSlug}_${ts}.md`;
  const filepath = join(INBOX_DIR, filename);

  const content = buildMarkdown(input);

  try {
    mkdirSync(INBOX_DIR, { recursive: true });
  } catch (e) {
    die(`Cannot create inbox directory: ${INBOX_DIR}\n${e.message}`);
  }

  try {
    writeFileSync(filepath, content, { encoding: 'utf8' });
  } catch (e) {
    die(`Cannot write file: ${filepath}\n${e.message}`);
  }

  return filepath;
}

// ---------- Utilities ----------

function die(msg) {
  process.stderr.write(`secondbrain-write: ${msg}\n`);
  process.exit(1);
}

// ---------- Main ----------

function main() {
  const raw = readInput();

  let input;
  try {
    input = JSON.parse(raw);
  } catch (e) {
    die(`Invalid JSON input: ${e.message}\n\nReceived:\n${raw.slice(0, 200)}`);
  }

  validate(input);

  const filepath = writeInsight(input);

  // Output the written file path for the caller to confirm
  process.stdout.write(`${filepath}\n`);
}

main();
