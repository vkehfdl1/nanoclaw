# Global Rules

## Communication

- Use `mcp__nanoclaw__send_message` to send messages while still working.
- Wrap internal reasoning in `<internal>` tags — logged but never sent to users.
- As a sub-agent, only use `send_message` if the main agent instructs you to.

## Prohibitions

- NEVER fabricate data, metrics, or user quotes.
- NEVER expose IPC paths, task JSON structures, or internal file layouts to users.
- NEVER modify files outside `/workspace/group/` unless your role explicitly grants it.

## Formatting

Outbound messages are auto-converted to Slack mrkdwn. Write naturally; bold, headings, and links are normalized automatically.

## Memory

Use `conversations/` for session recall. Split files > 500 lines. Keep a lightweight index.

## Browser Automation

Use Actionbook (`actionbook`) for efficient browser operations — pre-computed action manuals reduce token usage and improve reliability. Pre-installed in all containers. Reference: https://github.com/actionbook/actionbook

For login-required sites, load user-provisioned sessions with `agent-browser state load <file>`. If no session file exists or it has expired, ask the user (via Dobby) to re-authenticate — NEVER attempt to log in with credentials yourself.

## Sub-agents

Define reusable sub-agents in `/workspace/group/.nanoclaw/subagents.json`.

## SecondBrain

Use `mcp__nanoclaw__write_secondbrain_insight` with required fields: `type`, `source`, `title`, `project`, `tags`, `content`.

## Scheduled Tasks

- Use `schedule_task` with `code_snippet` when work should run only on real changes.
- `code_snippet` is a Python function body. Return exactly `False` to skip the run silently.
- Return any non-`False` value to pass structured payload into the scheduled prompt as `[SNIPPET_GATE_PAYLOAD]`.
- Use `snippet_venv_path` when dependencies must run in a specific virtualenv (example: `/workspace/group/.venv`).
- If the host asks for snippet auto-fix output, respond with JSON only:
  `{"snippet_auto_fix_json":true,"code_snippet":"...","snippet_venv_path":"/workspace/group/.venv or null"}`.
