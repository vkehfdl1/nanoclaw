# NanoClaw Multi-Agent Reference

This document is a short reference for which agents currently exist and how alias-based routing works.

## Current Agents

| Agent | Short Role | Aliases |
| --- | --- | --- |
| `도비` | Main orchestrator | `@dobby`, `@도비` |
| `영구` | PM agent for AutoRAG Research | `@young-gu`, `@영구` |
| `홍명보` | Marketer | `@marketer`, `@홍명보`, `@명보` |
| `투두몬` | Task manager | `@todomon`, `@투두몬` |

Additional project PM agents can be added with their own configured aliases.

## Routing Rules

- Mentioning a configured alias in Slack can invoke that agent from any channel or thread.
- Agents can invoke other agents with the same alias-based mention rule.
- Cross-agent routing passes only the current thread context to the called agent.
- If the alias mention happens in a top-level channel message, that message becomes the thread anchor for the called agent.
- Channel member context can list currently available agent aliases for that Slack channel.

## Source Of Truth

- Agent names and aliases come from the default registrations in `src/db.ts`.
- Alias matching is handled by `src/gateway.ts`.
- Thread-scoped cross-agent routing is handled by `src/index.ts`.
