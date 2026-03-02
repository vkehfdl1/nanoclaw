# NanoClaw Agent Team Topology

> Architecture document defining all agents, their roles, hierarchy, and ownership relationships in the NanoClaw multi-agent system.

---

## Overview

NanoClaw operates as a **hierarchical multi-agent team** built on top of the NanoClaw orchestration platform. Each agent runs in an isolated container with its own filesystem and memory. Agents communicate via IPC files, scheduled tasks, and the `mcp__nanoclaw__send_message` tool. No agent can directly invoke another agent's container — all cross-agent coordination flows through the IPC layer.

```
                            ┌─────────────────┐
                            │   USER (human)  │
                            │ WhatsApp / Slack │
                            └────────┬────────┘
                                     │ messages & approvals
                            ┌────────▼────────┐
                            │     DOBBY       │ ← Primary agent
                            │  (main agent)   │   WhatsApp channel
                            └──┬──────────┬──┘
                               │          │
              ┌────────────────┘          └─────────────────┐
              │                                             │
   ┌──────────▼──────────┐                    ┌────────────▼────────────┐
   │      TODOMON         │                    │        MARKETER         │
   │  (todo management)   │                    │  (marketing specialist) │
   └─────────────────────┘                    └─────────────────────────┘

              PM AGENTS (one per project, n instances)
   ┌──────────────────────────────────────────────────────────────────┐
   │  PM Agent (pm-myproject)   │  PM Agent (pm-otherapp)  │  ...     │
   │  Slack channel: #myproject │  Slack: #otherapp        │          │
   │                            │                          │          │
   │  ┌─────────┐ ┌──────────┐  │  ┌─────────┐ ┌───────┐  │          │
   │  │  Codex  │ │ Reviewer │  │  │  Codex  │ │Review.│  │          │
   │  │(sub-agt)│ │(sub-agt) │  │  │(sub-agt)│ │(s-ag.)│  │          │
   │  └─────────┘ └──────────┘  │  └─────────┘ └───────┘  │          │
   └──────────────────────────────────────────────────────────────────┘
```

---

## Agent Definitions

### 1. Dobby — Main Agent

| Attribute | Value |
|-----------|-------|
| **Group folder** | `groups/dobby/` |
| **Channel** | WhatsApp DMs / main chat |
| **Trigger** | All messages (no trigger required) |
| **Container mounts** | Project root (read-only) + `groups/dobby/` (read-write) |
| **Model** | Default (configurable via `containerConfig.model`) |
| **Persistence** | `groups/dobby/` — approvals, agent registry, PM summaries, preferences |

**Role:** Dobby is the primary user-facing interface and orchestrator of the entire agent team. Users interact with Dobby for most tasks. Dobby understands intent and decides whether to handle a request itself or delegate to a specialist agent.

**Responsibilities:**
- First point of contact for all user requests
- Routes and delegates tasks to Todomon, Marketer, and PM agents
- Gates all Marketer posts through the WhatsApp approval flow (async, human-in-the-loop)
- Surfaces important updates, escalations, and summaries from PM agents to the user
- Maintains global context and cross-agent memory
- Has admin-level read access to all group configurations and the SQLite database
- Schedules cross-agent tasks using `target_group_jid`

**Hierarchy position:** Top of the agent hierarchy. Dobby can issue tasks to all other agents. All agents can escalate to Dobby.

---

### 2. Todomon — Todo Management Assistant

| Attribute | Value |
|-----------|-------|
| **Group folder** | `groups/todomon/` |
| **Channel** | WhatsApp (delegated from Dobby) |
| **Trigger** | Via Dobby delegation or direct @mention |
| **Container mounts** | `groups/todomon/` (read-write) |
| **Model** | Default |
| **Persistence** | `groups/todomon/todos/`, `groups/todomon/reviews/` |

**Role:** Todomon is a focused specialist agent whose sole domain is todo and task management across all projects and contexts.

**Responsibilities:**
- Capture new todos from Dobby, PM agents, and direct user requests
- Organize todos by project, priority, and due date
- Track task lifecycle: pending → in-progress → done → archived
- Surface overdue and upcoming tasks proactively via scheduled daily review (8:00 AM daily)
- Consolidate todos from all agents into a unified view
- Report task completion and blockers back to Dobby or the originating agent

