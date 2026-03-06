import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { AgentGateway, NewMessage, RegisteredGroup, ScheduledTask, TaskRunLog } from './types.js';

let db: Database.Database;

const MAIN_CHANNEL_JID = 'slack:C0AH91957U0';
const MAIN_FOLDER = 'main';
const PM_AUTORAG_CHANNEL_JID = 'slack:C09RELR4R9N';
const PM_AUTORAG_FOLDER = 'pm-autorag';
const MARKETER_FOLDER = 'marketer';
const MARKETER_CHANNEL_JID = 'slack:C0AJ9U1DB25';
const TODOMON_CHANNEL_JID = 'slack:C0AH3SVQL4C';
const TODOMON_FOLDER = 'todomon';

function ensureDefaultRegisteredGroup(
  jid: string,
  group: Omit<RegisteredGroup, 'added_at'>,
): void {
  const existing = db
    .prepare(
      `SELECT added_at FROM registered_groups WHERE jid = ? AND folder = ? LIMIT 1`,
    )
    .get(jid, group.folder) as
    | { added_at: string }
    | undefined;

  setRegisteredGroup(jid, {
    ...group,
    added_at: existing?.added_at ?? new Date().toISOString(),
  });
}

function ensureMainRegistration(): void {
  ensureDefaultRegisteredGroup(MAIN_CHANNEL_JID, {
    name: '도비',
    folder: MAIN_FOLDER,
    trigger: '@도비',
    aliases: ['dobby', '도비'],
    requiresTrigger: false,
    gateway: { rules: [{ match: 'self_mention' }] },
    role: 'main',
    containerConfig: {
      model: 'claude-opus-4-6',
    },
  });
}

function ensurePmAutoragRegistration(): void {
  ensureDefaultRegisteredGroup(PM_AUTORAG_CHANNEL_JID, {
    name: '영구',
    folder: PM_AUTORAG_FOLDER,
    trigger: '@영구',
    aliases: ['young-gu', '영구'],
    requiresTrigger: false,
    gateway: {
      rules: [{ match: 'self_mention' }],
    },
    role: 'pm-agent',
    containerConfig: {
      model: 'claude-opus-4-6',
      envVars: {
        GITHUB_REPO: 'NomaDamas/AutoRAG-Research',
        ALLOWED_REPOS: 'autorag-research',
      },
      additionalMounts: [
        {
          hostPath: '~/Projects/AutoRAG-Research',
          containerPath: 'autorag-research',
          readonly: true,
          excludePatterns: [
            'node_modules',
            '.venv',
            'dist',
            '.git/objects',
            '__pycache__',
            '.mypy_cache',
            '.pytest_cache',
          ],
        },
      ],
    },
  });
}

function ensureMarketerRegistration(): void {
  // 홍명보 (formerly Marketer): responds to all messages in its channel
  ensureDefaultRegisteredGroup(MARKETER_CHANNEL_JID, {
    name: '홍명보',
    folder: MARKETER_FOLDER,
    trigger: '@홍명보',
    aliases: ['marketer', '홍명보', '명보'],
    requiresTrigger: false,
    gateway: {
      rules: [
        { channel: [MARKETER_CHANNEL_JID], match: 'any_message' },
        { match: 'self_mention' },
      ],
    },
    role: 'marketer',
    containerConfig: {
      model: 'claude-sonnet-4-6',
      additionalMounts: [
        {
          hostPath: '~/.nanoclaw/auth',
          containerPath: 'auth',
          readonly: true,
        },
      ],
    },
  });

}

function ensureTodomonRegistration(): void {
  ensureDefaultRegisteredGroup(TODOMON_CHANNEL_JID, {
    name: '투두몬',
    folder: TODOMON_FOLDER,
    trigger: '@투두몬',
    aliases: ['todomon', '투두몬'],
    requiresTrigger: false,
    gateway: {
      rules: [
        { channel: [TODOMON_CHANNEL_JID], match: 'any_message' },
        { match: 'self_mention' },
      ],
    },
    role: 'todomon',
    containerConfig: {
      model: 'claude-sonnet-4-6',
    },
  });
}

