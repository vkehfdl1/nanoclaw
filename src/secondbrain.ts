/**
 * SecondBrain Module — Host-side (orchestrator)
 *
 * Provides TypeScript types and read utilities for the SecondBrain knowledge
 * store. Used by the NanoClaw orchestrator when it needs to inspect or route
 * SecondBrain inbox entries.
 *
 * Agents write to SecondBrain via the `write_secondbrain_insight` MCP tool
 * (container/agent-runner/src/ipc-mcp-stdio.ts), which uses the schema
 * defined in container/agent-runner/src/secondbrain.ts.
 *
 * The host reads entries from the configured SecondBrain inbox path (host
 * filesystem), which is mounted read-write into PM agent containers as
 * /workspace/secondbrain and read-only into Marketer as /workspace/extra/secondbrain.
 */

import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Shared types (mirrors container/agent-runner/src/secondbrain.ts)
// ---------------------------------------------------------------------------

export type InsightType =
  | 'pm-insight'
  | 'marketer-insight'
  | 'decision'
  | 'feature'
  | 'bug'
  | 'blocked'
  | 'retro'
  | 'summary'
  | 'note';

export type Priority = 'low' | 'medium' | 'high';

export interface ActionItem {
  task: string;
  owner?: string;
  done: boolean;
}

/**
 * Parsed SecondBrain entry (frontmatter + body).
 */
export interface SecondBrainEntry {
  // Parsed frontmatter fields
  type: InsightType;
  source: string;
  title: string;
  project?: string;
  date: string;
  tags: string[];
  priority?: Priority;
  decisions?: string[];
  action_items?: ActionItem[];
  links?: string[]; // URLs or references (GitHub issues, PRs, docs)

  // Raw file content body (below the frontmatter)
  body: string;

  // Metadata
  filename: string;
  filePath: string;
}

// ---------------------------------------------------------------------------
// YAML frontmatter parser (minimal, no dependencies)
// ---------------------------------------------------------------------------

/**
 * Minimal YAML frontmatter extractor.
 * Handles the subset of YAML produced by secondbrain.ts serialization:
 *   - Scalar strings (quoted and unquoted)
 *   - Boolean values
 *   - Inline arrays: [a, b, c]
 *   - Indented list blocks:
 *       key:
 *         - value
 *         - value
 */
function parseFrontmatter(content: string): { meta: Record<string, unknown>; body: string } {
  const FM_REGEX = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;
  const match = content.match(FM_REGEX);
  if (!match) {
    return { meta: {}, body: content };
  }

  const rawYaml = match[1];
  const body = match[2];
  const meta: Record<string, unknown> = {};

  const lines = rawYaml.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Skip blank lines
    if (!line.trim()) { i++; continue; }

    // Top-level key: value
    const scalarMatch = line.match(/^(\w[\w_-]*):\s*(.*)?$/);
    if (!scalarMatch) { i++; continue; }

    const key = scalarMatch[1];
    const rawValue = scalarMatch[2]?.trim() ?? '';

    if (rawValue === '' || rawValue === undefined) {
      // Possibly a block list follows
      const items: string[] = [];
      i++;
      while (i < lines.length && /^\s+-\s+/.test(lines[i])) {
        const itemLine = lines[i].replace(/^\s+-\s+/, '').trim();
        // Handle nested key: value inside list items (action_items)
        if (itemLine.includes(':') && !itemLine.startsWith('"')) {
          // Parse the item as a sub-object
          const obj: Record<string, unknown> = {};
          const firstEntry = itemLine.match(/^(\w+):\s*(.*)$/);
          if (firstEntry) {
            obj[firstEntry[1]] = parseScalar(firstEntry[2]);
          }
          i++;
          // Consume indented sub-keys
          while (i < lines.length && /^\s{4,}\w/.test(lines[i])) {
            const subMatch = lines[i].trim().match(/^(\w+):\s*(.*)$/);
            if (subMatch) {
              obj[subMatch[1]] = parseScalar(subMatch[2]);
            }
            i++;
          }
          items.push(JSON.stringify(obj)); // store as serialized object
          continue;
        } else {
          items.push(parseScalar(itemLine) as string);
        }
        i++;
      }

      if (items.length > 0) {
        // Try to deserialize back into objects for action_items
        meta[key] = items.map(item => {
          try {
            const parsed = JSON.parse(item);
            return typeof parsed === 'object' ? parsed : item;
          } catch {
            return item;
          }
        });
      }
      continue;
    }

    // Inline array: [a, b, c]
    if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
      const inner = rawValue.slice(1, -1);
      if (inner.trim() === '') {
        meta[key] = [];
      } else {
        meta[key] = inner.split(',').map(s => s.trim()).filter(Boolean);
      }
      i++;
      continue;
    }

    // Scalar
    meta[key] = parseScalar(rawValue);
    i++;
  }

  return { meta, body };
}

