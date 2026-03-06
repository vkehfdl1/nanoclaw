# Agent Routing Doc Simplification Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace workflow-heavy multi-agent docs with a minimal routing reference and expose callable agents in the global CLAUDE file.

**Architecture:** `docs/multi-agent-architecture.md` becomes a concise human reference for agent list + alias routing rules. `groups/global/CLAUDE.md` becomes the runtime-facing shared directory of callable agents and thread-scoped invocation behavior.

**Tech Stack:** Markdown documentation

---

### Task 1: Add global callable-agent directory

**Files:**
- Modify: `groups/global/CLAUDE.md`

**Step 1:** Add a concise section listing current callable agents and aliases.

**Step 2:** Add the universal routing rule: alias mention can call another agent and only the current thread context is passed.

### Task 2: Replace architecture doc with a minimal routing reference

**Files:**
- Modify: `docs/multi-agent-architecture.md`

**Step 1:** Replace long workflow sections with a short overview, agent table, and routing rules.

**Step 2:** Keep only facts grounded in current routing behavior.

### Task 3: Verify

**Files:**
- Verify only

**Step 1:** Run `git diff --check` on the edited docs.

**Step 2:** Re-read the final docs and confirm they mention aliases, cross-agent invocation, and thread-scoped context.