function ensureDefaultAgentRegistrations(): void {
  ensureMainRegistration();
  ensurePmAutoragRegistration();
  ensureMarketerRegistration();
  ensureTodomonRegistration();
}

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      is_cross_agent INTEGER DEFAULT 0,
      agent_source TEXT,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      code_snippet TEXT,
      snippet_language TEXT DEFAULT 'python',
      snippet_venv_path TEXT,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      agent_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      thread_ts TEXT NOT NULL DEFAULT '__channel__',
      session_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_active TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (agent_folder, chat_jid, thread_ts)
    );
    CREATE TABLE IF NOT EXISTS agent_cursors (
      agent_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      last_processed_ts TEXT NOT NULL,
      PRIMARY KEY (agent_folder, chat_jid)
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT NOT NULL,
      name TEXT NOT NULL,
      folder TEXT NOT NULL,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1,
      role TEXT,
      PRIMARY KEY (jid, folder)
    );
  `);

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN code_snippet TEXT`,
    );
  } catch {
    /* column already exists */
  }
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN snippet_language TEXT DEFAULT 'python'`,
    );
  } catch {
    /* column already exists */
  }
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN snippet_venv_path TEXT`,
    );
  } catch {
    /* column already exists */
  }

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    // Backfill: mark existing bot messages that used the content prefix pattern
    database.prepare(
      `UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`,
    ).run(`${ASSISTANT_NAME}:%`);
  } catch {
    /* column already exists */
  }

  // Add cross-agent messaging columns if they don't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_cross_agent INTEGER DEFAULT 0`,
    );
  } catch {
    /* column already exists */
  }
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN agent_source TEXT`,
    );
  } catch {
    /* column already exists */
  }

  // Add channel and is_group columns if they don't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE chats ADD COLUMN channel TEXT`,
    );
    database.exec(
      `ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`,
    );
    // Backfill from known JID patterns where possible
    database.exec(`UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`);
    database.exec(`UPDATE chats SET channel = 'telegram', is_group = 1 WHERE jid LIKE 'tg:%'`);
  } catch {
    /* columns already exist */
  }

  // Add thread_ts column for Slack thread tracking (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN thread_ts TEXT`,
    );
  } catch {
    /* column already exists */
  }

  // Add role column to registered_groups for agent role identification (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN role TEXT`,
    );
  } catch {
    /* column already exists */
  }

  // Add aliases column (JSON array) for declarative alias matching
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN aliases TEXT`,
    );
  } catch {
    /* column already exists */
  }

  // Add gateway column (JSON object) for declarative gateway rules
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN gateway TEXT`,
    );
  } catch {
    /* column already exists */
  }

  // Normalize registered_groups schema for multi-agent routing:
  // - allow multiple agents per channel (jid no longer primary key)
  // - allow one agent folder in multiple channels (no UNIQUE on folder)
  // - keep one row per (jid, folder)
  try {
    const tableSql = database
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'registered_groups'`,
      )
      .get() as { sql: string } | undefined;

    const sql = tableSql?.sql ?? '';
    const hasCompositePk = /\bPRIMARY\s+KEY\s*\(\s*jid\s*,\s*folder\s*\)/i.test(sql);
    const hasLegacyJidPk = /\bjid\s+TEXT\s+PRIMARY\s+KEY\b/i.test(sql);
    const hasFolderUnique =
      /\bfolder\s+TEXT\s+NOT\s+NULL\s+UNIQUE\b/i.test(sql) ||
      /\bUNIQUE\s*\(\s*folder\s*\)/i.test(sql);

    if (sql && (!hasCompositePk || hasLegacyJidPk || hasFolderUnique)) {
      database.exec(`
        BEGIN TRANSACTION;
        CREATE TABLE registered_groups_v2 (
          jid TEXT NOT NULL,
          name TEXT NOT NULL,
          folder TEXT NOT NULL,
          trigger_pattern TEXT NOT NULL,
          added_at TEXT NOT NULL,
          container_config TEXT,
          requires_trigger INTEGER DEFAULT 1,
          role TEXT,
          aliases TEXT,
          gateway TEXT,
          PRIMARY KEY (jid, folder)
        );
        INSERT OR REPLACE INTO registered_groups_v2 (
          jid,
          name,
          folder,
          trigger_pattern,
          added_at,
          container_config,
          requires_trigger,
          role,
          aliases,
          gateway
        )
        SELECT
          jid,
          name,
          folder,
          trigger_pattern,
          added_at,
          container_config,
          requires_trigger,
          role,
          CASE WHEN aliases IS NOT NULL THEN aliases ELSE NULL END,
          CASE WHEN gateway IS NOT NULL THEN gateway ELSE NULL END
        FROM registered_groups
        ORDER BY added_at, folder;
        DROP TABLE registered_groups;
        ALTER TABLE registered_groups_v2 RENAME TO registered_groups;
        COMMIT;
      `);
      logger.info('Migrated registered_groups schema to composite (jid, folder) key');
    }
  } catch (err) {
    try {
      database.exec('ROLLBACK');
    } catch {
      /* no open transaction */
    }
    logger.error(
      { err },
      'Failed to migrate registered_groups schema',
    );
    throw err;
  }

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_registered_groups_folder ON registered_groups(folder);
  `);

  // Migrate old single-key sessions table to thread-aware schema
  try {
    const sessionsSql = database
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'`,
      )
      .get() as { sql: string } | undefined;

    const sql = sessionsSql?.sql ?? '';
    const hasOldSchema = /\bgroup_folder\s+TEXT\s+PRIMARY\s+KEY\b/i.test(sql);

    if (hasOldSchema) {
      database.exec(`
        BEGIN TRANSACTION;
        CREATE TABLE sessions_v2 (
          agent_folder TEXT NOT NULL,
          chat_jid TEXT NOT NULL,
          thread_ts TEXT NOT NULL DEFAULT '__channel__',
          session_id TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_active TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (agent_folder, chat_jid, thread_ts)
        );
        DROP TABLE sessions;
        ALTER TABLE sessions_v2 RENAME TO sessions;
        COMMIT;
      `);
      logger.info('Migrated sessions table to thread-aware schema (old sessions discarded)');
    }
  } catch (err) {
    try {
      database.exec('ROLLBACK');
    } catch {
      /* no open transaction */
    }
    logger.error({ err }, 'Failed to migrate sessions table');
  }

  // Migrate agent cursors from router_state JSON to dedicated table
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS agent_cursors (
        agent_folder TEXT NOT NULL,
        chat_jid TEXT NOT NULL,
        last_processed_ts TEXT NOT NULL,
        PRIMARY KEY (agent_folder, chat_jid)
      );
    `);
    const agentTsRow = database
      .prepare(`SELECT value FROM router_state WHERE key = 'last_agent_timestamp'`)
      .get() as { value: string } | undefined;
    if (agentTsRow?.value) {
      const agentTs = JSON.parse(agentTsRow.value) as Record<string, string>;
      const insertCursor = database.prepare(
        `INSERT OR REPLACE INTO agent_cursors (agent_folder, chat_jid, last_processed_ts) VALUES (?, ?, ?)`,
      );
      for (const [compositeKey, ts] of Object.entries(agentTs)) {
        const parts = compositeKey.split('::');
        if (parts.length === 2) {
          insertCursor.run(parts[1], parts[0], ts); // folder, chatJid, timestamp
        } else {
          // Legacy format: key is just chatJid, folder unknown — skip
        }
      }
      database.prepare(`DELETE FROM router_state WHERE key = 'last_agent_timestamp'`).run();
      logger.info('Migrated agent cursors from router_state to agent_cursors table');
    }
  } catch (err) {
    logger.error({ err }, 'Failed to migrate agent cursors');
  }

  // Thread-optimized message indexes
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(chat_jid, thread_ts, timestamp);
  `);
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  createSchema(db);

  // Migrate from JSON files if they exist
  migrateJsonState();
  ensureDefaultAgentRegistrations();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/** @internal - for tests only. Seeds default team registrations. */
