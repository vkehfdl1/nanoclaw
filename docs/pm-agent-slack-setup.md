# PM Agent Slack Setup Guide

This guide walks you through setting up a PM (Project Manager) agent for a specific project.
Each PM agent operates in its own Slack channel, manages GitHub operations, and keeps project
context in SecondBrain.

---

## Overview

A PM agent is a specialized NanoClaw agent that:

- **Responds to @mentions** in a dedicated Slack channel
- **Manages GitHub** — triages issues, creates PRs, runs code reviews
- **Summarizes conversations** into SecondBrain insights
- **Spawns Codex sub-agents** for implementation tasks
- **Spawns Reviewer sub-agents** for PR review

All PM agents share the same Slack bot (same app credentials) but each lives in a different channel.

---

## Step 1 — Create a Slack App

If you haven't created a NanoClaw Slack app yet:

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From a manifest**
2. Select your workspace
3. Paste the contents of **`config-examples/slack-app-manifest.json`** into the manifest editor
4. Click **Create**

### Required OAuth Scopes

The manifest configures the following bot token scopes:

| Scope | Purpose |
|-------|---------|
| `app_mentions:read` | Receive @mention events (PM agent trigger) |
| `channels:history` | Read public channel messages for context |
| `channels:read` | List channels for metadata sync |
| `chat:write` | Post messages to channels |
| `files:read` | Read file attachments |
| `files:write` | Upload files (reports, diffs, etc.) |
| `groups:history` | Read private channel messages |
| `groups:read` | List private channels |
| `im:history` | Read DMs |
| `users:read` | Look up user profiles (display names) |

### Event Subscriptions

The app subscribes to these events via **Socket Mode** (no public URL needed):

| Event | Trigger |
|-------|---------|
| `app_mention` | When the bot is @mentioned — **primary PM agent trigger** |
| `message.channels` | All messages in public channels |
| `message.groups` | All messages in private channels |

### Socket Mode

NanoClaw uses **Slack Socket Mode** — no inbound webhook URL is required. Socket Mode
uses a persistent WebSocket connection, making it ideal for running on your local machine
or a private server.

---

## Step 2 — Get Credentials

After creating the app:

### Bot Token (SLACK_BOT_TOKEN)

1. In your app settings → **OAuth & Permissions**
2. Click **Install to Workspace** (or Reinstall)
3. Copy the **Bot User OAuth Token** — it starts with `xoxb-`

### App-Level Token (SLACK_APP_TOKEN)

Required for Socket Mode:

1. In your app settings → **Basic Information** → **App-Level Tokens**
2. Click **Generate Token and Scopes**
3. Name it `nanoclaw-socket`
4. Add the scope: `connections:write`
5. Click **Generate**
6. Copy the token — it starts with `xapp-`

### Add to .env

Add both tokens to your `.env` file at the project root:

```
SLACK_BOT_TOKEN=xoxb-your-bot-token-here
SLACK_APP_TOKEN=xapp-your-app-token-here
GITHUB_TOKEN=ghp-your-github-token-here
```

> **Security:** Never commit `.env` to git. The file is in `.gitignore` by default.
> Secrets are loaded only where needed and never mounted into containers.

---

## Step 3 — Find Your Slack Channel ID

The PM agent needs the **channel ID** (not the channel name):

1. In Slack, right-click the channel → **View channel details**
2. Scroll to the bottom of the modal
3. Copy the **Channel ID** — it starts with `C` (public) or `G` (private)

Alternatively, use the Slack API:
```bash
curl -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  "https://slack.com/api/conversations.list?types=public_channel,private_channel" \
  | jq '.channels[] | {name: .name, id: .id}'
```

---

## Step 4 — Register the PM Agent

Run the registration script with your project details:

```bash
tsx scripts/register-pm-agent.ts \
  --name my-project \
  --channel C1234567890 \
  --repo owner/my-repo \
  --codebase /path/to/my-project \
  --secondbrain ~/Documents/SecondBrain/inbox \
  --bot-name "@PM-MyProject"
```

### Options

| Flag | Required | Description |
|------|----------|-------------|
| `--name` | ✅ | Short project name (used for folder and display). e.g., `nanoclaw` |
| `--channel` | ✅ | Slack channel ID. e.g., `C1234567890` |
| `--repo` | ✅ | GitHub repo in `owner/repo` format. e.g., `jeffrey/my-project` |
| `--codebase` | ✅ | Absolute path to the project codebase on your machine |
| `--secondbrain` | ❌ | Path to SecondBrain inbox directory for PM insights |
| `--bot-name` | ❌ | How the bot shows up in Slack. Default: `@PM-{name}` |
| `--model` | ❌ | Claude model override. Default: global `CLAUDE_MODEL` or `claude-sonnet-4-5` |

