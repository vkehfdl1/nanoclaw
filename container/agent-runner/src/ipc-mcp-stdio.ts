/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';
import { writeInsight, InsightTypeSchema, PrioritySchema } from './secondbrain.js';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const RESPONSES_DIR = path.join(IPC_DIR, 'responses');
const IPC_RESPONSE_POLL_MS = 500;
const CODEX_RESPONSE_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const HOST_OP_RESPONSE_TIMEOUT_MS = 30 * 1000;

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';
const threadTs = process.env.NANOCLAW_THREAD_TS;

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

interface IpcTaskResponse {
  requestId: string;
  ok: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
  exitCode?: number | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createRequestId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function waitForTaskResponse(
  requestId: string,
  timeoutMs: number,
): Promise<IpcTaskResponse> {
  const responsePath = path.join(RESPONSES_DIR, `${requestId}.json`);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (fs.existsSync(responsePath)) {
      const payload = JSON.parse(
        fs.readFileSync(responsePath, 'utf-8'),
      ) as IpcTaskResponse;
      fs.unlinkSync(responsePath);
      return payload;
    }
    await sleep(IPC_RESPONSE_POLL_MS);
  }

  throw new Error(`Timed out waiting for IPC response (${requestId})`);
}

async function runTaskWithResponse(
  data: Record<string, unknown>,
  timeoutMs: number,
): Promise<IpcTaskResponse> {
  const requestId = createRequestId(String(data.type || 'req'));
  writeIpcFile(TASKS_DIR, {
    ...data,
    requestId,
    sourceAgent: groupFolder,
    timestamp: new Date().toISOString(),
  });
  return waitForTaskResponse(requestId, timeoutMs);
}

