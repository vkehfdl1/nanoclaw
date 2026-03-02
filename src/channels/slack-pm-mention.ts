/**
 * PM Agent @mention context extraction for Slack.
 *
 * When a PM agent is @mentioned in its designated Slack channel, this module
 * fetches the surrounding conversation context (thread history or recent channel
 * messages) and formats it into a structured prompt payload for the agent
 * container.
 *
 * Required Slack OAuth scopes (in addition to the base scopes):
 *   - channels:history  (public channels)
 *   - groups:history    (private channels)
 */

import { logger } from '../logger.js';
import { RegisteredGroup } from '../types.js';

/** Maximum number of context messages to fetch above/below the mention. */
export const PM_MENTION_CONTEXT_LIMIT = 10;

/**
 * A single message retrieved from Slack history or thread replies,
 * normalised for use as context.
 */
export interface SlackHistoryMessage {
  /** Slack message timestamp (ts field). */
  ts: string;
  /** Slack user ID of the sender (undefined for bot/webhook posts). */
  userId: string | undefined;
  /** Resolved display name of the sender. */
  senderName: string;
  /** Message text content. */
  text: string;
  /** ISO-8601 timestamp derived from ts. */
  timestampIso: string;
  /** Whether this message is itself inside a thread. */
  isThreadReply: boolean;
}

/**
 * Structured context object produced by {@link extractPmMentionContext}.
 * Passed to {@link formatPmMentionContent} to build the agent prompt string.
 */
export interface PmMentionContext {
  /** The cleaned @mention text with the bot's user mention stripped. */
  mentionText: string;
  /** Full original text of the triggering @mention message. */
  rawText: string;
  /** Slack user ID of the person who @mentioned the bot. */
  senderUserId: string;
  /** Resolved display name of the person who @mentioned the bot. */
  senderName: string;
  /** Slack channel ID (without the `slack:` prefix). */
  channelId: string;
  /** Slack message timestamp of the triggering message (ts). */
  ts: string;
  /** ISO-8601 timestamp of the triggering message. */
  timestamp: string;
  /**
   * Parent thread timestamp. Set only when the mention was posted inside an
   * existing thread. When the mention itself *starts* a new thread,
   * `threadTs` is `undefined` and `isInThread` is `false`.
   */
  threadTs: string | undefined;
  /** True when the @mention was posted as a reply inside an existing thread. */
  isInThread: boolean;
  /** Text of the parent (root) message when the mention is in a thread. */
  parentMessageText: string | undefined;
  /**
   * Ordered list of context messages:
   * - When in a thread: the thread replies preceding the mention (oldest first).
   * - When not in a thread: the most recent channel messages before the
   *   mention (oldest first), excluding bot messages.
   */
  recentMessages: SlackHistoryMessage[];
}

// ---------------------------------------------------------------------------
// Minimal interface for the Slack WebClient methods we need.
// Using duck-typing keeps this module decoupled from @slack/web-api imports.
// ---------------------------------------------------------------------------

interface SlackUserProfile {
  display_name?: string;
  real_name?: string;
}

interface SlackUserInfo {
  profile?: SlackUserProfile;
  real_name?: string;
  name?: string;
}

interface SlackConversationsRepliesResult {
  messages?: Array<{
    ts?: string;
    user?: string;
    username?: string;
    text?: string;
    thread_ts?: string;
    bot_id?: string;
  }>;
}

interface SlackConversationsHistoryResult {
  messages?: Array<{
    ts?: string;
    user?: string;
    username?: string;
    text?: string;
    thread_ts?: string;
    bot_id?: string;
  }>;
}

