/**
 * SecondBrain Write Utility — Container-side
 *
 * Provides a standardized schema and write API for creating SecondBrain insights
 * and summaries. Used by all NanoClaw agents (PM agents, Marketer, Dobby, etc.)
 * via the `write_secondbrain_insight` MCP tool.
 *
 * SecondBrain inbox path inside containers: /workspace/secondbrain/inbox/
 */

import fs from 'fs';
import path from 'path';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SECONDBRAIN_INBOX_PATH = '/workspace/secondbrain/inbox';

// ---------------------------------------------------------------------------
// Schema definitions
// ---------------------------------------------------------------------------

/**
 * Insight type values — describes the nature of the entry.
 */
export const InsightTypeSchema = z.enum([
  'pm-insight',       // PM agent: decisions, events, thread summaries
  'marketer-insight', // Marketer: campaign results, trend research
  'decision',         // Architecture / product decision
  'feature',          // Feature scope or plan
  'bug',              // Bug triage, root cause, resolution
  'blocked',          // Stalled work (why + next steps)
  'retro',            // Retrospective / lessons learned
  'summary',          // General conversation or session summary
  'note',             // Freeform note or observation
]);

export type InsightType = z.infer<typeof InsightTypeSchema>;

/**
 * Priority level for triage and surfacing in SecondBrain.
 */
export const PrioritySchema = z.enum(['low', 'medium', 'high']).optional();
export type Priority = z.infer<typeof PrioritySchema>;

/**
 * Action item with optional owner.
 */
export const ActionItemSchema = z.object({
  task: z.string().min(1).describe('What needs to be done'),
  owner: z.string().optional().describe('Person or agent responsible'),
  done: z.boolean().default(false).describe('Whether this item is completed'),
});
export type ActionItem = z.infer<typeof ActionItemSchema>;

/**
 * Full SecondBrain insight entry schema.
 * All agents must conform to this schema when writing to SecondBrain.
 */
export const SecondBrainInsightSchema = z.object({
  // --- Required fields ---
  type: InsightTypeSchema.describe('Type of insight'),
  source: z.string().min(1).describe('Agent or system that created this entry (e.g. "pm-myproject", "marketer", "dobby")'),
  title: z.string().min(1).describe('Short, descriptive title for the insight'),
  content: z.string().min(1).describe('Main content body in markdown'),

  // --- Recommended fields ---
  project: z.string().optional().describe('Project name this insight belongs to (if applicable)'),
  tags: z.array(z.string()).default([]).describe('Classification tags (e.g. ["decision", "api", "auth"])'),

  // --- Optional structured fields ---
  decisions: z.array(z.string()).optional().describe('List of concrete decisions made'),
  action_items: z.array(ActionItemSchema).optional().describe('Follow-up action items'),
  links: z.array(z.string()).optional().describe('Relevant URLs or references (GitHub issues, PRs, docs)'),
  priority: PrioritySchema.describe('Triage priority'),

  // --- Auto-populated if not provided ---
  date: z.string().optional().describe('ISO 8601 timestamp (auto-set to now if omitted)'),
});

export type SecondBrainInsight = z.infer<typeof SecondBrainInsightSchema>;

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

/**
 * Slugify a string for use in filenames.
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * Format a Date object as YYYYMMDD_HHMMSS for use in filenames.
 */
function formatTimestampForFilename(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return [
    d.getFullYear(),
    pad(d.getMonth() + 1),
    pad(d.getDate()),
  ].join('') + '_' + [
    pad(d.getHours()),
    pad(d.getMinutes()),
    pad(d.getSeconds()),
  ].join('');
}

/**
 * Serialize an insight to YAML frontmatter + Markdown body.
 *
 * Format:
 * ```
 * ---
 * type: pm-insight
 * source: pm-myproject
 * project: MyProject
 * date: 2026-03-02T08:00:00.000Z
 * tags: [decision, architecture]
 * priority: high
 * decisions:
 *   - Use Redis for caching
 * action_items:
 *   - task: Update deployment docs
 *     owner: alice
 *     done: false
 * links:
 *   - https://github.com/owner/repo/issues/42
 * ---
 *
 * # Title
 *
 * [content body]
 * ```
 */
export function serializeInsight(insight: SecondBrainInsight): string {
  const lines: string[] = ['---'];

  lines.push(`type: ${insight.type}`);
  lines.push(`source: ${insight.source}`);

  if (insight.project) {
    lines.push(`project: ${insight.project}`);
  }

  lines.push(`date: ${insight.date}`);
  lines.push(`title: ${JSON.stringify(insight.title)}`);

  if (insight.tags && insight.tags.length > 0) {
    lines.push(`tags: [${insight.tags.join(', ')}]`);
  } else {
    lines.push('tags: []');
  }

  if (insight.priority) {
    lines.push(`priority: ${insight.priority}`);
  }

  if (insight.decisions && insight.decisions.length > 0) {
    lines.push('decisions:');
    for (const d of insight.decisions) {
      lines.push(`  - ${JSON.stringify(d)}`);
    }
  }

  if (insight.action_items && insight.action_items.length > 0) {
    lines.push('action_items:');
    for (const item of insight.action_items) {
      lines.push(`  - task: ${JSON.stringify(item.task)}`);
      if (item.owner) {
        lines.push(`    owner: ${item.owner}`);
      }
      lines.push(`    done: ${item.done}`);
    }
  }

  if (insight.links && insight.links.length > 0) {
    lines.push('links:');
    for (const link of insight.links) {
      lines.push(`  - ${link}`);
    }
  }

  lines.push('---');
  lines.push('');
  lines.push(`# ${insight.title}`);
  lines.push('');
  lines.push(insight.content.trim());
  lines.push('');

  return lines.join('\n');
}

