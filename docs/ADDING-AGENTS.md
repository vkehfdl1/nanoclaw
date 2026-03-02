# Adding a New Agent

This guide covers registering a new agent in NanoClaw. Each agent runs in its own container, responds in a dedicated Slack channel, and has isolated workspace storage.

## Prerequisites

- NanoClaw running with Slack connected
- A Slack channel for the agent (note the channel ID: `C0XXXXXXXXX`)
- `npm run build` and `./container/build.sh` completed

## Steps

### 1. Create the group folder

```bash
mkdir -p groups/<agent-folder>/
```

### 2. Write the agent's CLAUDE.md

Create `groups/<agent-folder>/CLAUDE.md` with:

- **Role** — one-line description of what this agent does
- **Core workflow** — the main loop or decision process
- **Prohibitions** — what the agent must never do

Keep it under 80 lines. The agent automatically inherits `groups/global/CLAUDE.md` (communication, formatting, memory, browser automation, SecondBrain rules). Do not duplicate global rules.

### 3. Register in src/db.ts

Add a channel JID constant and registration function:

```typescript
const MY_AGENT_CHANNEL_JID = 'slack:C0XXXXXXXXX';
const MY_AGENT_FOLDER = 'my-agent';

function ensureMyAgentRegistration(): void {
  ensureDefaultRegisteredGroup(MY_AGENT_CHANNEL_JID, {
    name: 'My Agent',          // Display name
    folder: MY_AGENT_FOLDER,   // Must match groups/<folder>/
    trigger: '@my-agent',      // Slack mention trigger
    requiresTrigger: false,    // false = process all messages in channel
    role: 'my-role',           // Role identifier (e.g., 'pm-agent', 'marketer')
  });
}
```

Then add the call in `ensureDefaultAgentRegistrations()`:

```typescript
function ensureDefaultAgentRegistrations(): void {
  // ... existing registrations ...
  ensureMyAgentRegistration();
}
```

### 4. Invite the Slack bot to the channel

In Slack, go to the agent's channel and run:

```
/invite @YourBotAppName
```

This is the **Slack App** (bot), not the agent name. There is one bot that handles all channels — agents are differentiated by which channel they respond in.

### 5. Build and restart

```bash
npm run build
# Then restart NanoClaw (launchd/systemd or npm run dev)
```

The agent will be registered on next startup and begin responding in its channel.

## Optional Configuration

### Container environment variables

Pass env vars to the agent's container via `containerConfig`:

```typescript
ensureDefaultRegisteredGroup(JID, {
  // ... base fields ...
  containerConfig: {
    envVars: {
      GITHUB_REPO: 'owner/repo-name',
      ALLOWED_REPOS: 'repo-name',
    },
  },
});
```

### Mounting a project repository (for PM agents)

Clone the repo on the host, then mount it read-only:

```bash
git clone https://github.com/owner/repo.git ~/.nanoclaw/repos/repo-name
```

```typescript
containerConfig: {
  envVars: {
    GITHUB_REPO: 'owner/repo-name',
    ALLOWED_REPOS: 'repo-name',
  },
  additionalMounts: [{
    hostPath: '~/.nanoclaw/repos/repo-name',
    containerPath: 'repo-name',         // appears at /workspace/extra/repo-name/
    readonly: true,
    excludePatterns: [
      'node_modules', '.venv', 'dist',
      '.git/objects', '__pycache__',
    ],
  }],
},
```

Requires `gh` CLI authenticated on the host for PR/issue operations.

### Scheduled tasks

Create `groups/<agent-folder>/schedule.json`:

```json
[
  {
    "id": "my-agent-daily-check",
    "prompt": "Run your daily check workflow.",
    "schedule_type": "cron",
    "schedule_value": "0 9 * * *"
  }
]
```

### Sub-agents

Create `groups/<agent-folder>/.nanoclaw/subagents.json`:

```json
{
  "agents": {
    "researcher": {
      "description": "Research sub-agent",
      "prompt": "You are a focused researcher. Provide sources and concise summaries.",
      "tools": ["WebSearch", "WebFetch", "Read"],
      "model": "sonnet"
    }
  }
}
```

### Multi-channel registration

An agent can respond in multiple channels. Register the same folder with different JIDs:

```typescript
// Dedicated channel — no trigger needed
ensureDefaultRegisteredGroup('slack:C09DEDICATED', {
  folder: 'my-agent',
  trigger: '@my-agent',
  requiresTrigger: false,
  // ...
});

// Shared channel — needs @mention
ensureDefaultRegisteredGroup('slack:C09SHARED', {
  folder: 'my-agent',
  trigger: '@my-agent',
  requiresTrigger: true,
  // ...
});
```

### Browser session persistence (for SNS agents)

After authenticating to a platform via `agent-browser`:

```bash
agent-browser state save /workspace/group/auth/platform.json
```

On next session:

```bash
agent-browser state load /workspace/group/auth/platform.json
```

Store this in the agent's CLAUDE.md so it remembers to load sessions.

## Agent Checklist

- [ ] `groups/<folder>/CLAUDE.md` — role, workflow, prohibitions (< 80 lines)
- [ ] `src/db.ts` — channel JID + registration function
- [ ] Slack channel created + bot invited
- [ ] `npm run build` passes
- [ ] (PM agents) Repo cloned to `~/.nanoclaw/repos/` + `gh auth login`
- [ ] (PM agents) `containerConfig` with `envVars` + `additionalMounts`
- [ ] (Scheduled agents) `groups/<folder>/schedule.json`
- [ ] (With sub-agents) `groups/<folder>/.nanoclaw/subagents.json`
- [ ] Container rebuilt if Dockerfile changed: `./container/build.sh`
