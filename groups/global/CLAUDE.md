# Global Rules

## Communication

- Use `mcp__nanoclaw__send_message` for any user-visible text reply.
- If you intend to send a user-visible text reply, call `send_message` exactly once with the final text you want delivered.
- If no user-facing reply is needed, stay silent.
- Final model output is logged for state/debugging only and is never auto-delivered to users.
- Wrap internal reasoning in `<internal>` tags — logged but never sent to users.
- As a sub-agent, only use `send_message` if the main agent instructs you to.

## Callable Agents

- `@dobby`, `@도비`: main orchestrator.
- `@young-gu`, `@영구`: PM agent for AutoRAG Research.
- `@marketer`, `@홍명보`, `@명보`: marketer.
- `@todomon`, `@투두몬`: task manager.
- Additional project PM agents may also exist; use the alias shown in the channel members list when available.

## Agent Routing

- Mentioning an agent alias in Slack can invoke that agent from any channel or thread.
- Agents can invoke other agents the same way.
- Cross-agent invocation passes only the current thread context.
- A top-level alias mention starts a new thread context rooted at that message.

## Prohibitions

- NEVER fabricate data, metrics, or user quotes.
- NEVER expose IPC paths, task JSON structures, or internal file layouts to users.
- NEVER modify files outside `/workspace/group/` unless your role explicitly grants it.

## Formatting

Outbound messages are auto-converted to Slack mrkdwn. Write naturally; bold, headings, and links are normalized automatically.

## Memory

Use `conversations/` for session recall. Split files > 500 lines. Keep a lightweight index.

## Browser Automation

Use Actionbook (`actionbook`) for efficient browser operations — pre-computed action manuals reduce token usage and improve reliability. Both `agent-browser` and `actionbook` are pre-installed in all containers. Reference: https://github.com/actionbook/actionbook

For login-required sites, load user-provisioned sessions with `agent-browser state load <file>`. If no session file exists or it has expired, ask the user to re-authenticate — NEVER attempt to log in with credentials yourself.

## Sub-agents

Define reusable sub-agents in `/workspace/group/.nanoclaw/subagents.json`.

## SecondBrain

Use `mcp__nanoclaw__write_secondbrain_insight` with required fields: `type`, `source`, `title`, `project`, `tags`, `content`.

## Scheduled Tasks

- Use `schedule_task` with `code_snippet` when work should run only on real changes.
- `snippet_language` is `'javascript'` (default) or `'bash'`.
- JavaScript snippets run as async function body in Node.js — `return false` to skip silently.
- Bash snippets run as shell scripts — print `false` to skip silently.
- Any non-`false` return/output is injected into the agent prompt as `[SNIPPET_GATE_PAYLOAD]`.
- JavaScript snippets receive a `context` object; Bash snippets receive `$NANOCLAW_CONTEXT_FILE` with task metadata.
- If the host asks for snippet auto-fix output, respond with JSON only:
  `{"snippet_auto_fix_json":true,"code_snippet":"...","snippet_language":"javascript or bash"}`.