/**
 * Generate a filename for a SecondBrain insight entry.
 * Format: {timestamp}_{type}_{slug}.md
 * Example: 20260302_081500_pm-insight_sprint-planning-decision.md
 */
export function generateInsightFilename(insight: SecondBrainInsight): string {
  const date = insight.date ? new Date(insight.date) : new Date();
  const ts = formatTimestampForFilename(date);
  const typeSlug = insight.type;
  const titleSlug = slugify(insight.title);
  return `${ts}_${typeSlug}_${titleSlug}.md`;
}

// ---------------------------------------------------------------------------
// Write API
// ---------------------------------------------------------------------------

export interface WriteInsightResult {
  success: boolean;
  filePath?: string;
  filename?: string;
  error?: string;
}

/**
 * Validate, serialize, and atomically write an insight to the SecondBrain inbox.
 *
 * @param rawInsight  Raw insight data (will be validated against schema)
 * @param inboxPath   Destination directory (defaults to SECONDBRAIN_INBOX_PATH)
 * @returns           Result with success status and file path or error
 */
export function writeInsight(
  rawInsight: unknown,
  inboxPath: string = SECONDBRAIN_INBOX_PATH,
): WriteInsightResult {
  // 1. Parse and validate
  const parseResult = SecondBrainInsightSchema.safeParse(rawInsight);
  if (!parseResult.success) {
    const issues = parseResult.error.issues
      .map(i => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    return { success: false, error: `Validation failed: ${issues}` };
  }

  const insight = parseResult.data;

  // 2. Auto-set date if not provided
  if (!insight.date) {
    insight.date = new Date().toISOString();
  }

  // 3. Ensure inbox directory exists
  try {
    fs.mkdirSync(inboxPath, { recursive: true });
  } catch (err) {
    return {
      success: false,
      error: `Failed to create inbox directory: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 4. Generate filename
  const filename = generateInsightFilename(insight);
  const filePath = path.join(inboxPath, filename);

  // 5. Serialize to markdown with YAML frontmatter
  const content = serializeInsight(insight);

  // 6. Atomic write (temp file then rename)
  const tempPath = `${filePath}.tmp`;
  try {
    fs.writeFileSync(tempPath, content, 'utf-8');
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    // Cleanup temp file if rename failed
    try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
    return {
      success: false,
      error: `Failed to write insight file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { success: true, filePath, filename };
}

// ---------------------------------------------------------------------------
// Quick-write helpers (convenience wrappers for common patterns)
// ---------------------------------------------------------------------------

/**
 * Write a PM agent insight from a conversation summary.
 * Shorthand for writeInsight with type='pm-insight'.
 */
export function writePmInsight(opts: {
  source: string;
  project: string;
  title: string;
  content: string;
  tags?: string[];
  decisions?: string[];
  action_items?: Array<{ task: string; owner?: string; done?: boolean }>;
  links?: string[];
  priority?: Priority;
  inboxPath?: string;
}): WriteInsightResult {
  return writeInsight({
    type: 'pm-insight',
    source: opts.source,
    project: opts.project,
    title: opts.title,
    content: opts.content,
    tags: opts.tags ?? [],
    decisions: opts.decisions,
    action_items: opts.action_items?.map(a => ({ done: false, ...a })),
    links: opts.links,
    priority: opts.priority,
  }, opts.inboxPath);
}

/**
 * Write a Marketer insight (campaign results, trend findings, etc.)
 * Shorthand for writeInsight with type='marketer-insight'.
 */
export function writeMarketerInsight(opts: {
  source?: string;
  project?: string;
  title: string;
  content: string;
  tags?: string[];
  links?: string[];
  priority?: Priority;
  inboxPath?: string;
}): WriteInsightResult {
  return writeInsight({
    type: 'marketer-insight',
    source: opts.source ?? 'marketer',
    project: opts.project,
    title: opts.title,
    content: opts.content,
    tags: opts.tags ?? [],
    links: opts.links,
    priority: opts.priority,
  }, opts.inboxPath);
}

/**
 * Write a general summary entry (conversation archive, session recap, etc.)
 */
export function writeSummary(opts: {
  source: string;
  title: string;
  content: string;
  project?: string;
  tags?: string[];
  inboxPath?: string;
}): WriteInsightResult {
  return writeInsight({
    type: 'summary',
    source: opts.source,
    title: opts.title,
    content: opts.content,
    project: opts.project,
    tags: opts.tags ?? [],
  }, opts.inboxPath);
}
