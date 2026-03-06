# Marketer Prompt Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Align marketer prompt and recurring tasks with a Korean Slack-first approval workflow and remove stale Dobby-centered instructions.

**Architecture:** The source of truth lives in marketer prompt/config/docs plus the architecture docs that describe the marketer workflow. Update runtime-facing prompt files first, then synchronize referenced docs and tests so the behavior description stays consistent.

**Tech Stack:** TypeScript tests, Markdown prompt docs, JSON schedule config

---

### Task 1: Lock the new recurring-task contract in tests

**Files:**
- Modify: `src/agent-schedule-bootstrap.test.ts`

**Step 1:** Add a failing test that asserts the real marketer schedule contains only `marketer-daily-sns-trend-check`, `marketer-weekly-content-planning`, and `marketer-comment-sweep`.

**Step 2:** Run the targeted test and confirm it fails against the current 5-task schedule.

**Step 3:** Keep the failing expectation as the guardrail for the schedule rewrite.

### Task 2: Rewrite runtime-facing marketer prompt/config files

**Files:**
- Modify: `groups/marketer/CLAUDE.md`
- Modify: `groups/marketer/schedule.json`
- Modify: `groups/marketer/docs/sns-research-procedure.md`
- Modify: `groups/marketer/templates/research-report.md`
- Modify: `groups/marketer/scripts/sns-research.sh`

**Step 1:** Rewrite the system prompt around the approved persona, truthful/informative tone, explicit human approval, and local-vs-SecondBrain storage semantics.

**Step 2:** Remove weekly research and monthly review tasks from the schedule; rewrite remaining prompts in Korean Slack approval language.

**Step 3:** Update the research procedure and template/script references so they no longer mention Dobby approval or removed recurring jobs.

### Task 3: Synchronize broader docs and tests

**Files:**
- Modify: `groups/main/CLAUDE.md`
- Modify: `docs/multi-agent-architecture.md`
- Modify: any marketer-related tests that assume removed tasks or Dobby relay semantics

**Step 1:** Remove or rewrite marketer approval sections that still route through Dobby or WhatsApp.

**Step 2:** Keep architecture docs consistent with Slack-first human approval and local published logs.

**Step 3:** Update any affected tests to match the new schedule shape or wording assumptions.

### Task 4: Verify

**Files:**
- Verify only

**Step 1:** Run the targeted tests for schedule/bootstrap and DB registration behavior.

**Step 2:** Run any additional targeted tests touched by the workflow documentation/runtime changes.

**Step 3:** Review git diff for consistency and report exact verification evidence.
