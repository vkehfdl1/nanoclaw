---
name: setup
description: Run initial NanoClaw setup for the Slack-first fork. Use when the user wants to install dependencies, configure Slack tokens, register their main Slack channel, or start the background service.
---

# NanoClaw Setup

Run setup steps automatically. Only pause when user action is genuinely required, such as creating a Slack app, pasting Slack tokens, or choosing the main Slack channel. Setup uses `bash setup.sh` for bootstrap, then `npx tsx setup/index.ts --step <name>` for the structured steps. Each step emits a status block to stdout, and verbose logs go to `logs/setup.log`.

**Principle:** Fix what can be fixed automatically. Only ask the user for Slack workspace actions, secrets, or decisions.

## 1. Bootstrap

Run:

```bash
bash setup.sh
```

Parse the status block and fix the first failing prerequisite:
- `NODE_OK=false` -> install Node.js 22, then rerun
- `DEPS_OK=false` -> inspect `logs/setup.log`, fix dependency issues, rerun
- `NATIVE_OK=false` -> install build tools, rerun

## 2. Check Environment

Run:

```bash
npx tsx setup/index.ts --step environment
```

Record:
- `PLATFORM`
- `APPLE_CONTAINER`
- `DOCKER`
- `HAS_ENV`
- `HAS_REGISTERED_GROUPS`

## 3. Configure Slack

This fork is Slack-only. NanoClaw will refuse to start without both:
- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`

If the user does not already have a Slack app, use [pm-agent-slack-setup.md](/Users/jeffrey-dobby/nanoclaw/docs/pm-agent-slack-setup.md) as the detailed reference.

Minimum outcome for this step:
1. Slack app exists
2. Socket Mode is enabled
3. Bot token and app-level token are created
4. The app is installed to the workspace

Write the tokens to `.env`:

```bash
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
```

Verify:

```bash
grep -E 'SLACK_(BOT|APP)_TOKEN=' .env
```

If either token is missing, stop and fix that before continuing.

## 4. Choose Container Runtime

Use the environment step results:
- Linux -> Docker
- macOS with Apple Container installed -> ask whether to use Docker or Apple Container
- macOS without Apple Container -> Docker

If the user chooses Apple Container, run `/convert-to-apple-container` before building the image.

Install or start Docker if needed:
- `DOCKER=installed_not_running` -> start Docker
- `DOCKER=not_found` -> install Docker, then start it

## 5. Build and Test the Container

Run:

```bash
npx tsx setup/index.ts --step container -- --runtime <docker|apple-container>
```

If `BUILD_OK=false` or `TEST_OK=false`, inspect `logs/setup.log`, fix the issue, and rerun until the container test passes.

## 6. Configure Claude Credentials

If `.env` already contains `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`, confirm whether to keep it.

Otherwise ask the user which auth mode they want:
- Claude subscription -> add `CLAUDE_CODE_OAUTH_TOKEN=<token>`
- Anthropic API key -> add `ANTHROPIC_API_KEY=<key>`

Do not continue until one of those credentials is configured in `.env`.

## 7. Register the Main Slack Channel

Ask which Slack channel should act as the main control channel.

Accept one of:
- raw channel ID, such as `C0123456789`
- full JID, such as `slack:C0123456789`
- a Slack URL that contains the channel ID

Normalize to `slack:<CHANNEL_ID>`.

Then ask:
- assistant display name (default `Andy`)
- trigger text (default `@Andy`)
- whether the main channel should require the trigger

Register it with:

```bash
npx tsx setup/index.ts --step register -- \
  --jid "slack:C0123456789" \
  --name "main" \
  --trigger "@Andy" \
  --folder "main" \
  --assistant-name "Andy" \
  --no-trigger-required
```

If the main channel should require mentions, omit `--no-trigger-required`.

## 8. Configure Mount Allowlist

Ask whether agents need access to external directories.

No external access:

```bash
npx tsx setup/index.ts --step mounts -- --empty
```

With external access:

```bash
npx tsx setup/index.ts --step mounts -- --json '{"allowedRoots":["/abs/path"],"blockedPatterns":[],"nonMainReadOnly":true}'
```

## 9. Start the Service

Run:

```bash
npx tsx setup/index.ts --step service
```

If a service is already loaded, stop/unload it first:
- macOS -> `launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist`
- Linux -> `systemctl --user stop nanoclaw`

If the service step fails, inspect `logs/setup.log` and `logs/nanoclaw.error.log`, fix the issue, and rerun.

## 10. Verify

Run:

```bash
npx tsx setup/index.ts --step verify
```

Expected success conditions:
- service is running
- credentials are configured
- at least one registered Slack group exists
- mount allowlist exists

If verification fails:
- `SERVICE=stopped` -> rebuild and restart
- `CREDENTIALS=missing` -> fix step 6
- `REGISTERED_GROUPS=0` -> fix step 7
- `MOUNT_ALLOWLIST=missing` -> fix step 8

## 11. Final User Test

Tell the user to send a message in the registered Slack channel, for example:

```text
@Andy say hello
```

Watch logs:

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

**NanoClaw will not start**
- Confirm `.env` contains both Slack tokens and Claude credentials
- Confirm the Slack app is installed to the workspace
- Confirm the bot is a member of the target Slack channel

**No response in Slack**
- Check `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`
- Check the registered JID uses the `slack:<CHANNEL_ID>` format
- Check `logs/nanoclaw.log` for Slack connection errors

**Container errors**
- Ensure Docker or Apple Container is actually running
- Rebuild with `./container/build.sh`
- Inspect `groups/main/logs/container-*.log`

**Unload the service**
- macOS: `launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist`
- Linux: `systemctl --user stop nanoclaw`
