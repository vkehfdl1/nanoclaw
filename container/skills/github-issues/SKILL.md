---
name: github-issues
description: List, filter, and inspect GitHub issues for a project repository. Supports filtering by state, label, assignee, and search query. Use whenever you need to find, triage, or work with GitHub issues.
allowed-tools: Bash(list-issues:*), Bash(gh issue:*)
---

# GitHub Issue Listing

The `list-issues` command provides structured access to GitHub issues with full filter support. It wraps `gh issue list` with validation and a clean interface.

Your project repository is available in the environment as `$GITHUB_REPO` (format: `owner/repo`).

---

## Quick Reference

```bash
# List open issues (default)
list-issues

# Filter by state
list-issues --state open        # open issues (default)
list-issues --state closed      # closed issues
list-issues --state all         # all issues regardless of state

# Filter by label
list-issues --label bug
list-issues --label "help wanted"
list-issues --label bug --label urgent   # multiple labels (AND logic)

# Filter by assignee
list-issues --assignee @me              # assigned to you
list-issues --assignee alice            # assigned to a specific user

# Adjust result count
list-issues --limit 50

# Full-text search within issues
list-issues --search "login timeout"
list-issues --search "auth AND mobile"

# JSON output for programmatic use
list-issues --json
list-issues --json | jq '.[].number'
list-issues --json | jq '.[] | {number, title, labels: [.labels[].name]}'

# Use a different repo
list-issues --repo acme/api-server --state all
```

---

## Combining Filters

Filters are additive (AND logic):

```bash
# Bugs assigned to me
list-issues --state open --label bug --assignee @me

# High-priority unassigned issues
list-issues --state open --label priority:high --assignee ""

# Recent closed bugs (more results)
list-issues --state closed --label bug --limit 50

# Search for a specific topic with a label filter
list-issues --state open --label feature --search "dark mode"
```

---

## JSON Field Reference

When using `--json`, each issue includes:

| Field | Type | Description |
|-------|------|-------------|
| `number` | int | Issue number |
| `title` | string | Issue title |
| `state` | string | `"OPEN"` or `"CLOSED"` |
| `labels` | array | `[{name, color, description}]` |
| `assignees` | array | `[{login, name}]` |
| `author` | object | `{login, name}` |
| `createdAt` | ISO8601 | When the issue was created |
| `updatedAt` | ISO8601 | Last update timestamp |
| `url` | string | Full GitHub URL |
| `body` | string | Issue description (markdown) |
| `milestone` | object | `{title, number}` or null |

---

## Reading a Single Issue

```bash
# View full issue (title, body, comments)
gh issue view 42 --repo $GITHUB_REPO

# View in JSON for programmatic use
gh issue view 42 --repo $GITHUB_REPO --json number,title,body,labels,assignees,comments

# View comments only
gh issue view 42 --repo $GITHUB_REPO --comments
```

---

## Common Workflows

### Triage new issues

```bash
# Check recently opened issues
list-issues --state open --limit 20 --json | jq 'sort_by(.createdAt) | reverse | .[] | {number, title, labels: [.labels[].name]}'
```

### Find unassigned bugs

```bash
list-issues --state open --label bug --json | jq '[.[] | select(.assignees | length == 0)] | .[] | {number, title}'
```

### Check issues assigned to a specific team member

```bash
list-issues --state open --assignee alice --json | jq '.[] | {number, title, updatedAt}'
```

### List issues with no labels (untriaged)

```bash
list-issues --state open --json | jq '[.[] | select(.labels | length == 0)] | .[] | {number, title, createdAt}'
```

### Find issues matching a search term

```bash
list-issues --search "database connection" --state all --json
```

---

## Posting a Comment on an Issue

```bash
gh issue comment 42 --repo $GITHUB_REPO \
  --body "Thanks! Could you clarify the expected behavior when the token expires?"
```

---

## Error Handling

- If `GITHUB_REPO` is not set and `--repo` is not passed, `list-issues` will print a clear error
- If `gh` is not authenticated, you'll see a GitHub authentication error — run `gh auth status` to check
- If no issues match the filters, an empty result is returned (not an error)

---

## Authentication

The `gh` CLI must be authenticated. In the PM agent container, this is handled at registration time via the `GH_TOKEN` environment variable or interactive login. Check status with:

```bash
gh auth status
```
