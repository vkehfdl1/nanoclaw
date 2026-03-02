# NanoClaw Agent Team Upgrade — Agent Context

## Project Overview

NanoClaw is a personal AI assistant platform that runs Claude agents in isolated Docker containers, connected to Slack channels. This upgrade transforms it from a single-agent system into a multi-agent team.

## Architecture

- **Host process** (`src/index.ts`): Node.js orchestrator that manages Slack connections, message routing, IPC, and container lifecycle.
- **Containers**: Each agent runs in an isolated Docker container with its own filesystem, Claude session, and MCP tools.
- **IPC**: File-based JSON protocol at `/data/ipc/{group_folder}/` — messages, tasks, and responses.
- **Database**: SQLite at `store/messages.db` — messages, sessions, registered groups, scheduled tasks.

## Key Source Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Main orchestrator: message loop, agent invocation, state management |
| `src/channels/slack.ts` | Slack channel: Socket Mode connection, message/mention handling |
| `src/channels/slack-pm-mention.ts` | PM agent @mention context extraction |
| `src/db.ts` | SQLite schema, queries, migrations |
| `src/types.ts` | Core TypeScript interfaces |
| `src/container-runner.ts` | Docker container spawning, mount management, streaming output |
| `src/ipc.ts` | IPC file watcher, task processing, authorization |
| `src/group-queue.ts` | Container concurrency management |
| `src/task-scheduler.ts` | Cron/interval task execution |
| `src/agent-schedule-bootstrap.ts` | Loads schedule.json from group folders at startup |
| `src/router.ts` | Message formatting, outbound sanitization |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | MCP server inside containers (tools agents can call) |
| `container/agent-runner/src/index.ts` | Container entrypoint, Claude invocation |

## Current Database Schema (relevant tables)

```sql
-- Agent registration (currently jid=PK, folder=UNIQUE)
CREATE TABLE registered_groups (
  jid TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  folder TEXT NOT NULL UNIQUE,
  trigger_pattern TEXT NOT NULL,
  added_at TEXT NOT NULL,
  container_config TEXT,
  requires_trigger INTEGER DEFAULT 1,
  role TEXT
);

-- Messages
CREATE TABLE messages (
  id TEXT,
  chat_jid TEXT,
  sender TEXT,
  sender_name TEXT,
  content TEXT,
  timestamp TEXT,
  is_from_me INTEGER,
  is_bot_message INTEGER DEFAULT 0,
  thread_ts TEXT,
  PRIMARY KEY (id, chat_jid)
);
```

## Conventions

- **TypeScript** with strict mode. ESM modules (`import/export`).
- **Group folders** at `groups/{name}/` — contain `CLAUDE.md`, `schedule.json`, `.nanoclaw/subagents.json`.
- **IPC files**: written atomically (`.tmp` then rename to `.json`). Consumed files are deleted.
- **Bot messages**: currently filtered at 3 layers (slack.ts:77, db.ts:319, db.ts:347). Cross-agent messages must bypass these.
- **Container mounts**: validated against `~/.config/nanoclaw/mount-allowlist.json`.

## Build & Test

```bash
npm run build        # TypeScript compilation
npm test             # Run test suite
npm run dev          # Development with hot reload
./container/build.sh # Rebuild agent container image
```

## Mount Architecture for PM Agents

PM agents get their project repo mounted read-only so they can browse code to understand context. Heavy directories are excluded via tmpfs overlays.

```typescript
// AdditionalMount interface (src/types.ts) — extended with excludePatterns
interface AdditionalMount {
  hostPath: string;
  containerPath?: string;
  readonly?: boolean;
  excludePatterns?: string[];  // NEW: directories to mask with empty tmpfs
}

// Example PM agent containerConfig:
{
  "additionalMounts": [{
    "hostPath": "~/.nanoclaw/repos/autorag-research",
    "containerPath": "autorag-research",
    "readonly": true,
    "excludePatterns": ["node_modules", ".venv", "dist", ".git/objects", "__pycache__"]
  }],
  "envVars": {
    "GITHUB_REPO": "owner/autorag-research",
    "ALLOWED_REPOS": "autorag-research"
  }
}
```

The `buildVolumeMounts()` function in `container-runner.ts` generates both the bind mount and `--tmpfs` flags:
```
-v /host/repo:/workspace/extra/autorag-research:ro
--tmpfs /workspace/extra/autorag-research/node_modules
--tmpfs /workspace/extra/autorag-research/.venv
```

## Important Notes for Implementation

1. **Schema migrations**: Use try/catch ALTER TABLE pattern (see existing migrations in `db.ts` `createSchema()`).
2. **IPC authorization**: Main group can access everything. Non-main groups restricted to their own folder/JID.
3. **Codex CLI**: Install `@openai/codex` globally on host. Run with `codex exec --full-auto --sandbox danger-full-access`.
4. **Slack API**: Single bot token for all agents. Use `conversations.members` for channel member lists.
5. **No breaking changes**: Existing Dobby and Todomon agents must continue working unchanged.
6. **Mount exclusions**: Use `--tmpfs` overlay technique to mask heavy directories. Docker bind mounts don't support native exclusions, so tmpfs on top of a read-only bind mount effectively hides those directories.
7. **PM code reading workflow**: PM reads code at `/workspace/extra/{repo}/` → understands context → crafts specific Codex prompt with file paths, existing patterns, and implementation goals → sends to `codex_exec` MCP tool.