The script will:

1. Create `groups/pm-{name}/` with memory files and subagent definitions
2. Register the group in the NanoClaw database
3. Print next steps

---

## Step 5 — Invite the Bot to the Channel

In Slack, type in the channel:
```
/invite @your-bot-display-name
```

The bot's display name is set in the Slack app settings under **App Home** → **Display Name**.

---

## Step 6 — Start NanoClaw

```bash
npm run dev
```

NanoClaw will connect to Slack via Socket Mode and start listening for messages.

### Verify Connection

You should see in the logs:
```
Slack bot authenticated  { botUserId: 'U...' }
Connected to Slack (Socket Mode)
Slack channel metadata synced  { count: N }
```

---

## Step 7 — Test the PM Agent

Mention the bot in the channel:

```
@PM-MyProject Hello! What open GitHub issues do we have?
```

The bot will:
1. Receive the @mention
2. Spin up a container with the project codebase mounted
3. Run `gh issue list --repo owner/my-repo --state open`
4. Reply in Slack (and optionally in-thread)

---

## Container Configuration

Each PM agent container has access to:

| Container Path | Host Path | Access |
|----------------|-----------|--------|
| `/workspace/group` | `groups/pm-{name}/` | Read-Write |
| `/workspace/codebase` | Your project codebase | Read-Write |
| `/workspace/secondbrain` | SecondBrain inbox | Read-Write |
| `/workspace/global` | `groups/global/` | Read-Only |
| `/workspace/ipc` | Per-group IPC directory | Read-Write |

### Environment Variables Inside Container

| Variable | Value |
|----------|-------|
| `GITHUB_REPO` | `owner/repo` (set during registration) |
| `SLACK_CHANNEL_ID` | The Slack channel ID |
| `PM_PROJECT_NAME` | The project name slug |
| `GITHUB_TOKEN` | From `.env` (passed globally) |
| `CLAUDE_MODEL` | From registration or `.env` |

---

## Multiple PM Agents

Run the registration script once per project. Each PM agent:

- Has its own group folder: `groups/pm-{name}/`
- Lives in a different Slack channel
- Has its own memory, specs, and conversation history
- Shares the same Slack bot app credentials

Example for three projects:
```bash
tsx scripts/register-pm-agent.ts --name api-service   --channel C111 --repo myorg/api-service   --codebase ~/projects/api-service
tsx scripts/register-pm-agent.ts --name web-frontend  --channel C222 --repo myorg/web-frontend  --codebase ~/projects/web-frontend
tsx scripts/register-pm-agent.ts --name data-pipeline --channel C333 --repo myorg/data-pipeline --codebase ~/projects/data-pipeline
```

---

## Troubleshooting

### Bot doesn't respond to @mentions

- Verify the bot is in the channel: `/invite @bot-name`
- Check that `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` are set in `.env`
- Check NanoClaw logs for `app_mention` events
- Verify the channel is registered: the channel ID in the registration must match exactly

### GitHub operations fail

- Ensure `GITHUB_TOKEN` is in `.env` with repo access
- Check the `GITHUB_REPO` value in the registered group config: `store/messages.db`
- Verify `gh` CLI authentication inside a container:
  ```bash
  docker run --rm -e GITHUB_TOKEN=$GITHUB_TOKEN nanoclaw-agent:latest \
    sh -c 'echo "$GITHUB_TOKEN" | gh auth login --with-token && gh auth status'
  ```

### Codebase not accessible

- The codebase path must be in `~/.config/nanoclaw/mount-allowlist.json` under `allowedRoots`
- Re-run the registration script after updating the allowlist
- Check mount security logs in NanoClaw output

### How to update a PM agent's config

Re-run the registration script with the same `--name`. It will update the database entry.
Then restart NanoClaw.

---

## Security Notes

- Bot tokens are never mounted into containers — they stay in the orchestrator process
- `GITHUB_TOKEN` is passed via environment variable, never written to disk
- The codebase mount is validated against the external allowlist (`~/.config/nanoclaw/mount-allowlist.json`)
- Each PM agent has its own isolated IPC directory — agents cannot cross-talk via IPC
- Containers run as the host user for file access but have no host network privileges by default
