# NanoClaw Multi-Agent Architecture

This document describes the multi-agent team system built on NanoClaw. Each agent runs in an isolated container with its own filesystem, memory, and credentials. Agents coordinate through a file-based IPC bus and the NanoClaw MCP scheduler.

---

## Table of Contents

1. [Agent Roles](#1-agent-roles)
2. [System Overview](#2-system-overview)
3. [IPC Transport Layer](#3-ipc-transport-layer)
4. [Inter-Agent Communication Flows](#4-inter-agent-communication-flows)
   - 4.1 [PM ↔ Dobby](#41-pm--dobby)
   - 4.2 [PM ↔ Marketer](#42-pm--marketer)
   - 4.3 [PM → Codex Sub-agent](#43-pm--codex-sub-agent)
   - 4.4 [PM → Reviewer Sub-agent](#44-pm--reviewer-sub-agent)
   - 4.5 [Marketer → User Approval Flow](#45-marketer--user-approval-flow)
   - 4.6 [Dobby → Todomon](#46-dobby--todomon)
5. [Container Topology](#5-container-topology)
6. [SecondBrain Integration](#6-secondbrain-integration)
7. [Agent Registry](#7-agent-registry)
8. [External System Integration Flows](#8-external-system-integration-flows)
   - 8.1 [WhatsApp](#81-whatsapp)
   - 8.2 [Slack](#82-slack)
   - 8.3 [GitHub](#83-github)
   - 8.4 [SecondBrain](#84-secondbrain)
   - 8.5 [Integration Summary Matrix](#85-integration-summary-matrix)
   - 8.6 [End-to-End Flow: GitHub Issue → Merged PR](#86-end-to-end-flow-github-issue--merged-pr)
   - 8.7 [End-to-End Flow: Marketer Content → Published Post](#87-end-to-end-flow-marketer-content--published-post)

---

## 1. Agent Roles

| Agent | Group Folder | Channel | Primary Function |
|-------|-------------|---------|-----------------|
| **Dobby** | `groups/dobby/` | WhatsApp (main DM) | Main orchestrator, user-facing interface, gatekeeper for Marketer posts |
| **Todomon** | `groups/todomon/` | WhatsApp (group or DM) | Todo & task management for all agents |
| **Marketer** | `groups/marketer/` | Internal only | SNS content creation, personal branding, influencer growth |
| **PM Agent** | `groups/pm-{project}/` | Slack (per-project channel) | Per-project manager: GitHub ops, Codex/Reviewer spawning, SecondBrain summaries |

PM agents are instantiated per project. A project named `webapp` creates `groups/pm-webapp/` and lives in the `#webapp` Slack channel.

---

## 2. System Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              USER                                            │
│                    (WhatsApp / Slack @mentions)                              │
└────────────────────────────┬────────────────────────────────────────────────┘
                             │
                    ┌────────▼────────┐
                    │     DOBBY       │  ← main orchestrator
                    │  (WhatsApp DM)  │
                    └────┬───────┬───┘
                         │       │
           ┌─────────────┘       └──────────────┐
           │                                    │
  ┌────────▼────────┐                  ┌────────▼────────┐
  │    TODOMON      │                  │    MARKETER     │
  │ (task manager)  │                  │ (SNS / branding)│
  └─────────────────┘                  └────────┬────────┘
                                                │ approval request
                                       ┌────────▼────────┐
                                       │     DOBBY       │  ← approval gate
                                       └─────────────────┘

  ┌──────────────────────────────────────────────────────────┐
  │               PM AGENT (per project)                      │
  │              (Slack channel: #project)                    │
  │                                                           │
  │   @mention → PM Agent                                     │
  │        │                                                  │
  │        ├── GitHub ops (gh CLI)                           │
  │        ├── SecondBrain summaries                         │
  │        ├──▶ Codex sub-agent (implementation)             │
  │        ├──▶ Reviewer sub-agent (PR review)               │
  │        ├──▶ Marketer (promotion requests)                │
  │        └──▶ Dobby (escalations)                          │
  └──────────────────────────────────────────────────────────┘
```

---

## 3. IPC Transport Layer

All inter-agent communication uses a **file-based IPC bus**. Agents drop JSON files into a shared directory watched by the NanoClaw orchestrator.

### Directory

```
/workspace/ipc/tasks/          # host: data/ipc/tasks/
```

### Message Format

Every IPC message is a JSON file with a timestamped name:

```
{message_type}_{timestamp_ns}.json
```

Example: `delegate_1709380800000000000.json`

### Lifecycle

1. **Producer** writes a JSON file atomically to `/workspace/ipc/tasks/`
2. **IPC Watcher** (Node.js orchestrator) detects the new file
3. Watcher reads `target_group_folder` and routes to the correct agent container
4. The target agent receives the message as part of its next scheduled prompt
5. After processing, the file is moved to `/workspace/ipc/processed/`

### Base Schema

```json
{
  "type": "<message_type>",
  "request_id": "<uuid>",
  "source_agent": "<group_folder>",
  "target_group_folder": "<group_folder>",
  "created_at": "<ISO 8601 timestamp>"
}
```

Sub-agent spawning does **not** use the IPC bus — it uses the Claude Agent SDK's `Task` tool directly within the PM agent's container session.

---

## 4. Inter-Agent Communication Flows

### 4.1 PM ↔ Dobby

PM agents and Dobby communicate in two directions: PM sends **escalations** and **summaries** to Dobby; Dobby sends **directives** to PM agents.

#### PM → Dobby: Escalation

Triggered when a PM agent encounters a decision outside its authority (priorities, budgets, architecture changes, sensitive PR decisions).

```
PM Agent                      IPC Bus                    Dobby
   │                             │                          │
   │  write escalation file      │                          │
   │────────────────────────────▶│                          │
   │                             │  route to dobby group    │
   │                             │─────────────────────────▶│
   │                             │                          │ forward to user
   │                             │                          │ (WhatsApp)
   │                             │                          │
   │                             │                          │ receive user reply
   │                             │                          │
   │                             │  write directive file    │
   │                             │◀─────────────────────────│
   │  receive directive          │                          │
   │◀────────────────────────────│                          │
   │  act on decision            │                          │
```

**Escalation message** (`pm_escalation_{ts}.json`):

```json
{
  "type": "pm_escalation",
  "request_id": "esc-abc-123",
  "source_agent": "pm-webapp",
  "target_group_folder": "dobby",
  "priority": "high",
  "subject": "PR #42 needs merge decision",
  "body": "Codex submitted PR #42 for user auth. Two open concerns about token expiry (Reviewer: REQUEST_CHANGES). Team wants to ship Friday.",
  "action_needed": "Approve merge, request changes, or delay to next sprint",
  "github_url": "https://github.com/user/webapp/pull/42",
  "created_at": "2026-03-02T10:00:00Z"
}
```

**Directive response** (`pm_directive_{ts}.json`) — Dobby writing back after user decides:

```json
{
  "type": "pm_directive",
  "request_id": "esc-abc-123",
  "source_agent": "dobby",
  "target_group_folder": "pm-webapp",
  "action": "request_changes",
  "instructions": "Ask Codex to address the token expiry comment. Re-review before merge.",
  "created_at": "2026-03-02T10:15:00Z"
}
```

#### PM → Dobby: Summary

Triggered by a PM agent on a schedule (e.g., weekly Friday summary) or ad hoc.

```json
{
  "type": "pm_summary",
  "source_agent": "pm-webapp",
  "target_group_folder": "dobby",
  "period": "2026-W09",
  "highlights": [
    "Shipped PR #42: user auth",
    "3 issues closed",
    "1 issue blocked: waiting for design spec"
  ],
  "created_at": "2026-03-01T09:00:00Z"
}
```

Dobby stores summaries in `/workspace/group/pm_summaries/{agent}-{period}.md` and surfaces important items to the user.

#### Dobby → PM: Directive

Dobby can proactively direct a PM agent without waiting for an escalation:

```bash
# Dobby writes this file
echo '{
  "type": "task",
  "source_agent": "dobby",
  "target_group_folder": "pm-webapp",
  "prompt": "Triage GitHub issues opened in the last 24 hours and send me a summary"
}' > /workspace/ipc/tasks/delegate_$(date +%s%N).json
```

Dobby can also schedule recurring directives using `schedule_task` with `target_group_jid`:

```
schedule_task(
  prompt: "Summarize this week's GitHub activity and send to Dobby",
  schedule_type: "cron",
  schedule_value: "0 9 * * 5",
  target_group_jid: "<pm-webapp jid>"
)
```

---

### 4.2 PM ↔ Marketer

PM agents request marketing content from Marketer; Marketer may also query PM agents for project context (rare, typically through SecondBrain instead).

#### PM → Marketer: Promotion Request

Triggered when a PM agent determines that a project milestone, release, or event warrants social promotion.

```
PM Agent                      IPC Bus                   Marketer
   │                             │                          │
   │  write marketer_request     │                          │
   │────────────────────────────▶│                          │
   │                             │  route to marketer       │
   │                             │─────────────────────────▶│
   │                             │                          │ research + draft
   │                             │                          │ ask user for Slack approval
   │                             │                          │ publish (if approved)
```

**Promotion request** (`marketer_request_{ts}.json`):

```json
{
  "type": "marketer_request",
  "request_id": "mkt-xyz-456",
  "source_agent": "pm-webapp",
  "target_group_folder": "marketer",
  "project": "webapp",
  "goal": "announce v2.0 release",
  "context": "We shipped major auth overhaul and performance improvements. 3x faster login. SecondBrain summary attached.",
  "secondbrain_ref": "/workspace/secondbrain/inbox/pm_20260302_100000.md",
  "platforms": ["x", "linkedin"],
  "tone": "excited but professional",
  "timing": "within 48 hours",
  "created_at": "2026-03-02T10:00:00Z"
}
```

Marketer handles this asynchronously: researches, drafts content, then asks the user for approval directly in Slack before publishing (see §4.5).

#### Marketer → PM: Context Query (rare)

If Marketer needs project-specific context not available in SecondBrain, it sends a structured query to the relevant PM agent:

```json
{
  "type": "context_query",
  "source_agent": "marketer",
  "target_group_folder": "pm-webapp",
  "question": "What are the top 3 user-facing improvements in v2.0? Need concrete metrics if available.",
  "reply_deadline": "2026-03-02T18:00:00Z",
  "created_at": "2026-03-02T10:05:00Z"
}
```

---

### 4.3 PM → Codex Sub-agent

Codex is a **sub-agent** spawned inside the PM agent's container session — not a separate group. It receives a structured spec file and implements the task autonomously.

#### Spawn Pattern

```
PM Agent (container session)
   │
   │  1. Write spec file
   │     /workspace/group/specs/issue-42.md
   │
   │  2. Invoke Codex via Task tool
   │     (uses subagents.json definition)
   │
   ▼
Codex Sub-agent (same container, child process)
   │
   │  3. Read spec
   │  4. Navigate codebase at /workspace/codebase
   │  5. Implement changes
   │  6. git checkout -b fix/issue-42
   │  7. git commit + push
   │  8. gh pr create → returns PR URL
   │
   ▼
PM Agent (resumes)
   │
   │  9. Receive PR URL from Codex
   │  10. Post PR link to Slack
   │  11. Spawn Reviewer sub-agent (see §4.4)
```

#### Spec File Format

`/workspace/group/specs/{task-id}.md`:

```markdown
# Spec: Fix login redirect on mobile

## Goal
Users on mobile devices are correctly redirected after login to the page they originally requested.

## Context
- Related issue: #42
- Related files: src/auth/login.ts, src/middleware/redirect.ts
- Depends on: nothing (standalone fix)

## Acceptance Criteria
- [ ] POST /auth/login returns correct redirect URL on mobile user-agent
- [ ] Redirect preserves original query parameters
- [ ] Tests pass: `npm test -- --grep "login redirect"`

## Implementation Notes
Follow the pattern in src/middleware/cors.ts for user-agent detection.

## Out of Scope
Do not change desktop redirect behavior.
```

#### Codex Subagent Definition

Defined in `/workspace/group/.nanoclaw/subagents.json`:

```json
{
  "agents": {
    "codex": {
      "description": "Implementation agent with full codebase access. Give it a spec file path.",
      "prompt": "You are Codex, a focused software engineer. You receive a path to a spec file and implement the task described. Work on the codebase at /workspace/codebase. Follow existing code patterns. Write tests. Create a git branch, commit your changes, and push. Use the gh CLI to open a PR when done. Return the PR URL. Only implement what the spec says — nothing more.",
      "tools": ["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
      "model": "sonnet"
    }
  }
}
```

#### Invocation

```
Task: "Implement the task described in /workspace/group/specs/issue-42.md"
Subagent: codex
```

---

### 4.4 PM → Reviewer Sub-agent

Reviewer is a **sub-agent** spawned inside the PM agent's container session after Codex opens a PR.

#### Spawn Pattern

```
PM Agent (container session)
   │
   │  1. Receive PR URL from Codex (e.g., PR #17)
   │
   │  2. Invoke Reviewer via Task tool
   │
   ▼
Reviewer Sub-agent (same container, child process)
   │
   │  3. gh pr view 17 → read description and metadata
   │  4. gh pr diff 17 → read full diff
   │  5. Read surrounding code in /workspace/codebase for context
   │  6. Analyze: correctness, security, tests, performance, style
   │  7. Post inline comments via GitHub REST API
   │  8. Submit review: APPROVE | REQUEST_CHANGES | COMMENT
   │
   ▼
PM Agent (resumes)
   │
   │  9. Post review outcome to Slack
   │  10. If REQUEST_CHANGES → escalate to Dobby if user decision needed
   │      If APPROVE → optionally merge (if auto-merge policy allows)
```

#### Reviewer Subagent Definition

Defined in `/workspace/group/.nanoclaw/subagents.json`:

```json
{
  "agents": {
    "reviewer": {
      "description": "Code review agent. Give it a PR number. Posts inline GitHub review comments.",
      "prompt": "You are Reviewer, a senior engineer doing code review. You receive a PR number and repository (from env $GITHUB_REPO). Use gh CLI to read the PR diff and context. Review for correctness, security, test coverage, performance, and code style consistency. Post inline comments using 'gh api repos/$GITHUB_REPO/pulls/{pr}/comments'. Submit the review as APPROVE, REQUEST_CHANGES, or COMMENT using 'gh pr review'. Be specific and constructive.",
      "tools": ["Bash", "Read", "Grep", "Glob"],
      "model": "sonnet"
    }
  }
}
```

#### Invocation

```
Task: "Review PR #17 in owner/repo. Focus on security and test coverage."
Subagent: reviewer
```

#### GitHub PR Review Comment Format

Reviewer posts inline comments using the GitHub REST API:

```bash
# Get PR head commit SHA
PR_SHA=$(gh pr view 17 --repo $GITHUB_REPO --json headRefOid -q '.headRefOid')

# Post inline comment at a specific line
gh api repos/$GITHUB_REPO/pulls/17/comments \
  --method POST \
  --field commit_id="$PR_SHA" \
  --field path="src/auth/login.ts" \
  --field line=42 \
  --field body="This function doesn't handle the null token case. Add a guard before calling verify()."
```

Final review submission:

```bash
# Request changes
gh pr review 17 --repo $GITHUB_REPO \
  --request-changes \
  --body "Two issues require fixes before merge. See inline comments."

# Approve
gh pr review 17 --repo $GITHUB_REPO \
  --approve \
  --body "LGTM. Clean implementation with good test coverage."
```

---

### 4.5 Marketer → User Approval Flow

All new SNS posts, comments, and replies require explicit user approval in Slack before publishing. Marketer sends approval requests directly with `mcp__nanoclaw__send_message`; Dobby is not in this approval loop.

#### Full Flow

```
Marketer                                              User (Slack)
   │                                                       │
   │  1. Draft post/comment/reply                          │
   │  2. Save local draft or note                          │
   │                                                       │
   │  3. Send Korean approval request in Slack             │
   │──────────────────────────────────────────────────────▶│
   │                                                       │
   │  4. Wait for explicit approval / edits / hold         │
   │◀──────────────────────────────────────────────────────│
   │                                                       │
   │  5a. approved → publish/post reply                    │
   │  5b. edited → revise and ask again                    │
   │  5c. hold/rejected → keep local note only             │
```

#### Approval Message Format

Marketer sends Korean Slack messages in one of these forms:

```text
[승인 요청 - 게시물 초안]
플랫폼: X
목적: 출시 공지
근거: 실제 릴리스와 사용자 체감 개선
초안:
...

응답 방법: 승인 / 수정: ... / 보류
```

```text
[승인 요청 - 댓글/답글 초안]
플랫폼: LinkedIn
원문:
...

제안 답글:
...

응답 방법: 승인 / 수정: ... / 보류 / 답글하지 않음
```

#### Marketer Handling Rules

| User response | Marketer Action |
|---------------|-----------------|
| `승인` or explicit equivalent | Publish/post reply; log to local files |
| revision request | Revise the draft and ask again |
| `보류` / rejection | Keep the draft locally and do nothing further |

Silence is never treated as approval.

---

### 4.6 Dobby → Todomon

Dobby delegates all todo/task operations to Todomon via structured IPC messages.

#### Delegation Pattern

```bash
# Dobby writes a task for Todomon
echo '{
  "type": "task",
  "source_agent": "dobby",
  "target_group_folder": "todomon",
  "prompt": "[TODO:ADD] Review PR #42 for webapp [project:webapp] [due:2026-03-05] [priority:high] [from:dobby]"
}' > /workspace/ipc/tasks/delegate_$(date +%s%N).json
```

Todomon processes the structured message, adds the todo, and acknowledges back:

```bash
# Todomon replies
echo '{
  "type": "task_ack",
  "source_agent": "todomon",
  "target_group_folder": "dobby",
  "prompt": "✓ Added [#007] 'Review PR #42 for webapp' → active.md [due: 2026-03-05, high]"
}' > /workspace/ipc/tasks/ack_$(date +%s%N).json
```

PM agents may also delegate todos directly to Todomon using the same pattern.

---

## 5. Container Topology

Each agent runs in an isolated container with specific volume mounts:

### Dobby Container

```
/workspace/group/        ← groups/dobby/           (read-write)
/workspace/project/      ← project root             (read-only)
/workspace/ipc/          ← data/ipc/               (read-write, shared)
```

### Todomon Container

```
/workspace/group/        ← groups/todomon/          (read-write)
/workspace/ipc/          ← data/ipc/               (read-write, shared)
```

### Marketer Container

```
/workspace/group/        ← groups/marketer/         (read-write)
/workspace/ipc/          ← data/ipc/               (read-write, shared)
/workspace/extra/secondbrain/ ← SecondBrain inbox  (read)
```

Marketer environment variables (injected via container config):
- `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET`
- `LINKEDIN_ACCESS_TOKEN`
- `THREADS_ACCESS_TOKEN`

### PM Agent Container

```
/workspace/group/        ← groups/pm-{project}/    (read-write)
/workspace/codebase/     ← project source root      (read-write)
/workspace/secondbrain/  ← SecondBrain inbox        (read-write)
/workspace/ipc/          ← data/ipc/               (read-write, shared)
```

PM agent environment variables:
- `GITHUB_REPO` — `owner/repo` format, used by `gh` CLI
- `SLACK_CHANNEL` — Slack channel ID for this PM's project
- `PROJECT_NAME` — human-readable project name

Codex and Reviewer sub-agents inherit the PM agent container's mounts and environment — they run as child processes inside the same container session.

---

## 6. SecondBrain Integration

SecondBrain is a knowledge base populated by PM agents and consumed by Marketer.

### PM Agent → SecondBrain (write)

After every substantial Slack conversation or project event, PM agents write a Markdown insight file:

```bash
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
cat > /workspace/secondbrain/inbox/pm_${TIMESTAMP}.md << 'EOF'
---
type: pm-insight
project: webapp
date: 2026-03-02T10:00:00Z
tags: [feature, decision]
---

# Auth Overhaul Shipped (PR #42)

## What Happened
Team discussion in #webapp resolved the token expiry debate. Codex implemented sliding window expiry.

## Decision / Outcome
Use 24h sliding window with 7-day absolute maximum. JWT-based, no Redis dependency.

## Action Items
- [ ] Update API docs — pm-webapp
- [ ] Announce on SNS — marketer

## Context
PR #42: https://github.com/user/webapp/pull/42
EOF
```

### Marketer ← SecondBrain (read)

Marketer reads SecondBrain inbox files to identify content opportunities:

```
/workspace/extra/secondbrain/inbox/*.md   ← scanned for promotable events
```

Marketer extracts signals from insight files: milestones, metrics, notable decisions — then uses these to create authentic social content without fabricating information.

---

## 7. Agent Registry

Dobby maintains a registry of all known agents and their routing metadata:

`/workspace/group/agent_registry.json`:

```json
{
  "agents": {
    "todomon": {
      "group_folder": "todomon",
      "group_jid": "<whatsapp jid>",
      "type": "todomon"
    },
    "marketer": {
      "group_folder": "marketer",
      "group_jid": null,
      "type": "marketer"
    },
    "pm-webapp": {
      "group_folder": "pm-webapp",
      "group_jid": "<slack jid>",
      "type": "pm-agent",
      "project": "webapp",
      "github_repo": "user/webapp",
      "slack_channel": "C0123ABCD"
    },
    "pm-api": {
      "group_folder": "pm-api",
      "group_jid": "<slack jid>",
      "type": "pm-agent",
      "project": "api",
      "github_repo": "user/api",
      "slack_channel": "C0456EFGH"
    }
  }
}
```

Dobby reads this registry on startup to know which `target_group_folder` values to use when routing IPC messages. The registry is the single source of truth for agent routing; update it whenever a new PM agent is provisioned.

---

## 8. External System Integration Flows

This section is the definitive reference for how each agent interacts with the four primary external systems: **WhatsApp**, **Slack**, **GitHub**, and **SecondBrain**. For each system, the tables below document:

- **Agents**: which agents touch this system
- **Trigger**: what causes the interaction
- **Operations**: what API calls or tool invocations are performed
- **Data read**: what the agent reads from the system
- **Data written**: what the agent writes to the system

---

### 8.1 WhatsApp

WhatsApp is the **primary user-facing channel**. The user communicates with the system exclusively through WhatsApp DMs or group messages. Only Dobby communicates directly with WhatsApp; all other agents relay information through Dobby.

#### 8.1.1 Dobby ↔ WhatsApp (direct)

| Dimension | Details |
|-----------|---------|
| **Trigger** | Incoming user message matching the trigger pattern (e.g., `@Andy`) in a registered chat |
| **Trigger** | `pm_escalation` IPC file detected from a PM agent |
| **Operations** | `mcp__nanoclaw__send_message` — send immediately mid-run without blocking |
| **Operations** | Standard response text returned at end of agent run (router prefixes and sends) |
| **Data read** | Full conversation context since last agent interaction (timestamp + sender + text), delivered by the host router as a prompt |
| **Data written** | All text responses sent to the user |
| **Data written** | PM escalation summary (subject, body, action needed, GitHub URL) |
| **Formatting** | WhatsApp only: `*bold*`, `_italic_`, `•` bullets, ` ``` ` code blocks; no `##` headings, no `[text](url)` |

#### 8.1.2 Marketer approval no longer uses Dobby relay

Marketer approval now happens directly in Slack. There is no Marketer → Dobby → WhatsApp relay for post or reply approval.

#### 8.1.3 PM Agent → WhatsApp (via Dobby relay)

PM agents escalate to Dobby over IPC; Dobby forwards the escalation to the user on WhatsApp.

| Dimension | Details |
|-----------|---------|
| **Trigger** | PM agent encounters a decision outside its authority (merge decision, priority conflict, budget) |
| **Trigger** | PM agent sends a scheduled summary (weekly or on completion of a milestone) |
| **Operations** | Write `pm_escalation` or `pm_summary` IPC file → Dobby picks up and sends WhatsApp message |
| **Data written (to IPC)** | `priority`, `subject`, `body`, `action_needed`, `github_url` |
| **Data read (from IPC)** | `pm_directive` written by Dobby after receiving user's WhatsApp reply; contains `action` and `instructions` |

#### 8.1.4 Todomon → WhatsApp (via host router)

Todomon sends outbound task summaries using `mcp__nanoclaw__send_message`, which the host router delivers to the group that triggered the task (typically a WhatsApp DM or group).

| Dimension | Details |
|-----------|---------|
| **Trigger** | Daily scheduled review (8 AM cron); explicit request from Dobby or PM agent |
| **Operations** | `mcp__nanoclaw__send_message` with task status summary |
| **Data written** | Overdue tasks, upcoming tasks (48h), todo count by project |

---

### 8.2 Slack

Slack is the **operational channel for PM agents**. Each PM agent instance lives in exactly one Slack channel, one per project. No other agents interact with Slack.

#### 8.2.1 PM Agent ↔ Slack

| Dimension | Details |
|-----------|---------|
| **Trigger** | `@mention` of the PM agent in its dedicated Slack channel |
| **Trigger** | Scheduled issue scan (cron: weekday mornings, e.g., `0 9 * * 1-5`) |
| **Trigger** | End of an active thread (no new messages for 1+ hours) — triggers SecondBrain summary |
| **Operations** | `mcp__nanoclaw__send_message` — immediate acknowledgment before starting work |
| **Operations** | Final response text returned at end of agent run (router sends to Slack channel) |
| **Data read** | `@mention` message text; recent channel history since last agent interaction (delivered as prompt context) |
| **Data read** | Team member usernames/handles for `@tagging` in assignments |
| **Data written** | Acknowledgment messages ("Looking into that now…") |
| **Data written** | Results: issue triage summaries, PR links, review outcomes, task assignments, decision confirmations |
| **Data written** | PR URL after Codex opens a pull request |
| **Data written** | Reviewer outcome summary after review is submitted to GitHub |
| **Formatting** | Slack: `*bold*`, `` `code` ``, ` ``` ` code blocks, `-` or `•` bullets; paste URLs directly; no `##` headings; use threads for long replies |
| **Persistence** | Slack messages stored locally in `/workspace/group/conversations/` for cross-session recall |

#### 8.2.2 Codex sub-agent ↔ Slack

Codex does not interact with Slack. After submitting a PR, it returns the PR URL to the PM agent, which posts it to Slack.

#### 8.2.3 Reviewer sub-agent ↔ Slack

Reviewer does not post to Slack. Its output appears as GitHub PR review comments. The PM agent summarizes the outcome and posts it to the Slack channel.

---

### 8.3 GitHub

GitHub is used by PM agents and their Codex and Reviewer sub-agents. Dobby, Todomon, and Marketer do not interact with GitHub. All GitHub operations use the `gh` CLI, which is pre-authenticated inside the container. The target repository is injected as the `GITHUB_REPO` environment variable (`owner/repo` format).

#### 8.3.1 PM Agent ↔ GitHub

| Dimension | Details |
|-----------|---------|
| **Trigger** | @mention in Slack requesting a GitHub operation (create issue, list PRs, check status) |
| **Trigger** | Scheduled issue scan (cron: `0 9 * * 1-5`) |
| **Trigger** | Codex completes a PR → PM triggers Reviewer |
| **Trigger** | Dobby directive to triage issues or summarize GitHub activity |
| **Operations (read)** | `gh issue list --repo $GITHUB_REPO --state open` — list open issues |
| **Operations (read)** | `gh issue view <n> --repo $GITHUB_REPO` — read full issue body and comments |
| **Operations (read)** | `gh pr list --repo $GITHUB_REPO --state open` — list open PRs |
| **Operations (read)** | `gh pr diff <n> --repo $GITHUB_REPO` — read PR diff for context |
| **Operations (write)** | `gh issue create` — create a new issue from a Slack discussion |
| **Operations (write)** | `gh issue comment <n>` — post a clarifying question on a vague issue |
| **Operations (write)** | `gh pr merge <n> --squash` — merge an approved PR |
| **Data read** | Issue number, title, body, labels, comments; PR number, diff, checks status |
| **Data written** | New issues (title, body, labels); issue comments (clarifying questions); PR merges |
| **Local artifacts** | Spec file written to `/workspace/group/specs/{task-id}.md` before spawning Codex |

#### 8.3.2 Codex sub-agent ↔ GitHub

Codex is spawned by the PM agent with a spec file path. It implements the task and submits a PR.

| Dimension | Details |
|-----------|---------|
| **Trigger** | PM agent invokes Codex sub-agent after writing a spec file (issue assessed as implementation-ready) |
| **Operations (read)** | `gh issue view <n>` — reads issue for additional context beyond the spec |
| **Operations (write)** | `git checkout -b {branch-name}` — creates feature/fix branch |
| **Operations (write)** | `git add`, `git commit`, `git push` — commits implementation |
| **Operations (write)** | `gh pr create --repo $GITHUB_REPO --title ... --body ... --base main --head {branch}` — opens PR |
| **Data read** | Issue body; spec file at `/workspace/group/specs/{task-id}.md`; codebase at `/workspace/codebase/` |
| **Data written** | Modified source files on feature branch; PR (title, body referencing issue number) |
| **Returns** | PR URL (passed back to PM agent) |
| **Branch naming** | `fix/issue-{n}` for bugs; `feat/{slug}` for features |

**Spec file format** (written by PM agent before invoking Codex):

```markdown
# Spec: {Short Title}

## Goal
{One sentence: what should exist or work after this task is done}

## Context
- Related issue: #{N}
- Related files: {paths in /workspace/codebase}
- Depends on: {prerequisites, if any}

## Acceptance Criteria
- [ ] {Specific, testable criterion}
- [ ] Tests pass: `{test command}`

## Implementation Notes
{Hints about approach, patterns to follow, things to avoid}

## Out of Scope
{What this task must NOT change}
```

#### 8.3.3 Reviewer sub-agent ↔ GitHub

Reviewer is spawned by the PM agent after Codex opens a PR.

| Dimension | Details |
|-----------|---------|
| **Trigger** | PM agent invokes Reviewer after receiving the PR URL from Codex; or team member requests a review in Slack |
| **Operations (read)** | `gh pr view <n> --repo $GITHUB_REPO` — PR metadata, description, CI status |
| **Operations (read)** | `gh pr diff <n> --repo $GITHUB_REPO` — unified diff |
| **Operations (read)** | `gh pr checkout <n>` — full branch checkout for codebase context |
| **Operations (write)** | `gh api repos/$GITHUB_REPO/pulls/<n>/comments` (POST) — inline comments on specific file lines |
| **Operations (write)** | `gh pr review <n> --repo $GITHUB_REPO --approve --body "..."` — approve PR |
| **Operations (write)** | `gh pr review <n> --repo $GITHUB_REPO --request-changes --body "..."` — request changes |
| **Operations (write)** | `gh pr review <n> --repo $GITHUB_REPO --comment --body "..."` — general comment (no verdict) |
| **Data read** | PR diff, commit list, CI check results; surrounding source code in `/workspace/codebase/` |
| **Data written** | Inline review comments (file path + line number + comment body); final review verdict (APPROVE / REQUEST_CHANGES / COMMENT) |
| **Review criteria** | Correctness, security vulnerabilities, test coverage, performance implications, adherence to project code patterns |
| **Inline comment format** | Requires `commit_id` (PR head SHA), `path` (file path), `line` (line number), `body` (comment text) |

**Inline comment example:**
```bash
PR_SHA=$(gh pr view 17 --repo $GITHUB_REPO --json headRefOid -q '.headRefOid')
gh api repos/$GITHUB_REPO/pulls/17/comments \
  --method POST \
  --field commit_id="$PR_SHA" \
  --field path="src/auth/login.ts" \
  --field line=42 \
  --field body="Null token case not handled — add a guard before calling verify()."
```

---

### 8.4 SecondBrain

SecondBrain is a personal knowledge base (typically Obsidian or similar). The system integrates by file: PM agents **write** Markdown insight files into a watched inbox directory; Marketer **reads** from that same directory to inform content strategy.

#### 8.4.1 PM Agent → SecondBrain (write only)

| Dimension | Details |
|-----------|---------|
| **Trigger** | Design or architecture decision reached in Slack |
| **Trigger** | Task assigned or completed (GitHub issue closed, PR merged) |
| **Trigger** | Bug triaged (root cause identified, fix scoped) |
| **Trigger** | Active Slack thread goes quiet (1+ hour of inactivity) |
| **Trigger** | Explicit request: "summarize this thread" |
| **Operations** | Write a Markdown file to `/workspace/secondbrain/inbox/pm_{YYYYMMDD_HHMMSS}.md` |
| **Data read** | None — PM agent reads its own workspace memory, not SecondBrain |
| **Data written** | Timestamped Markdown insight file with YAML frontmatter |
| **Container path** | `/workspace/secondbrain/inbox/` (host: SecondBrain watched inbox directory) |
| **Mount access** | read-write |

**Insight file format:**
```markdown
---
type: pm-insight
project: {PROJECT_NAME}
date: {ISO_DATE}
tags: [decision, bug, feature, blocked, retro]
---

# {Summary Title}

## What Happened
{1–3 sentences describing the conversation or event}

## Decision / Outcome
{What was decided or resolved}

## Action Items
- [ ] {task description} — {owner}

## Context
{Background, links to PRs/issues, technical details}
```

**Insight tag reference:**

| Tag | When to Use |
|-----|-------------|
| `decision` | Architecture, tech choices, product direction |
| `bug` | Bug triage, root cause, resolution |
| `feature` | New features scoped and planned |
| `blocked` | Stalled work, reason, next steps |
| `retro` | Lessons learned, process improvements |

#### 8.4.2 Marketer ↔ SecondBrain (selective)

| Dimension | Details |
|-----------|---------|
| **Trigger** | Self-initiated daily trend sweep |
| **Trigger** | PM agent sends a `marketer_request` referencing a SecondBrain insight file |
| **Operations** | Read files in `/workspace/extra/secondbrain/inbox/` |
| **Data read** | `pm-insight` Markdown files: project name, date, tags, decision/outcome summaries, action items |
| **Data written** | Optional `marketer-insight` entries for notable findings or campaign learnings |
| **Container path** | `/workspace/extra/secondbrain/` (host: SecondBrain inbox directory) |
| **Mount access** | read-only for inbox browsing; writes happen through the shared insight tool |
| **What Marketer extracts** | Project milestones worth amplifying; verifiable metrics and achievements; notable decisions suitable for thought-leadership content; user feedback signals; upcoming events |
| **Constraint** | Only promote real, verifiable information from SecondBrain — no fabricated metrics |

#### 8.4.3 Dobby ↔ SecondBrain

Dobby does not directly read or write SecondBrain. It relies on PM agents to write project insights and on Marketer to extract them for content.

#### 8.4.4 Todomon ↔ SecondBrain

Todomon does not interact with SecondBrain.

---

### 8.5 Integration Summary Matrix

A complete reference showing which agents interact with each external system and in what direction.

| Agent | WhatsApp | Slack | GitHub | SecondBrain |
|-------|:--------:|:-----:|:------:|:-----------:|
| **Dobby** | ✅ R+W | — | — | — |
| **Todomon** | 🔁 W via host | — | — | — |
| **Marketer** | — | ✅ R+W | — | 📖 R / ✍️ selective |
| **PM Agent** | 🔁 W via Dobby | ✅ R+W | ✅ R+W | ✍️ W only |
| **Codex sub-agent** | — | — | ✅ W (branch/PR) | — |
| **Reviewer sub-agent** | — | — | ✅ W (review comments) | — |

**Legend:**
- ✅ R+W — Direct read and write
- ✅ W — Direct write only
- 📖 R only — Read-only mount
- ✍️ W only — Write-only
- 🔁 W via X — Indirect write through a relay agent
- — — No interaction

---

### 8.6 End-to-End Flow: GitHub Issue → Merged PR

This trace shows every external system touched during the complete lifecycle of a GitHub issue.

```
[GitHub] Issue opened (by team member or auto-created by PM)
          │
          ▼
[Slack] PM Agent receives @mention or scheduled scan triggers
          │
          │  gh issue view → [GitHub] read issue body
          │
          ├─ Issue vague?
          │     └─ [GitHub] gh issue comment → asks for clarification
          │
          └─ Issue clear?
                │
                │  PM writes spec → /workspace/group/specs/issue-N.md (local)
                │
                ▼
          PM spawns Codex sub-agent
                │
                │  Codex reads spec + codebase
                │  Codex implements changes
                │  [GitHub] git push → branch pushed
                │  [GitHub] gh pr create → PR opened
                │  Codex returns PR URL
                │
                ▼
          [Slack] PM posts PR link to Slack channel
                │
                ▼
          PM spawns Reviewer sub-agent
                │
                │  [GitHub] gh pr diff → read diff
                │  Reviewer reads codebase context
                │  [GitHub] gh api → post inline review comments
                │  [GitHub] gh pr review → submit verdict
                │
                ├─ REQUEST_CHANGES?
                │     └─ [Slack] PM posts update
                │           Codex re-invoked (loop back)
                │
                └─ APPROVE?
                      │
                      ├─ Auto-merge policy?
                      │     └─ [GitHub] gh pr merge
                      │
                      └─ Needs user decision?
                            │
                            │  PM writes pm_escalation IPC file
                            │
                            ▼
                      [WhatsApp] Dobby forwards to user
                            │
                            │  User replies
                            │
                            ▼
                      Dobby writes pm_directive IPC file
                            │
                            ▼
                      [GitHub] PM: gh pr merge (or close)
                            │
                            ▼
                      [SecondBrain] PM writes pm-insight file
                                    (decision, merged PR, action items)
```

---

### 8.7 End-to-End Flow: Marketer Content → Published Post

This trace shows every external system touched during the content creation and publishing lifecycle.

```
Trigger: [Slack] PM agent detects a promotable milestone and sends marketer_request IPC
      OR: Marketer self-initiates (daily trend check or weekly planning)
          │
          ▼
[SecondBrain] Marketer reads inbox files
              (pm-insight files: milestones, decisions, metrics)
          │
          ▼
Marketer researches trends
  (web search, agent-browser → X Explore, optional LinkedIn/Threads confirmation)
  writes research → /workspace/group/research/trends-YYYY-MM.md (local)
          │
          ▼
Marketer drafts a post or reply candidate only when there is a concrete opportunity
  writes drafts → /workspace/group/drafts/YYYY-MM-DD-slug.md (local)
          │
          ▼
Marketer sends Korean approval request directly in Slack
          │
          ├─ 보류 / 거절
          │     Marketer keeps the draft locally and stops
          │
          ├─ 수정 요청
          │     Marketer revises draft → re-sends Slack approval request (loop)
          │
          └─ 승인
                │
                ▼
          Marketer publishes to SNS platform(s)
            (X API / LinkedIn API / Threads API / agent-browser fallback)
            writes → /workspace/group/published/log.md (local registry)
                │
                ▼
          Marketer schedules comment monitoring
            (interval task: every 6h)
                │
                ▼
          Marketer monitors comments
            reads SNS platform comments (API or agent-browser)
            prepares reply drafts and asks for approval in Slack
            writes → /workspace/group/published/comments-log.md (local)
```
