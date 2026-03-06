import { findPmAgentByGithubRepo } from './db.js';
import { hasGithubEventMarker } from './github-event-markers.js';
import { GithubNormalizedActor, GithubNormalizedEvent } from './types.js';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readActor(raw: unknown): GithubNormalizedActor {
  if (!isObject(raw)) {
    return { login: 'unknown', type: 'Unknown', isBot: false };
  }

  const login = typeof raw.login === 'string' && raw.login.trim()
    ? raw.login.trim()
    : 'unknown';
  const type = typeof raw.type === 'string' && raw.type.trim()
    ? raw.type.trim()
    : 'Unknown';
  const isBot = type !== 'User' || login.endsWith('[bot]');

  return { login, type, isBot };
}

function readRepository(payload: Record<string, unknown>): {
  fullName: string;
  url: string;
} | null {
  const repository = payload.repository;
  if (!isObject(repository)) return null;
  const fullName = typeof repository.full_name === 'string'
    ? repository.full_name.trim()
    : '';
  if (!fullName) return null;
  const url = typeof repository.html_url === 'string'
    ? repository.html_url.trim()
    : '';
  return { fullName, url };
}

function readInstallationId(payload: Record<string, unknown>): number | null {
  const installation = payload.installation;
  if (!isObject(installation)) return null;
  return Number.isInteger(installation.id) ? Number(installation.id) : null;
}

function readNumber(raw: unknown): number | null {
  return Number.isInteger(raw) && Number(raw) > 0 ? Number(raw) : null;
}

function isPullRequestIssue(rawIssue: Record<string, unknown>): boolean {
  return isObject(rawIssue.pull_request);
}

export interface GithubEventNormalizationResult {
  event?: GithubNormalizedEvent;
  ignoreReason?: string;
}