export function _ensureDefaultAgentRegistrationsForTests(): void {
  ensureDefaultAgentRegistrations();
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, name, timestamp, ch, group);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, chatJid, timestamp, ch, group);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, is_cross_agent, agent_source, thread_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
    0,
    msg.agent_source ?? null,
    msg.thread_ts ?? null,
  );
}

/**
 * Store a message directly.
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
  agent_source?: string;
  thread_ts?: string;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, is_cross_agent, agent_source, thread_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
    0,
    msg.agent_source ?? null,
    msg.thread_ts ?? null,
  );
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp, thread_ts,
           is_bot_message, agent_source
    FROM messages
    WHERE timestamp > ? AND chat_jid IN (${placeholders})
      AND content != '' AND content IS NOT NULL
    ORDER BY timestamp
  `;

  interface RawRow {
    id: string;
    chat_jid: string;
    sender: string;
    sender_name: string;
    content: string;
    timestamp: string;
    thread_ts: string | null;
    is_bot_message: number;
    agent_source: string | null;
  }

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids) as RawRow[];

  let newTimestamp = lastTimestamp;
  const messages: NewMessage[] = [];
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
    messages.push({
      id: row.id,
      chat_jid: row.chat_jid,
      sender: row.sender,
      sender_name: row.sender_name,
      content: row.content,
      timestamp: row.timestamp,
      thread_ts: row.thread_ts ?? undefined,
      is_bot_message: !!row.is_bot_message,
      agent_source: row.agent_source ?? undefined,
    });
  }

  return { messages, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
): NewMessage[] {
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp, thread_ts,
           is_bot_message, agent_source
    FROM messages
    WHERE chat_jid = ? AND timestamp > ?
      AND content != '' AND content IS NOT NULL
    ORDER BY timestamp
  `;
  interface RawRow {
    id: string;
    chat_jid: string;
    sender: string;
    sender_name: string;
    content: string;
    timestamp: string;
    thread_ts: string | null;
    is_bot_message: number;
    agent_source: string | null;
  }

  const rows = db
    .prepare(sql)
    .all(chatJid, sinceTimestamp) as RawRow[];
  return rows.map((row) => ({
    id: row.id,
    chat_jid: row.chat_jid,
    sender: row.sender,
    sender_name: row.sender_name,
    content: row.content,
    timestamp: row.timestamp,
    thread_ts: row.thread_ts ?? undefined,
    is_bot_message: !!row.is_bot_message,
    agent_source: row.agent_source ?? undefined,
  }));
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, code_snippet, snippet_language, snippet_venv_path, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.code_snippet || null,
    task.snippet_language || 'javascript',
    task.snippet_venv_path || null,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      | 'prompt'
      | 'code_snippet'
      | 'snippet_language'
      | 'snippet_venv_path'
      | 'schedule_type'
      | 'schedule_value'
      | 'next_run'
      | 'status'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.code_snippet !== undefined) {
    fields.push('code_snippet = ?');
    values.push(updates.code_snippet);
  }
  if (updates.snippet_language !== undefined) {
    fields.push('snippet_language = ?');
    values.push(updates.snippet_language);
  }
  if (updates.snippet_venv_path !== undefined) {
    fields.push('snippet_venv_path = ?');
    values.push(updates.snippet_venv_path);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function claimDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db.transaction(() => {
    const dueTasks = db
      .prepare(
        `
      SELECT * FROM scheduled_tasks
      WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
      ORDER BY next_run
    `,
      )
      .all(now) as ScheduledTask[];

    if (dueTasks.length === 0) return [] as ScheduledTask[];

    const claim = db.prepare(
      `
      UPDATE scheduled_tasks
      SET status = 'running'
      WHERE id = ? AND status = 'active'
    `,
    );

    const claimed: ScheduledTask[] = [];
    for (const task of dueTasks) {
      const info = claim.run(task.id);
      if (info.changes > 0) {
        claimed.push({ ...task, status: 'running' });
      }
    }

    return claimed;
  })();
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE
      WHEN status = 'paused' THEN 'paused'
      WHEN ? IS NULL THEN 'completed'
      ELSE 'active'
    END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Session accessors (thread-aware) ---

export function getSession(
  agentFolder: string,
  chatJid: string,
  threadTs: string,
): string | undefined {
  const row = db
    .prepare(
      'SELECT session_id FROM sessions WHERE agent_folder = ? AND chat_jid = ? AND thread_ts = ?',
    )
    .get(agentFolder, chatJid, threadTs) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(
  agentFolder: string,
  chatJid: string,
  threadTs: string,
  sessionId: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO sessions (agent_folder, chat_jid, thread_ts, session_id, created_at, last_active)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(agent_folder, chat_jid, thread_ts) DO UPDATE SET
       session_id = excluded.session_id,
       last_active = excluded.last_active`,
  ).run(agentFolder, chatJid, threadTs, sessionId, now, now);
}

export function deleteSession(
  agentFolder: string,
  chatJid?: string,
  threadTs?: string,
): void {
  if (chatJid && threadTs) {
    // Delete specific thread session
    db.prepare(
      'DELETE FROM sessions WHERE agent_folder = ? AND chat_jid = ? AND thread_ts = ?',
    ).run(agentFolder, chatJid, threadTs);
  } else if (chatJid) {
    // Delete all sessions for agent in a channel
    db.prepare(
      'DELETE FROM sessions WHERE agent_folder = ? AND chat_jid = ?',
    ).run(agentFolder, chatJid);
  } else {
    // Delete all sessions for agent
    db.prepare('DELETE FROM sessions WHERE agent_folder = ?').run(agentFolder);
  }
}

/**
 * Delete sessions older than the given number of days.
 * Returns the number of sessions deleted.
 */
