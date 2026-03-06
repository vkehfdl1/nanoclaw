import { GithubNormalizedEvent } from './types.js';

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function wrapPayload(tag: string, payload: unknown): string {
  return `[${tag}]\n${formatJson(payload)}\n[/${tag}]`;
}

function buildIssueWorkflowInstructions(repoAlias: string): string {
  return [
    'Issue workflow:',
    '1. Parse [GITHUB_EVENT_PAYLOAD] JSON.',
    '2. Assess the issue for scope, risk, missing context, and implementation readiness (`ready` or `needs-details`).',
    `3. Call gh_issue_linked_prs(repo="${repoAlias}", issue_number=<issue number>) before any implementation decision.`,
    '4. If any linked PR is OPEN or already merged, treat the issue as already covered and do not implement it again.',
    `5. Post a gh_issue_comment with triage summary and next step.`,
    '6. Write a SecondBrain insight with type "pm-insight" capturing the issue summary, triage decision, and linked PR status.',
    '7. If readiness is `needs-details`, ask only the smallest remaining question and stop.',
    `8. If readiness is \`ready\` and no linked PR blocks implementation, run:
   - git_pull(repo="${repoAlias}")
   - inspect mounted source under /workspace/extra/${repoAlias}/ and capture concrete file paths, existing patterns, dependencies, and constraints
   - git_create_branch(repo="${repoAlias}", branch="feature/issue-<number>-<slug>")
   - craft a Codex implementation prompt with issue title/body, acceptance criteria, reviewed file paths/snippets, project conventions, validation commands, and explicit instructions to commit, push, and open a PR with \`Closes #<number>\`
   - codex_exec(repo="${repoAlias}", branch="<branch>", prompt="<prompt>")`,
    '9. If Codex fails or times out, post gh_issue_comment with failure details and "Tag: human-attention-needed".',
    '10. Send one concise Slack update only if there is an actionable outcome to report.',
  ].join('\n');
}

function buildIssueCommentWorkflowInstructions(repoAlias: string): string {
  return [
    'Issue follow-up workflow:',
    '1. Parse [GITHUB_EVENT_PAYLOAD] JSON.',
    '2. Treat this as continuation of the existing issue session, not a brand-new issue.',
    '3. Use the prior session context plus the new human comment to determine whether missing details were resolved.',
    `4. Call gh_issue_linked_prs(repo="${repoAlias}", issue_number=<issue number>) before any implementation decision.`,
    '5. If the issue is still not ready, post one narrower follow-up question via gh_issue_comment and stop.',
    '6. If the issue is now ready and no linked PR blocks it, run the standard implementation workflow.',
    '7. If a linked OPEN or MERGED PR now covers the issue, acknowledge that and stop without implementing.',
    '8. Send one concise Slack update only if something actionable changed.',
  ].join('\n');
}

function buildPrWorkflowInstructions(repoAlias: string): string {
  return [
    'Pull request workflow:',
    '1. Parse [GITHUB_EVENT_PAYLOAD] JSON.',
    `2. Fetch the diff with gh_pr_diff(repo="${repoAlias}", pr_number=<pr number>).`,
    `3. Review the mounted code under /workspace/extra/${repoAlias}/ and validate the PR with Codex.`,
    '4. The review must be behavior-first:',
    '   - Do not primarily validate code style or static structure.',
    '   - Prove whether the requested behavior actually works.',
    '   - For frontend changes: run the app, open it, and interact with the changed flow directly.',
    '   - For backend changes: run the service and verify real requests/commands/endpoints.',
    '   - Run tests and inspect code as supporting evidence, not as the main proof.',
    '5. Craft a Codex review prompt that requires:',
    '   - commands executed',
    '   - behavior observed',
    '   - failures reproduced or not reproduced',
    '   - remaining risks and unverified areas',
    '   - a final verdict of approve | comment | request-changes',
    `6. Run codex_exec(repo="${repoAlias}", branch="<current pr branch or empty if unknown>", prompt="<review prompt>").`,
    `7. Submit the final GitHub review with gh_pr_review(repo="${repoAlias}", pr_number=<pr number>, review_event=<approve|comment|request-changes>, body="<review body>").`,
    '8. Never auto-merge.',
    '9. Send one concise Slack update with the verdict and behavior validation summary.',
  ].join('\n');
}

export function buildGithubEventPrompt(
  event: GithubNormalizedEvent,
  repoAlias: string,
): string {
  const header = [
    `Handle GitHub event for ${event.repositoryFullName}.`,
    '',
    `Resource: ${event.resourceType} #${event.resourceNumber}`,
    `Trigger: ${event.triggerKind}`,
    `Repo alias: ${repoAlias}`,
    '',
  ].join('\n');

  if (event.resourceType === 'issue') {
    const instructions = event.eventName === 'issue_comment'
      ? buildIssueCommentWorkflowInstructions(repoAlias)
      : buildIssueWorkflowInstructions(repoAlias);
    return `${header}${instructions}\n\n${wrapPayload('GITHUB_EVENT_PAYLOAD', event.payload)}`;
  }

  return `${header}${buildPrWorkflowInstructions(repoAlias)}\n\n${wrapPayload('GITHUB_EVENT_PAYLOAD', event.payload)}`;
}