export function normalizeGithubEvent(
  eventNameRaw: string,
  payloadRaw: unknown,
  deliveryId: string,
): GithubEventNormalizationResult {
  if (!isObject(payloadRaw)) {
    return { ignoreReason: 'Payload is not a JSON object' };
  }

  if (eventNameRaw === 'ping') {
    return { ignoreReason: 'GitHub ping event' };
  }

  const repository = readRepository(payloadRaw);
  if (!repository) {
    return { ignoreReason: 'Missing repository.full_name in webhook payload' };
  }

  const pmGroup = findPmAgentByGithubRepo(repository.fullName);
  if (!pmGroup) {
    return { ignoreReason: `No PM agent registered for ${repository.fullName}` };
  }

  const action = typeof payloadRaw.action === 'string' ? payloadRaw.action.trim() : '';
  if (!action) {
    return { ignoreReason: 'Missing webhook action' };
  }

  const installationId = readInstallationId(payloadRaw);
  const eventName = eventNameRaw as GithubNormalizedEvent['eventName'];

  if (eventNameRaw === 'issues') {
    if (!['opened', 'reopened', 'edited'].includes(action)) {
      return { ignoreReason: `Unsupported issues action: ${action}` };
    }
    const issue = payloadRaw.issue;
    if (!isObject(issue)) return { ignoreReason: 'Missing issue payload' };
    const issueNumber = readNumber(issue.number);
    if (!issueNumber) return { ignoreReason: 'Invalid issue number' };
    const actor = readActor(payloadRaw.sender);
    return {
      event: {
        deliveryId,
        eventName: 'issues',
        action,
        installationId,
        repositoryFullName: repository.fullName,
        repositoryUrl: repository.url,
        groupFolder: pmGroup.folder,
        chatJid: pmGroup.jid,
        resourceType: 'issue',
        resourceNumber: issueNumber,
        resourceKey: `github:issue:${repository.fullName}#${issueNumber}`,
        triggerKind: `issue-${action}`,
        author: actor,
        payload: payloadRaw,
      },
    };
  }

  if (eventNameRaw === 'issue_comment') {
    if (!['created', 'edited'].includes(action)) {
      return { ignoreReason: `Unsupported issue_comment action: ${action}` };
    }
    const issue = payloadRaw.issue;
    const comment = payloadRaw.comment;
    if (!isObject(issue) || !isObject(comment)) {
      return { ignoreReason: 'Missing issue comment payload' };
    }
    if (hasGithubEventMarker(comment.body)) {
      return { ignoreReason: 'Ignoring NanoClaw-authored issue comment event' };
    }
    const actor = readActor(payloadRaw.sender);
    if (actor.isBot) {
      return { ignoreReason: 'Ignoring bot-authored issue comment event' };
    }
    const number = readNumber(issue.number);
    if (!number) return { ignoreReason: 'Invalid issue number for issue_comment event' };

    const isPr = isPullRequestIssue(issue);
    const draft = isPr && typeof issue.draft === 'boolean' ? issue.draft : false;
    if (isPr && draft) {
      return { ignoreReason: 'Ignoring draft PR comment event' };
    }

    return {
      event: {
        deliveryId,
        eventName: 'issue_comment',
        action,
        installationId,
        repositoryFullName: repository.fullName,
        repositoryUrl: repository.url,
        groupFolder: pmGroup.folder,
        chatJid: pmGroup.jid,
        resourceType: isPr ? 'pr' : 'issue',
        resourceNumber: number,
        resourceKey: `github:${isPr ? 'pr' : 'issue'}:${repository.fullName}#${number}`,
        triggerKind: isPr ? `pr-comment-${action}` : `issue-comment-${action}`,
        author: actor,
        payload: payloadRaw,
      },
    };
  }

  if (eventNameRaw === 'pull_request') {
    if (!['opened', 'reopened', 'synchronize', 'ready_for_review'].includes(action)) {
      return { ignoreReason: `Unsupported pull_request action: ${action}` };
    }
    const pullRequest = payloadRaw.pull_request;
    if (!isObject(pullRequest)) return { ignoreReason: 'Missing pull_request payload' };
    const prNumber = readNumber(pullRequest.number ?? payloadRaw.number);
    if (!prNumber) return { ignoreReason: 'Invalid PR number' };
    const draft = typeof pullRequest.draft === 'boolean' ? pullRequest.draft : false;
    if (draft && action !== 'ready_for_review') {
      return { ignoreReason: 'Ignoring draft PR event until ready_for_review' };
    }

    return {
      event: {
        deliveryId,
        eventName: 'pull_request',
        action,
        installationId,
        repositoryFullName: repository.fullName,
        repositoryUrl: repository.url,
        groupFolder: pmGroup.folder,
        chatJid: pmGroup.jid,
        resourceType: 'pr',
        resourceNumber: prNumber,
        resourceKey: `github:pr:${repository.fullName}#${prNumber}`,
        triggerKind: `pr-${action.replace(/_/g, '-')}`,
        author: readActor(payloadRaw.sender),
        payload: payloadRaw,
      },
    };
  }

  if (eventNameRaw === 'pull_request_review') {
    if (action !== 'submitted') {
      return { ignoreReason: `Unsupported pull_request_review action: ${action}` };
    }
    const review = payloadRaw.review;
    const pullRequest = payloadRaw.pull_request;
    if (!isObject(review) || !isObject(pullRequest)) {
      return { ignoreReason: 'Missing PR review payload' };
    }
    if (hasGithubEventMarker(review.body)) {
      return { ignoreReason: 'Ignoring NanoClaw-authored pull request review event' };
    }
    const actor = readActor(payloadRaw.sender);
    if (actor.isBot) {
      return { ignoreReason: 'Ignoring bot-authored pull request review event' };
    }
    const prNumber = readNumber(pullRequest.number ?? payloadRaw.number);
    if (!prNumber) return { ignoreReason: 'Invalid PR number for review event' };
    return {
      event: {
        deliveryId,
        eventName: 'pull_request_review',
        action,
        installationId,
        repositoryFullName: repository.fullName,
        repositoryUrl: repository.url,
        groupFolder: pmGroup.folder,
        chatJid: pmGroup.jid,
        resourceType: 'pr',
        resourceNumber: prNumber,
        resourceKey: `github:pr:${repository.fullName}#${prNumber}`,
        triggerKind: 'pr-review-submitted',
        author: actor,
        payload: payloadRaw,
      },
    };
  }

  if (eventNameRaw === 'pull_request_review_comment') {
    if (action !== 'created') {
      return { ignoreReason: `Unsupported pull_request_review_comment action: ${action}` };
    }
    const comment = payloadRaw.comment;
    if (isObject(comment) && hasGithubEventMarker(comment.body)) {
      return { ignoreReason: 'Ignoring NanoClaw-authored pull request review comment event' };
    }
    const pullRequest = payloadRaw.pull_request;
    if (!isObject(pullRequest)) {
      return { ignoreReason: 'Missing PR review comment payload' };
    }
    const actor = readActor(payloadRaw.sender);
    if (actor.isBot) {
      return { ignoreReason: 'Ignoring bot-authored pull request review comment event' };
    }
    const prNumber = readNumber(pullRequest.number ?? payloadRaw.number);
    if (!prNumber) return { ignoreReason: 'Invalid PR number for review comment event' };
    return {
      event: {
        deliveryId,
        eventName: 'pull_request_review_comment',
        action,
        installationId,
        repositoryFullName: repository.fullName,
        repositoryUrl: repository.url,
        groupFolder: pmGroup.folder,
        chatJid: pmGroup.jid,
        resourceType: 'pr',
        resourceNumber: prNumber,
        resourceKey: `github:pr:${repository.fullName}#${prNumber}`,
        triggerKind: 'pr-review-comment-created',
        author: actor,
        payload: payloadRaw,
      },
    };
  }

  return { ignoreReason: `Unsupported webhook event: ${eventNameRaw}` };
}