function parseScalar(value: string): string | boolean | number {
  if (value === 'true') return true;
  if (value === 'false') return false;
  const n = Number(value);
  if (!isNaN(n) && value !== '') return n;
  // Strip surrounding quotes
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Read utilities
// ---------------------------------------------------------------------------

/**
 * Parse a single SecondBrain inbox file into a SecondBrainEntry.
 * Returns null if the file cannot be parsed or is missing required fields.
 */
export function parseInsightFile(filePath: string): SecondBrainEntry | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  const { meta, body } = parseFrontmatter(raw);

  if (!meta.type || !meta.source || !meta.title) {
    return null;
  }

  return {
    type: meta.type as InsightType,
    source: meta.source as string,
    title: meta.title as string,
    project: meta.project as string | undefined,
    date: (meta.date as string) ?? new Date().toISOString(),
    tags: Array.isArray(meta.tags) ? (meta.tags as string[]) : [],
    priority: meta.priority as Priority | undefined,
    decisions: Array.isArray(meta.decisions) ? (meta.decisions as string[]) : undefined,
    action_items: Array.isArray(meta.action_items) ? (meta.action_items as ActionItem[]) : undefined,
    links: Array.isArray(meta.links) ? (meta.links as string[]) : undefined,
    body: body.trim(),
    filename: path.basename(filePath),
    filePath,
  };
}

export interface ReadInsightsOptions {
  /** Filter by insight type */
  type?: InsightType | InsightType[];
  /** Filter by project name */
  project?: string;
  /** Filter by source agent */
  source?: string;
  /** Only return entries with at least one of these tags */
  tags?: string[];
  /** Return at most N entries (applied after filtering and sorting) */
  limit?: number;
  /** Sort order — 'newest' (default) or 'oldest' */
  sort?: 'newest' | 'oldest';
}

/**
 * Read and parse all SecondBrain insights from the given inbox directory.
 * Returns entries sorted by date (newest first by default).
 */
export function readInsights(
  inboxPath: string,
  options: ReadInsightsOptions = {},
): SecondBrainEntry[] {
  if (!fs.existsSync(inboxPath)) {
    return [];
  }

  let files: string[];
  try {
    files = fs.readdirSync(inboxPath)
      .filter(f => f.endsWith('.md'))
      .map(f => path.join(inboxPath, f));
  } catch {
    return [];
  }

  const entries: SecondBrainEntry[] = [];
  for (const f of files) {
    const entry = parseInsightFile(f);
    if (entry) entries.push(entry);
  }

  // Filter
  let filtered = entries.filter(e => {
    if (options.type) {
      const types = Array.isArray(options.type) ? options.type : [options.type];
      if (!types.includes(e.type)) return false;
    }
    if (options.project && e.project !== options.project) return false;
    if (options.source && e.source !== options.source) return false;
    if (options.tags && options.tags.length > 0) {
      if (!options.tags.some(t => e.tags.includes(t))) return false;
    }
    return true;
  });

  // Sort
  filtered.sort((a, b) => {
    const aTime = new Date(a.date).getTime();
    const bTime = new Date(b.date).getTime();
    return options.sort === 'oldest' ? aTime - bTime : bTime - aTime;
  });

  // Limit
  if (options.limit && options.limit > 0) {
    filtered = filtered.slice(0, options.limit);
  }

  return filtered;
}

/**
 * Read the N most recent SecondBrain insights, optionally filtered.
 * Convenience wrapper around readInsights.
 */
export function readRecentInsights(
  inboxPath: string,
  limit = 10,
  options: Omit<ReadInsightsOptions, 'limit' | 'sort'> = {},
): SecondBrainEntry[] {
  return readInsights(inboxPath, { ...options, limit, sort: 'newest' });
}

/**
 * Read all insights for a specific project.
 */
export function readProjectInsights(
  inboxPath: string,
  project: string,
  options: Omit<ReadInsightsOptions, 'project'> = {},
): SecondBrainEntry[] {
  return readInsights(inboxPath, { ...options, project });
}