**Hierarchy position:** Peer-level specialist under Dobby. Receives work from Dobby and PM agents. Reports back to the requesting agent. Cannot access other agents' filesystems directly — routes through Dobby for cross-agent data.

**Owned files:**
```
groups/todomon/
├── todos/
│   ├── inbox.md           # Unprocessed incoming todos
│   ├── active.md          # In-progress tasks
│   ├── backlog.md         # Captured but unscheduled
│   ├── done.md            # Completed (rolling 30-day)
│   └── projects/          # Per-project task lists
└── reviews/               # Daily/weekly review snapshots
```

---

### 3. Marketer — Marketing Specialist Agent

| Attribute | Value |
|-----------|-------|
| **Group folder** | `groups/marketer/` |
| **Channel** | WhatsApp (delegated from Dobby or PM agents) |
| **Trigger** | Via IPC task from Dobby or PM agents; self-initiated on schedule |
| **Container mounts** | `groups/marketer/` (read-write) + SecondBrain inbox (read-write, if mounted) |
| **Model** | Default |
| **SNS API credentials** | Injected via `containerConfig` environment variables |
| **Persistence** | `groups/marketer/drafts/`, `brand/`, `research/`, `published/`, `approvals/`, `campaigns/` |

**Role:** Marketer manages the user's digital presence across social networks (X/Twitter, LinkedIn, Threads, Instagram, etc.), promotes projects, and handles personal branding.

**Responsibilities:**
- Research social network trends and competitor activity (weekly minimum, on-demand)
- Create and schedule content across SNS platforms
- Promote projects using SecondBrain inbox data as signal
- Grow the user's personal brand and influencer reach
- Seek Dobby approval before every new post (async WhatsApp flow)
- Respond to comments autonomously after posts are published (no approval needed for replies)
- Escalate sensitive comments (legal, PR crisis, business inquiries) to Dobby

**Hierarchy position:** Peer-level specialist under Dobby. Receives requests from Dobby and PM agents. All new post content must pass through Dobby's approval gate before publishing. Replies to existing posts are autonomous.

**Approval flow:**
```
Marketer drafts post
      ↓
Writes approval request to IPC
      ↓
Dobby forwards draft to user via WhatsApp
      ↓
User: approve / reject / edit instructions
      ↓
Dobby writes approval response to IPC
      ↓
Marketer publishes (or revises / discards)
```

**Owned files:**
```
groups/marketer/
├── brand/
│   ├── profile.md         # User brand identity and goals
│   └── metrics.md         # Follower and engagement tracking
├── research/
│   └── trends-YYYY-MM.md  # Monthly trend research archives
├── drafts/
│   ├── YYYY-MM-DD-slug.md # Content drafts
│   └── archived/          # Rejected drafts with notes
├── published/
│   ├── log.md             # Published post registry
│   └── comments-log.md    # Comment response history
├── approvals/
│   └── log.md             # Dobby approval audit trail
└── campaigns/             # Multi-post campaign plans
```

---

### 4. PM Agents — Per-Project Managers

| Attribute | Value |
|-----------|-------|
| **Group folder** | `groups/pm-{project}/` (one per project) |
| **Channel** | Slack (one dedicated channel per project) |
| **Trigger** | @mention in their Slack channel |
| **Container mounts** | `groups/pm-{project}/` (read-write) + project codebase (read-write) + SecondBrain inbox (read-write) |
| **Model** | Default |
| **CLI tools** | GitHub CLI (`gh`), git |
| **Persistence** | `groups/pm-{project}/memory/`, `specs/`, `conversations/` |

**Role:** PM agents are project managers embedded in Slack channels. Each PM agent instance is scoped to exactly one software project. PM agents bridge the gap between human team communication in Slack and autonomous engineering work, and they coordinate sub-agents (Codex, Reviewer) for implementation and review tasks.

**Responsibilities:**
1. **Slack @mention handling** — Respond to team @mentions in their Slack channel; acknowledge immediately, then do the work
2. **SecondBrain summarization** — After every substantial thread, write structured insights to the SecondBrain inbox
3. **GitHub operations** — Manage issues, PRs, labels, comments via the `gh` CLI
4. **Direct codebase access** — Read and write to the project codebase for small edits, context lookups, and pre-Codex exploration
5. **Codex sub-agent spawning** — Write implementation specs and spawn Codex for any task >10 lines or touching multiple files
6. **Reviewer sub-agent spawning** — After Codex submits a PR, trigger Reviewer to post GitHub PR review comments
7. **Issue processing** — Triage GitHub issues: if spec is complete enough, implement via Codex and submit PR directly; if unclear, post a clarifying comment