export function cleanupOldSessions(maxAgeDays: number = 7): number {
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
  const result = db.prepare(
    'DELETE FROM sessions WHERE last_active < ?',
  ).run(cutoff);
  return result.changes;
}

// --- Agent cursor accessors ---

export function getAgentCursor(
  agentFolder: string,
  chatJid: string,
): string {
  const row = db
    .prepare(
      'SELECT last_processed_ts FROM agent_cursors WHERE agent_folder = ? AND chat_jid = ?',
    )
    .get(agentFolder, chatJid) as { last_processed_ts: string } | undefined;
  return row?.last_processed_ts ?? '';
}

export function setAgentCursor(
  agentFolder: string,
  chatJid: string,
  timestamp: string,
): void {
  db.prepare(
    `INSERT INTO agent_cursors (agent_folder, chat_jid, last_processed_ts)
     VALUES (?, ?, ?)
     ON CONFLICT(agent_folder, chat_jid) DO UPDATE SET last_processed_ts = excluded.last_processed_ts`,
  ).run(agentFolder, chatJid, timestamp);
}

export function getAllAgentCursors(): Record<string, string> {
  const rows = db
    .prepare('SELECT agent_folder, chat_jid, last_processed_ts FROM agent_cursors')
    .all() as Array<{ agent_folder: string; chat_jid: string; last_processed_ts: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[`${row.chat_jid}::${row.agent_folder}`] = row.last_processed_ts;
  }
  return result;
}

