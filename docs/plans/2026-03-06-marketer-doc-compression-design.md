# Marketer Doc Compression Design

## Goal
Compress marketer supporting docs so they match the minimal `groups/marketer/CLAUDE.md` contract and avoid restating general model knowledge.

## Scope
- Compress `groups/marketer/docs/sns-research-procedure.md` to operational specifics only.
- Compress marketer-related sections in `docs/multi-agent-architecture.md` to boundary-level rules and system interactions.
- Preserve the same policy boundaries already established in `groups/marketer/CLAUDE.md`.

## Design
- `CLAUDE.md` stays the source of truth for identity, hard constraints, and memory boundary.
- `sns-research-procedure.md` keeps only actionable research mechanics: inputs, search patterns, ranking, outputs, and failure handling.
- `multi-agent-architecture.md` keeps only integration boundaries, message flow, and persistent storage semantics.
- Repeated examples, verbose message templates, and generic marketing advice are removed unless they are uniquely required for system behavior.

## Invariants
- Slack is the approval channel for marketer output.
- Silence is never approval.
- Local logs remain under `/workspace/group/`.
- Durable shared marketer context belongs in SecondBrain.