**Hierarchy position:** Peer-level specialists under Dobby. PM agents receive strategic direction from Dobby and escalate decisions outside their scope (budget, major architecture, priorities) back to Dobby. PM agents own Codex and Reviewer sub-agents.

**Owned files:**
```
groups/pm-{project}/
├── memory/
│   ├── context.md         # Current sprint, active issues, team members
│   ├── decisions.md       # Architecture decisions (append-only)
│   ├── standup.md         # Recent standup notes
│   └── glossary.md        # Project-specific terminology
├── specs/
│   └── {task-id}.md       # Implementation specs for Codex
└── conversations/         # Slack conversation history
```

---

### 5. Codex — Implementation Sub-agent

> **Owned by:** Each PM agent instance owns its own Codex sub-agent.

| Attribute | Value |
|-----------|-------|
| **Definition location** | `groups/pm-{project}/.nanoclaw/subagents.json` |
| **Invoked by** | PM agent (via Task tool) |
| **Codebase access** | Full read-write to `/workspace/codebase/` |
| **Tools** | Read, Edit, Write, Bash, Glob, Grep |
| **Model** | `sonnet` |
| **Lifecycle** | Ephemeral — spawned per implementation task, exits when PR is open |

**Role:** Codex is a focused software engineer sub-agent that receives a structured spec and autonomously implements the described task on the project codebase.

**Responsibilities:**
- Read and interpret the spec file at `/workspace/group/specs/{task-id}.md`
- Explore the codebase to understand existing patterns and structure
- Create a feature branch (`fix/issue-N` or `feat/...`)
- Implement the task: write code, update tests, follow existing patterns
- Commit changes and push the branch
- Open a PR via `gh pr create` with a descriptive title and body
- Return the PR URL to the spawning PM agent

**Hierarchy position:** Sub-agent, owned and invoked by PM agents. Has no communication channel of its own — reports results back to the PM agent that spawned it. Does not communicate with Dobby or other agents directly.

**Structured spec input format:**
```markdown
# Spec: {Short Title}

## Goal
{One sentence: what should exist or work after this task}

## Context
- Related issue: #{ISSUE_NUMBER}
- Related files: {list key files}
- Depends on: {prerequisites}

## Acceptance Criteria
- [ ] {Specific, testable criterion}
- [ ] Tests pass: `{test command}`

## Implementation Notes
{Optional: approach hints, patterns to follow, things to avoid}

## Out of Scope
{What this task should NOT change}
```

---

### 6. Reviewer — PR Review Sub-agent

> **Owned by:** Each PM agent instance owns its own Reviewer sub-agent.

| Attribute | Value |
|-----------|-------|
| **Definition location** | `groups/pm-{project}/.nanoclaw/subagents.json` |
| **Invoked by** | PM agent (via Task tool), typically after Codex opens a PR |
| **Codebase access** | Read access to `/workspace/codebase/` + `gh` CLI for PR operations |
| **Tools** | Bash, Read, Grep, Glob |
| **Model** | `sonnet` |
| **Lifecycle** | Ephemeral — spawned per PR review task, exits when review is submitted |

**Role:** Reviewer is a senior code reviewer sub-agent that reads a GitHub PR, analyzes the diff and surrounding codebase context, and posts structured review comments directly on the GitHub PR.

**Responsibilities:**
- Read the PR diff via `gh pr diff {pr_number}`
- Checkout the branch for broader codebase context
- Review for: correctness, security, test coverage, performance, and adherence to project patterns
- Post inline comments on specific lines using `gh api repos/{repo}/pulls/{pr}/comments`
- Submit the review as `APPROVE`, `REQUEST_CHANGES`, or `COMMENT` based on severity of findings
- Be specific and constructive — reference line numbers and explain the concern

**Hierarchy position:** Sub-agent, owned and invoked by PM agents. Posts review comments directly to GitHub. Reports summary results back to the PM agent that spawned it. Does not communicate with Dobby or other agents directly.

**GitHub comment methods:**
```bash
# Overall review with body
gh pr review {pr} --repo {repo} --approve --body "Looks good!"
gh pr review {pr} --repo {repo} --request-changes --body "See inline comments."

# Inline comment on a specific line
gh api repos/{repo}/pulls/{pr}/comments \
  --method POST \
  --field commit_id="{head_sha}" \
  --field path="src/auth/login.ts" \
  --field line=42 \
  --field body="This doesn't handle null token. Add a guard here."
```

