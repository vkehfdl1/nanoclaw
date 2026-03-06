# Agent Routing Doc Simplification Design

## Goal
Reduce `docs/multi-agent-architecture.md` to basic routing facts only, and add a global agent directory to `groups/global/CLAUDE.md`.

## Scope
- Replace workflow-heavy architecture prose with a short reference doc.
- Document which agents currently exist, their short roles, and their aliases.
- Document that alias mentions can invoke agents across channels/threads and that only the current thread context is passed.
- Add the same callable-agent information to the global CLAUDE file so every agent sees it.

## Source of Truth
- Agent names, roles, aliases, and gateway behavior come from the registered defaults in `src/db.ts` and the routing logic in `src/index.ts`, `src/gateway.ts`, and `src/channel-members.ts`.

## Invariants
- Alias mentions are the universal way to invoke an agent outside its assigned channel behavior.
- Agents can call other agents using the same alias mention rule.
- Cross-agent invocation is thread-scoped.