export interface SlackClientLike {
  users: {
    info(params: { user: string }): Promise<{ user?: SlackUserInfo }>;
  };
  conversations: {
    replies(params: {
      channel: string;
      ts: string;
      limit?: number;
    }): Promise<SlackConversationsRepliesResult>;
    history(params: {
      channel: string;
      limit?: number;
      inclusive?: boolean;
      latest?: string;
    }): Promise<SlackConversationsHistoryResult>;
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Convert a Slack `ts` string to an ISO-8601 timestamp string. */
function slackTsToIso(ts: string): string {
  return new Date(Number(ts.split('.')[0]) * 1000).toISOString();
}

/** Strip all `<@USERID>` mentions from a Slack message text. */
function stripMentions(text: string, botUserId: string): string {
  // Remove the specific bot mention
  let cleaned = text.replace(new RegExp(`<@${botUserId}>`, 'g'), '');
  // Trim any leading/trailing whitespace that remains
  return cleaned.trim();
}

/**
 * Resolve a Slack user's display name via the users.info API.
 * Returns the user ID as a fallback on failure.
 */
async function resolveUserName(
  client: SlackClientLike,
  userId: string,
): Promise<string> {
  try {
    const resp = await client.users.info({ user: userId });
    return (
      resp.user?.profile?.display_name ||
      resp.user?.real_name ||
      resp.user?.name ||
      userId
    );
  } catch {
    return userId;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Determine whether a registered group is configured as a PM agent.
 *
 * A group is considered a PM agent when its `role` field is `'pm-agent'`.
 * This is set at group registration time (e.g. via IPC task or main agent).
 */
export function isPmAgentGroup(group: RegisteredGroup): boolean {
  return group.role === 'pm-agent';
}

/**
 * Extract rich @mention context for a PM agent.
 *
 * When a PM agent is mentioned in its Slack channel, this function:
 * 1. Resolves the sender's display name.
 * 2. Strips the bot @mention from the message text.
 * 3. If the mention is inside an existing thread, fetches the thread history.
 * 4. Otherwise, fetches the N most recent channel messages before the mention.
 *
 * The returned {@link PmMentionContext} is then formatted by
 * {@link formatPmMentionContent} into the agent's input prompt.
 *
 * @param params.text        Full raw text of the app_mention event.
 * @param params.userId      Slack user ID of the sender.
 * @param params.channelId   Slack channel ID.
 * @param params.ts          Message timestamp (Slack ts format).
 * @param params.threadTs    Parent thread ts if replying in a thread, else
 *                           undefined.
 * @param params.client      Slack WebClient (or compatible duck-type).
 * @param params.botUserId   The bot's Slack user ID for mention stripping.
 */
export async function extractPmMentionContext(params: {
  text: string;
  userId: string;
  channelId: string;
  ts: string;
  threadTs: string | undefined;
  client: SlackClientLike;
  botUserId: string;
}): Promise<PmMentionContext> {
  const { text, userId, channelId, ts, threadTs, client, botUserId } = params;

  // 1. Resolve sender display name
  const senderName = await resolveUserName(client, userId);

  // 2. Derive cleaned mention text
  const mentionText = stripMentions(text, botUserId);
  const timestamp = slackTsToIso(ts);

  // A message is "in a thread" when threadTs is set AND differs from its own ts.
  // If threadTs === ts the message is itself the root of a new thread.
  const isInThread = !!threadTs && threadTs !== ts;

  let recentMessages: SlackHistoryMessage[] = [];
  let parentMessageText: string | undefined;

  if (isInThread && threadTs) {
    // -----------------------------------------------------------------------
    // Fetch the thread replies for context.
    // The first message in the replies array is always the root/parent message.
    // -----------------------------------------------------------------------
    try {
      const result = await client.conversations.replies({
        channel: channelId,
        ts: threadTs,
        limit: PM_MENTION_CONTEXT_LIMIT + 2, // +2 for parent + triggering msg
      });

      const allMsgs = result.messages ?? [];

      // First message is the root/parent
      if (allMsgs.length > 0 && allMsgs[0].ts === threadTs) {
        parentMessageText = allMsgs[0].text ?? '';
      }

      // Thread replies excluding the root and the triggering @mention itself
      const replies = allMsgs.filter(
        (m) => m.ts !== threadTs && m.ts !== ts,
      );

      recentMessages = await Promise.all(
        replies.slice(-PM_MENTION_CONTEXT_LIMIT).map(async (m): Promise<SlackHistoryMessage> => {
          const msgUserId = m.user;
          const msgName = msgUserId
            ? msgUserId === userId
              ? senderName
              : await resolveUserName(client, msgUserId)
            : m.username ?? 'unknown';
          return {
            ts: m.ts ?? '',
            userId: msgUserId,
            senderName: msgName,
            text: m.text ?? '',
            timestampIso: slackTsToIso(m.ts ?? '0'),
            isThreadReply: true,
          };
        }),
      );
    } catch (err) {
      logger.warn(
        { channelId, threadTs, err },
        '[pm-mention] Failed to fetch thread replies for context',
      );
    }
  } else {
    // -----------------------------------------------------------------------
    // Fetch recent channel history preceding the @mention.
    // Excludes bot messages and the triggering message itself.
    // -----------------------------------------------------------------------
    try {
      const result = await client.conversations.history({
        channel: channelId,
        limit: PM_MENTION_CONTEXT_LIMIT + 1, // +1 to account for the mention itself
        inclusive: true,
        latest: ts,
      });

      // Filter out the triggering message and any bot messages
      const channelMsgs = (result.messages ?? []).filter(
        (m) => m.ts !== ts && !m.bot_id,
      );

      // messages.history returns newest-first; reverse to oldest-first
      const ordered = channelMsgs
        .slice(0, PM_MENTION_CONTEXT_LIMIT)
        .reverse();

      recentMessages = await Promise.all(
        ordered.map(async (m): Promise<SlackHistoryMessage> => {
          const msgUserId = m.user;
          const msgName = msgUserId
            ? msgUserId === userId
              ? senderName
              : await resolveUserName(client, msgUserId)
            : m.username ?? 'unknown';
          return {
            ts: m.ts ?? '',
            userId: msgUserId,
            senderName: msgName,
            text: m.text ?? '',
            timestampIso: slackTsToIso(m.ts ?? '0'),
            isThreadReply: false,
          };
        }),
      );
    } catch (err) {
      logger.warn(
        { channelId, ts, err },
        '[pm-mention] Failed to fetch channel history for context',
      );
    }
  }

  return {
    mentionText,
    rawText: text,
    senderUserId: userId,
    senderName,
    channelId,
    ts,
    timestamp,
    threadTs: isInThread ? threadTs : undefined,
    isInThread,
    parentMessageText,
    recentMessages,
  };
}

/**
 * Format a {@link PmMentionContext} into a human-readable message string
 * suitable for storage and forwarding to the PM agent container.
 *
 * Layout:
 * ```
 * [PM @mention from {name}]
 * {mentionText}
 *
 * [Thread context — parent message]   <- only when isInThread
 * {parentMessageText}
 *
 * [Thread history]   OR   [Recent channel history]
 * {sender} [{timestamp}]: {text}
 * ...
 * ```
 */
export function formatPmMentionContent(ctx: PmMentionContext): string {
  const lines: string[] = [];

  // Header line — identifies the mention source
  lines.push(`[PM @mention from ${ctx.senderName}]`);
  lines.push(ctx.mentionText);

  // Thread parent, when available
  if (ctx.isInThread && ctx.parentMessageText) {
    lines.push('');
    lines.push('[Thread context — parent message]');
    lines.push(ctx.parentMessageText);
  }

  // Conversation history
  if (ctx.recentMessages.length > 0) {
    lines.push('');
    lines.push(ctx.isInThread ? '[Thread history]' : '[Recent channel history]');

    for (const msg of ctx.recentMessages) {
      // Trim long messages for prompt efficiency
      const preview =
        msg.text.length > 400 ? `${msg.text.slice(0, 400)}…` : msg.text;
      lines.push(`${msg.senderName} [${msg.timestampIso}]: ${preview}`);
    }
  }

  return lines.join('\n');
}