---

## Hierarchy Summary

```
USER (human)
└── DOBBY (main agent) — admin, orchestrator, approval gate
    ├── TODOMON — todo specialist (receives delegated tasks)
    ├── MARKETER — marketing specialist (all posts require Dobby approval)
    └── PM AGENTS (n instances, one per project)
        ├── CODEX sub-agent — ephemeral, spawned per implementation task
        └── REVIEWER sub-agent — ephemeral, spawned per PR review
```

### Authority and Delegation

| From | Can delegate to | Mechanism |
|------|----------------|-----------|
| User | Dobby | WhatsApp / Slack message |
| Dobby | Todomon | IPC task file |
| Dobby | Marketer | IPC task file |
| Dobby | PM agents | IPC task file |
| Dobby | All agents (scheduling) | `schedule_task` with `target_group_jid` |
| PM agent | Codex | Task tool (sub-agent spawn) |
| PM agent | Reviewer | Task tool (sub-agent spawn) |
| PM agent | Marketer | IPC task file (`marketer_request` type) |
| PM agent | Todomon | IPC task file |
| Todomon | — | No delegation (specialist, no sub-agents for routing) |
| Marketer | — | No delegation to other agents (except escalation to Dobby) |
| Codex | — | No delegation (ephemeral implementer) |
| Reviewer | — | No delegation (ephemeral reviewer) |

### Escalation Paths

| Agent | Escalates to | When |
|-------|-------------|------|
| Todomon | Dobby | Out-of-scope requests, ambiguous priorities |
| Marketer | Dobby | Sensitive comment responses, approval requests |
| PM agent | Dobby | Budget decisions, major architecture changes, priority conflicts |
| Codex | PM agent (result) | After PR is opened (success) or on spec ambiguity (failure) |
| Reviewer | PM agent (result) | After review is submitted |

---

## Ownership Relationships

### Agent ↔ Channel Ownership

| Agent | Owned Channel(s) | Channel Type |
|-------|-----------------|--------------|
| Dobby | WhatsApp DMs, main chat | WhatsApp |
| Todomon | n/a (receives delegated tasks) | — |
| Marketer | n/a (receives delegated tasks) | — |
| PM agent (per project) | `#{project-name}` Slack channel | Slack |

### Agent ↔ Filesystem Ownership

| Agent | Owns (read-write) | Can Read |
|-------|------------------|----------|
| Dobby | `groups/dobby/` | Project root (read-only), `groups/global/CLAUDE.md` |
| Todomon | `groups/todomon/` | `groups/global/CLAUDE.md` |
| Marketer | `groups/marketer/`, SecondBrain inbox | `groups/global/CLAUDE.md` |
| PM agent | `groups/pm-{project}/`, project codebase, SecondBrain inbox | `groups/global/CLAUDE.md` |
| Codex | Project codebase, `groups/pm-{project}/specs/` | — |
| Reviewer | — (read-only) | Project codebase |

### Sub-agent Ownership (per PM agent instance)

Each PM agent instance (e.g., `pm-webapp`, `pm-api`) owns its own Codex and Reviewer sub-agent definitions. These are defined in:

```
groups/pm-{project}/.nanoclaw/subagents.json
```

Sub-agents are **ephemeral** — they exist only for the duration of a task. The PM agent is responsible for:
- Writing spec files before spawning Codex
- Providing PR number when spawning Reviewer
- Receiving and acting on sub-agent results (post to Slack, notify Dobby if needed)

---

## Communication Patterns

### IPC Task File Protocol

Agents communicate by writing JSON files to `/workspace/ipc/tasks/`. The host NanoClaw orchestrator reads these files and dispatches them.

**Message types:**

```json
// Agent delegation
{
  "type": "task",
  "target_group_folder": "marketer",
  "prompt": "Create promotional content for nanoclaw v2 release"
}

// Marketer approval request (Marketer → Dobby)
{
  "type": "marketer_approval_request",
  "request_id": "<uuid>",
  "platform": "x",
  "draft": "Post text here...",
  "context": "nanoclaw v2 release announcement",
  "expires_at": "2026-03-03T12:00:00Z"
}

// Marketer approval response (Dobby → Marketer)
{
  "type": "marketer_approval_response",
  "request_id": "<uuid>",
  "decision": "approved",
  "edited_content": null
}

// PM agent escalation (PM → Dobby)
{
  "type": "pm_escalation",
  "from_agent": "pm-webapp",
  "priority": "high",
  "subject": "PR #42 needs decision",
  "body": "Details...",
  "action_needed": "Approve merge or request changes",
  "github_url": "https://github.com/user/webapp/pull/42"
}
```

