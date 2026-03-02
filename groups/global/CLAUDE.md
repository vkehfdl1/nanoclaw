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

## Sub-agents

Define reusable sub-agents in `/workspace/group/.nanoclaw/subagents.json`.

## SecondBrain

Use `mcp__nanoclaw__write_secondbrain_insight` with required fields: `type`, `source`, `title`, `project`, `tags`, `content`.
