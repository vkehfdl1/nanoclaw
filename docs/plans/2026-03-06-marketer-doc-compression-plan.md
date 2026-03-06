# Marketer Doc Compression Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make marketer support docs as concise as the new `CLAUDE.md` without losing operational requirements.

**Architecture:** Keep one source of truth per concern: `CLAUDE.md` for hard rules, research procedure for operational mechanics, and architecture doc for integration boundaries. Remove generic restatement and repetitive examples.

**Tech Stack:** Markdown documentation, git verification

---

### Task 1: Compress research procedure

**Files:**
- Modify: `groups/marketer/docs/sns-research-procedure.md`

**Step 1:** Reduce the doc to inputs, collection method, ranking rules, outputs, memory boundary, and troubleshooting.

**Step 2:** Remove approval-template repetition and generic explanations already covered in `CLAUDE.md`.

### Task 2: Compress architecture marketer sections

**Files:**
- Modify: `docs/multi-agent-architecture.md`

**Step 1:** Shorten the PM→Marketer, approval, Slack, SecondBrain, and end-to-end marketer sections.

**Step 2:** Keep only integration facts needed to understand cross-agent/system behavior.

### Task 3: Verify and summarize

**Files:**
- Verify only

**Step 1:** Run markdown-level sanity checks via `git diff --check`.

**Step 2:** Review the resulting diff to confirm that the policy boundaries still match `groups/marketer/CLAUDE.md`.