### SecondBrain Integration

Both PM agents and Marketer write to the SecondBrain inbox:

- **PM agents** → write `pm_insight` files capturing decisions, bugs, features, retros
- **Marketer** → reads SecondBrain for project signals to inform content strategy

File format: `{agent}_{timestamp}.md` in `/workspace/secondbrain/inbox/` (mapped to the SecondBrain directory on the host).

### Scheduled Cross-Agent Tasks

Dobby can schedule recurring tasks for any agent using `schedule_task` with `target_group_jid`:

```
schedule_task(
  prompt: "Weekly project status summary",
  schedule_type: "cron",
  schedule_value: "0 9 * * 5",   // Friday 9am
  target_group_jid: "<pm-webapp jid>"
)
```

PM agents can schedule their own recurring tasks (e.g., weekly issue triage, daily standup notes) within their own group context.

---

## Agent Lifecycle

### Persistent Agents

Dobby, Todomon, Marketer, and PM agents are **persistent** in the sense that they maintain memory across sessions via their group folder files. However, each invocation still runs as a fresh container instance. Session continuity is maintained via session IDs stored in the SQLite database.

### Ephemeral Sub-agents (Codex, Reviewer)

Codex and Reviewer sub-agents are **ephemeral** — they exist only for the duration of a single task:

1. PM agent writes spec (Codex) or provides PR number (Reviewer)
2. PM agent spawns sub-agent via Task tool
3. Sub-agent executes task (implements + opens PR, or reviews + comments)
4. Sub-agent returns result to PM agent
5. Container exits; sub-agent has no persistent state of its own

---

## Instance Multiplicity

| Agent | Instances | How Many |
|-------|-----------|---------|
| Dobby | 1 | Always singleton — main user interface |
| Todomon | 1 | Always singleton — unified todo manager |
| Marketer | 1 | Always singleton — unified brand voice |
| PM agents | N (one per project) | Created when a new project Slack channel is registered; folder: `groups/pm-{project}/` |
| Codex sub-agents | N (ephemeral) | Spawned on demand by any PM agent; one per active implementation task |
| Reviewer sub-agents | N (ephemeral) | Spawned on demand by any PM agent; one per active PR review |

PM agents are registered like any NanoClaw group — the main agent (Dobby) registers the Slack channel with the appropriate `pm-{project}` folder and mounts. Each PM agent instance is independent and maintains its own memory, codebase mount, and sub-agent definitions.

---

## Security Model

The multi-agent hierarchy enforces these security boundaries:

| Rule | Implementation |
|------|---------------|
| Sub-agents cannot escalate beyond PM agent | Codex/Reviewer have no IPC write access to non-PM paths |
| Marketer posts require human approval | Async WhatsApp gate enforced by Dobby |
| PM agents cannot read other PM agents' files | Each PM agent mounts only its own group folder |
| Only Dobby can schedule for any group | `target_group_jid` only respected for main-level groups |
| All agents read global memory (read-only) | `groups/global/CLAUDE.md` mounted read-only for all |
| SecondBrain write access scoped per mount | Only agents with SecondBrain mount can write to inbox |

---

## Adding a New PM Agent

When the user asks Dobby to set up a PM agent for a new project:

1. **Create the group folder**: `groups/pm-{project}/`
2. **Copy the base CLAUDE.md**: from `groups/pm-agent/CLAUDE.md` as the template
3. **Register the group** in `registered_groups.json` with:
   - `folder: "pm-{project}"`
   - `containerConfig.additionalMounts` including the project codebase and SecondBrain
   - `containerConfig.env` including `GITHUB_REPO`
4. **Configure the Slack channel** for the project: link the Slack channel JID to the registered group
5. **Create subagents.json**: with Codex and Reviewer definitions for this PM agent instance
6. **Seed memory files**: `memory/context.md` with project name, repo, and team members

The new PM agent is now live and will respond to @mentions in its Slack channel.
