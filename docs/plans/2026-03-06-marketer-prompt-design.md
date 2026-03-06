# Marketer Prompt Redesign Design

## Goal
Align the marketer agent around a clear persona: name `홍명보`, role `마케터`, with direct Slack-based human approval for every publish/reply action.

## Scope
- Rewrite marketer system prompt for persona, tone, approval, and logging semantics.
- Reduce recurring schedule to only daily trend check, weekly content planning, and comment sweep.
- Remove Dobby-based escalation and approval language from marketer-facing docs.
- Keep all marketer-related docs consistent with Slack-first Korean approval messaging.

## Decisions
- Persona wording becomes: `이름은 홍명보, 역할은 마케터`.
- All outbound Slack messages from marketer tasks are written in Korean.
- All top-level posts and all comment/reply actions require human approval before posting.
- `published/log.md` and `published/comments-log.md` remain group-local operational logs, not SecondBrain.
- Weekly SNS research and monthly brand review recurring tasks are removed.
- Daily trend checking gains explicit search keywords, search procedure, and trend selection criteria.
- Weekly content planning remains, but becomes a Korean planning/approval request task.
- Marketer documentation is updated together to avoid drift.