function formatTaskResult(response: IpcTaskResponse, successFallback: string): {
  text: string;
  isError: boolean;
} {
  if (!response.ok) {
    const details = response.stderr?.trim() || response.stdout?.trim();
    const text = details
      ? `${response.error || 'Host command failed'}\n\n${details}`
      : response.error || 'Host command failed';
    return { text, isError: true };
  }

  const output = response.stdout?.trim() || response.stderr?.trim() || successFallback;
  return { text: output, isError: false };
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or genuinely separate follow-up messages. The host keeps the current Slack thread when this run already has one. Scheduled tasks do not auto-deliver their final output, so this tool is required for any user-visible scheduled-task notification.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      threadTs,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'send_agent_message',
  `Send a cross-agent message to another registered agent.
The host will resolve the target agent's channel, post the message for visibility, and store it so the target agent can process it.`,
  {
    target_agent: z.string().describe('Target agent folder name (for example: "marketer" or "pm-autorag")'),
    text: z.string().describe('Message body to send'),
    channel_jid: z.string().optional().describe('Optional explicit channel JID where the target agent is registered (for example: "slack:C12345678")'),
  },
  async (args) => {
    const data = {
      type: 'send_agent_message',
      sourceAgent: groupFolder,
      sourceChatJid: chatJid,
      threadTs,
      targetAgent: args.target_agent,
      text: args.text,
      channelJid: args.channel_jid,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Cross-agent message queued for "${args.target_agent}".` }],
    };
  },
);

server.tool(
  'send_file',
  'Upload a file to the user or group chat. The file must exist on disk (in your workspace). Use this to share generated files, images, documents, etc.',
  {
    file_path: z.string().describe('Absolute path to the file to upload (e.g., /workspace/group/report.pdf)'),
    comment: z.string().optional().describe('Optional message to send alongside the file'),
  },
  async (args) => {
    if (!fs.existsSync(args.file_path)) {
      return {
        content: [{ type: 'text' as const, text: `File not found: ${args.file_path}` }],
        isError: true,
      };
    }

    const data: Record<string, string | undefined> = {
      type: 'file',
      chatJid,
      filePath: args.file_path,
      comment: args.comment || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: `File "${path.basename(args.file_path)}" sent.` }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

  MESSAGING BEHAVIOR - Scheduled tasks do NOT auto-deliver their final output to the user or group. Final output is kept for task logs/state only. If a scheduled task should notify the user, it must call send_message explicitly. Include guidance in the prompt about whether the agent should:
  \u2022 Always send a message (e.g., reminders, daily briefings)
  \u2022 Only send a message when there's something to report (e.g., "notify me if...")
  \u2022 Never send a message (background maintenance tasks)
  \u2022 Use send_message exactly once when a single summary should be delivered

CODE SNIPPET GATE (OPTIONAL):
\u2022 code_snippet runs before agent invocation as a JavaScript function body or Bash script.
\u2022 If the snippet returns exactly false (JavaScript) or prints "false" (Bash), the task exits silently (agent is not called).
\u2022 Any other return value is passed to the agent prompt as a payload block.
\u2022 If snippet execution errors, host logs it and immediately invokes an auto-fix run for this task.
\u2022 JavaScript snippets receive a context object with task metadata (task_id, group_folder, chat_jid, schedule_type, schedule_value, run_started_at).
\u2022 Bash snippets receive the same context via the NANOCLAW_CONTEXT_FILE environment variable.
\u2022 snippet_venv_path is deprecated and ignored.

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    code_snippet: z.string().optional().describe('Optional JavaScript function body or Bash script gate. Return false / print "false" to skip silently; any other value becomes prompt payload.'),
    snippet_language: z.enum(['javascript', 'bash']).default('javascript').optional().describe('Snippet runtime language.'),
    snippet_venv_path: z.string().optional().describe('Deprecated and ignored.'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const data = {
      type: 'schedule_task',
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      code_snippet: args.code_snippet,
      snippet_language: args.snippet_language || 'javascript',
      snippet_venv_path: args.snippet_venv_path,
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    const filename = writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task scheduled (${filename}): ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'clear_session',
  'Clear the current group session so the next request starts fresh. Main group can optionally target another registered group.',
  {
    target_group_jid: z.string().optional().describe('(Main group only) target group JID to clear. Defaults to current group.'),
  },
  async (args) => {
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const data = {
      type: 'clear_session',
      targetJid,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Session clear requested for ${targetJid}.` }],
    };
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'codex_exec',
  'Run codex on a host-side repository clone. Access is restricted by ALLOWED_REPOS.',
  {
    repo: z.string().describe('Allowed repository name, e.g. "autorag-research"'),
    prompt: z.string().describe('Prompt passed to codex exec'),
    branch: z.string().optional().describe('Optional branch to checkout before running codex'),
  },
  async (args) => {
    try {
      const response = await runTaskWithResponse(
        {
          type: 'codex_exec',
          repo: args.repo,
          prompt: args.prompt,
          branch: args.branch,
        },
        CODEX_RESPONSE_TIMEOUT_MS,
      );
      const result = formatTaskResult(response, 'codex exec completed.');
      return {
        content: [{ type: 'text' as const, text: result.text }],
        isError: result.isError,
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `codex_exec failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'git_create_branch',
  'Create and checkout a new branch on a host-side repository clone.',
  {
    repo: z.string().describe('Allowed repository name'),
    branch: z.string().describe('Branch name to create'),
  },
  async (args) => {
    try {
      const response = await runTaskWithResponse(
        {
          type: 'git_create_branch',
          repo: args.repo,
          branch: args.branch,
        },
        HOST_OP_RESPONSE_TIMEOUT_MS,
      );
      const result = formatTaskResult(response, `Created branch ${args.branch}.`);
      return {
        content: [{ type: 'text' as const, text: result.text }],
        isError: result.isError,
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `git_create_branch failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'git_checkout',
  'Checkout an existing branch on a host-side repository clone.',
  {
    repo: z.string().describe('Allowed repository name'),
    branch: z.string().describe('Branch name to checkout'),
  },
  async (args) => {
    try {
      const response = await runTaskWithResponse(
        {
          type: 'git_checkout',
          repo: args.repo,
          branch: args.branch,
        },
        HOST_OP_RESPONSE_TIMEOUT_MS,
      );
      const result = formatTaskResult(response, `Checked out branch ${args.branch}.`);
      return {
        content: [{ type: 'text' as const, text: result.text }],
        isError: result.isError,
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `git_checkout failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'git_pull',
  'Pull latest upstream changes from origin on a host-side repository clone.',
  {
    repo: z.string().describe('Allowed repository name'),
    branch: z.string().optional().describe('Optional branch to pull (defaults to current branch)'),
  },
  async (args) => {
    try {
      const response = await runTaskWithResponse(
        {
          type: 'git_pull',
          repo: args.repo,
          branch: args.branch,
        },
        HOST_OP_RESPONSE_TIMEOUT_MS,
      );
      const result = formatTaskResult(response, 'git pull completed.');
      return {
        content: [{ type: 'text' as const, text: result.text }],
        isError: result.isError,
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `git_pull failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'gh_pr_diff',
  'Read a pull request diff using the host gh CLI.',
  {
    repo: z.string().describe('Allowed repository name'),
    pr_number: z.number().int().positive().describe('Pull request number'),
  },
  async (args) => {
    try {
      const response = await runTaskWithResponse(
        {
          type: 'gh_pr_diff',
          repo: args.repo,
          pr_number: args.pr_number,
        },
        HOST_OP_RESPONSE_TIMEOUT_MS,
      );
      const result = formatTaskResult(response, `Loaded diff for PR #${args.pr_number}.`);
      return {
        content: [{ type: 'text' as const, text: result.text }],
        isError: result.isError,
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `gh_pr_diff failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'gh_pr_review',
  'Submit a pull request review using the host gh CLI.',
  {
    repo: z.string().describe('Allowed repository name'),
    pr_number: z.number().int().positive().describe('Pull request number'),
    body: z.string().describe('Review body (supports markdown)'),
    review_event: z.enum(['comment', 'approve', 'request-changes']).optional().describe('Review action (default: comment)'),
  },
  async (args) => {
    try {
      const reviewEvent = args.review_event ?? 'comment';
      const response = await runTaskWithResponse(
        {
          type: 'gh_pr_review',
          repo: args.repo,
          pr_number: args.pr_number,
          body: args.body,
          review_event: reviewEvent,
        },
        HOST_OP_RESPONSE_TIMEOUT_MS,
      );
      const result = formatTaskResult(response, `Submitted ${reviewEvent} review for PR #${args.pr_number}.`);
      return {
        content: [{ type: 'text' as const, text: result.text }],
        isError: result.isError,
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `gh_pr_review failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'gh_issue_list',
  'List GitHub issues from a host-side repository clone.',
  {
    repo: z.string().describe('Allowed repository name'),
    state: z.enum(['open', 'closed', 'all']).optional().describe('Issue state filter'),
  },
  async (args) => {
    try {
      const response = await runTaskWithResponse(
        {
          type: 'gh_issue_list',
          repo: args.repo,
          state: args.state,
        },
        HOST_OP_RESPONSE_TIMEOUT_MS,
      );
      const result = formatTaskResult(response, 'No issues found.');
      return {
        content: [{ type: 'text' as const, text: result.text }],
        isError: result.isError,
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `gh_issue_list failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'gh_issue_comment',
  'Post a GitHub issue comment using the host gh CLI.',
  {
    repo: z.string().describe('Allowed repository name'),
    issue_number: z.number().int().positive().describe('Issue number'),
    body: z.string().describe('Comment body'),
  },
  async (args) => {
    try {
      const response = await runTaskWithResponse(
        {
          type: 'gh_issue_comment',
          repo: args.repo,
          issue_number: args.issue_number,
          body: args.body,
        },
        HOST_OP_RESPONSE_TIMEOUT_MS,
      );
      const result = formatTaskResult(response, `Comment posted to issue #${args.issue_number}.`);
      return {
        content: [{ type: 'text' as const, text: result.text }],
        isError: result.isError,
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `gh_issue_comment failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'gh_issue_linked_prs',
  'List pull requests linked to a GitHub issue using the host gh CLI.',
  {
    repo: z.string().describe('Allowed repository name'),
    issue_number: z.number().int().positive().describe('Issue number'),
  },
  async (args) => {
    try {
      const response = await runTaskWithResponse(
        {
          type: 'gh_issue_linked_prs',
          repo: args.repo,
          issue_number: args.issue_number,
        },
        HOST_OP_RESPONSE_TIMEOUT_MS,
      );
      const result = formatTaskResult(
        response,
        `No linked pull requests found for issue #${args.issue_number}.`,
      );
      return {
        content: [{ type: 'text' as const, text: result.text }],
        isError: result.isError,
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `gh_issue_linked_prs failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'write_secondbrain_insight',
  `Write a structured insight or summary to the SecondBrain inbox.

SecondBrain is a shared knowledge store. Drop insights here after:
- A design decision is made
- A bug is triaged or resolved
- A feature is scoped and planned
- A thread or conversation is summarized
- Trend research or marketing results are captured

Files are written to /workspace/secondbrain/inbox/ as timestamped Markdown files with YAML frontmatter.

REQUIRED: type, source, title, content
RECOMMENDED: project, tags

Type values:
  pm-insight       — PM agent events: decisions, summaries, triage
  marketer-insight — Marketing: campaign results, trend findings
  decision         — Architectural or product decision
  feature          — Feature scope or plan
  bug              — Bug triage, root cause, resolution
  blocked          — Stalled work (include why + next steps)
  retro            — Retrospective or lessons learned
  summary          — General conversation or session summary
  note             — Freeform note or observation`,
  {
    type: InsightTypeSchema.describe('Type of insight (pm-insight | marketer-insight | decision | feature | bug | blocked | retro | summary | note)'),
    source: z.string().min(1).describe('Agent writing this entry (e.g. "pm-myproject", "marketer", "dobby")'),
    title: z.string().min(1).describe('Short descriptive title'),
    content: z.string().min(1).describe('Main content in Markdown (what happened, key details, context)'),
    project: z.string().optional().describe('Project name this insight belongs to'),
    tags: z.array(z.string()).optional().describe('Classification tags, e.g. ["decision", "auth", "api"]'),
    decisions: z.array(z.string()).optional().describe('Concrete decisions made, if any'),
    action_items: z.array(z.object({
      task: z.string().describe('What needs to be done'),
      owner: z.string().optional().describe('Person or agent responsible'),
      done: z.boolean().default(false).describe('Whether completed'),
    })).optional().describe('Follow-up action items'),
    links: z.array(z.string()).optional().describe('Relevant URLs (GitHub issues, PRs, docs)'),
    priority: PrioritySchema.describe('Priority: low | medium | high'),
  },
  async (args) => {
    const result = writeInsight({
      type: args.type,
      source: args.source,
      title: args.title,
      content: args.content,
      project: args.project,
      tags: args.tags ?? [],
      decisions: args.decisions,
      action_items: args.action_items,
      links: args.links,
      priority: args.priority,
    });

    if (!result.success) {
      return {
        content: [{ type: 'text' as const, text: `Failed to write SecondBrain insight: ${result.error}` }],
        isError: true,
      };
    }

    return {
      content: [{ type: 'text' as const, text: `SecondBrain insight written: ${result.filename}` }],
    };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond there. Main group only.

Use available_groups.json to find the JID for a group. The folder name should be lowercase with hyphens (e.g., "family-chat"). For Slack use "slack:<CHANNEL_ID>" (e.g., "slack:C12345678").`,
  {
    jid: z.string().describe('Channel/group JID (e.g., "120363...@g.us" or "slack:C12345678")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Folder name for group files (lowercase, hyphens, e.g., "family-chat")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
    requires_trigger: z.boolean().optional().describe('Whether messages need trigger prefix. Default true. Use false for dedicated channels.'),
    role: z.string().optional().describe('Optional agent role identifier (e.g., "pm-agent", "marketer")'),
    model: z.string().optional().describe('Optional per-agent model override (e.g., "claude-opus-4-6" or "claude-sonnet-4-6")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      requiresTrigger: args.requires_trigger,
      role: args.role,
      containerConfig: args.model
        ? { model: args.model }
        : undefined,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