// --- Thread-aware message queries ---

/**
 * Get all messages in a specific thread.
 */
export function getThreadMessages(
  chatJid: string,
  threadTs: string,
): NewMessage[] {
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp, thread_ts,
           is_bot_message, agent_source
    FROM messages
    WHERE chat_jid = ? AND thread_ts = ?
      AND content != '' AND content IS NOT NULL
    ORDER BY timestamp
  `;
  interface RawRow {
    id: string;
    chat_jid: string;
    sender: string;
    sender_name: string;
    content: string;
    timestamp: string;
    thread_ts: string | null;
    is_bot_message: number;
    agent_source: string | null;
  }
  const rows = db.prepare(sql).all(chatJid, threadTs) as RawRow[];
  return rows.map((row) => ({
    id: row.id,
    chat_jid: row.chat_jid,
    sender: row.sender,
    sender_name: row.sender_name,
    content: row.content,
    timestamp: row.timestamp,
    thread_ts: row.thread_ts ?? undefined,
    is_bot_message: !!row.is_bot_message,
    agent_source: row.agent_source ?? undefined,
  }));
}

// --- Registered group accessors ---

type RegisteredGroupRow = {
  jid: string;
  name: string;
  folder: string;
  trigger_pattern: string;
  added_at: string;
  container_config: string | null;
  requires_trigger: number | null;
  role: string | null;
  aliases: string | null;
  gateway: string | null;
};

function mapRegisteredGroupRow(
  row: RegisteredGroupRow,
): (RegisteredGroup & { jid: string }) | undefined {
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }

  let aliases: string[];
  try {
    aliases = row.aliases ? JSON.parse(row.aliases) : [];
  } catch {
    aliases = [];
  }
  // Fallback: derive aliases from trigger if not stored
  if (aliases.length === 0) {
    const trigger = row.trigger_pattern?.trim();
    if (trigger) {
      const label = trigger.startsWith('@') ? trigger.slice(1) : trigger;
      if (label) aliases = [label];
    }
  }

  let gateway: AgentGateway;
  try {
    gateway = row.gateway ? JSON.parse(row.gateway) : { rules: [] };
  } catch {
    gateway = { rules: [] };
  }
  // Fallback: derive gateway from requiresTrigger if not stored
  if (gateway.rules.length === 0) {
    const requiresTrigger = row.requires_trigger === null ? undefined : row.requires_trigger === 1;
    if (requiresTrigger === false) {
      gateway = { rules: [{ match: 'any_message' }] };
    } else {
      gateway = { rules: [{ match: 'self_mention' }] };
    }
  }

  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    aliases,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger: row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    gateway,
    role: row.role ?? undefined,
  };
}

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare(
      `SELECT * FROM registered_groups WHERE jid = ? ORDER BY added_at DESC, folder LIMIT 1`,
    )
    .get(jid) as RegisteredGroupRow | undefined;
  if (!row) return undefined;
  return mapRegisteredGroupRow(row);
}

export function setRegisteredGroup(
  jid: string,
  group: RegisteredGroup,
): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  db.prepare(
    `INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, role, aliases, gateway)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(jid, folder) DO UPDATE SET
       name = excluded.name,
       trigger_pattern = excluded.trigger_pattern,
       added_at = excluded.added_at,
       container_config = excluded.container_config,
       requires_trigger = excluded.requires_trigger,
       role = excluded.role,
       aliases = excluded.aliases,
       gateway = excluded.gateway`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
    group.role ?? null,
    group.aliases?.length ? JSON.stringify(group.aliases) : null,
    group.gateway?.rules?.length ? JSON.stringify(group.gateway) : null,
  );
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db
    .prepare('SELECT * FROM registered_groups ORDER BY jid, added_at, folder')
    .all() as RegisteredGroupRow[];
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    const mapped = mapRegisteredGroupRow(row);
    if (!mapped) {
      continue;
    }
    const { jid, ...group } = mapped;
    result[jid] = group;
  }
  return result;
}

export function getAgentsByChannel(jid: string): RegisteredGroup[] {
  const rows = db
    .prepare(
      'SELECT * FROM registered_groups WHERE jid = ? ORDER BY added_at, folder',
    )
    .all(jid) as RegisteredGroupRow[];

  const groups: RegisteredGroup[] = [];
  for (const row of rows) {
    const mapped = mapRegisteredGroupRow(row);
    if (!mapped) continue;
    const { jid: _jid, ...group } = mapped;
    groups.push(group);
  }
  return groups;
}

/**
 * Get all unique agents (deduplicated by folder) across all channels.
 */
export function getAllUniqueAgents(): RegisteredGroup[] {
  const rows = db
    .prepare(
      'SELECT * FROM registered_groups ORDER BY added_at, folder',
    )
    .all() as RegisteredGroupRow[];

  const seen = new Set<string>();
  const agents: RegisteredGroup[] = [];
  for (const row of rows) {
    if (seen.has(row.folder)) continue;
    seen.add(row.folder);
    const mapped = mapRegisteredGroupRow(row);
    if (!mapped) continue;
    const { jid: _jid, ...group } = mapped;
    agents.push(group);
  }
  return agents;
}

export function getChannelsForAgent(folder: string): string[] {
  const rows = db
    .prepare(
      'SELECT DISTINCT jid FROM registered_groups WHERE folder = ? ORDER BY jid',
    )
    .all(folder) as Array<{ jid: string }>;
  return rows.map((row) => row.jid);
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    // Agent cursors are now migrated to agent_cursors table in createSchema
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json (old format: { folder: sessionId })
  // New sessions are thread-aware; old ones are discarded since we can't
  // determine which channel/thread they belonged to.
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    logger.info('Old sessions.json found and archived (sessions will be recreated)');
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}
