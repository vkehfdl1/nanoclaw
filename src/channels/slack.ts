import fs from 'fs';
import path from 'path';

import { App, LogLevel } from '@slack/bolt';

import { ASSISTANT_NAME, GROUPS_DIR } from '../config.js';
import { updateChatName } from '../db.js';
import { logger } from '../logger.js';
import { formatOutbound } from '../router.js';
import { Channel, OnInboundMessage, OnChatMetadata, RegisteredGroup } from '../types.js';
import {
  extractPmMentionContext,
  formatPmMentionContent,
  isPmAgentGroup,
} from './slack-pm-mention.js';

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  botToken: string;
  appToken: string;
}

export class SlackChannel implements Channel {
  name = 'slack';
  private static readonly MARKETER_FOLDER = 'marketer';
  private static readonly DRAFT_TAG_REGEX = /\[DRAFT\s*-\s*[^\]\n]+\]/i;
  private static readonly MARKETER_APPROVAL_INSTRUCTION =
    'React with :white_check_mark: or reply "승인" to approve.';
  private static readonly APPROVAL_REACTIONS = new Set([
    'white_check_mark',
    'heavy_check_mark',
  ]);

  private app: App;
  private connected = false;
  private botUserId = '';
  private opts: SlackChannelOpts;

  /**
   * Tracks the Slack thread_ts to reply into for each chatJid.
   * Updated whenever a message or @mention arrives from a registered group:
   *   - If the event is already in a thread, use its thread_ts (reply in same thread)
   *   - If it's a top-level message, use its ts (start a new reply thread)
   *
   * This ensures PM agent responses always go back into the originating thread.
   * `sendMessage` reads from this map automatically, so no callers need to change.
   */
  private activeThreadTs = new Map<string, string>();

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;
    this.app = new App({
      token: opts.botToken,
      appToken: opts.appToken,
      socketMode: true,
      logLevel: LogLevel.WARN,
    });
  }

  private getAssistantLabel(jid: string): string {
    const group = this.opts.registeredGroups()[jid];
    const trigger = group?.trigger?.trim();
    if (!trigger) return ASSISTANT_NAME;
    const label = trigger.startsWith('@') ? trigger.slice(1).trim() : trigger;
    return label || ASSISTANT_NAME;
  }

  private toIsoTimestamp(slackTs: string | undefined): string {
    if (!slackTs) return new Date().toISOString();
    const wholeSeconds = Number(slackTs.split('.')[0]);
    if (!Number.isFinite(wholeSeconds)) return new Date().toISOString();
    return new Date(wholeSeconds * 1000).toISOString();
  }

  private isMarketerGroup(group: RegisteredGroup | undefined): boolean {
    if (!group) return false;
    return group.role === 'marketer' || group.folder === SlackChannel.MARKETER_FOLDER;
  }

  private isDraftMessageText(text: string): boolean {
    return SlackChannel.DRAFT_TAG_REGEX.test(text);
  }

  private isApprovalReplyKeyword(text: string): '승인' | 'approve' | null {
    const trimmed = text.trim();
    if (/^승인(?:\s|$)/i.test(trimmed)) return '승인';
    if (/^approve(?:\s|$)/i.test(trimmed)) return 'approve';
    return null;
  }

  private normalizeMarketerDraftText(
    group: RegisteredGroup | undefined,
    outbound: string,
  ): string {
    if (!this.isMarketerGroup(group)) return outbound;

    const trimmed = outbound.trim();
    if (!this.isDraftMessageText(trimmed)) return outbound;

    if (trimmed.includes(SlackChannel.MARKETER_APPROVAL_INSTRUCTION)) {
      return trimmed;
    }

    return `${trimmed}\n\n${SlackChannel.MARKETER_APPROVAL_INSTRUCTION}`;
  }

  private async resolveSenderName(client: App['client'], userId: string): Promise<string> {
    if (!userId || userId === 'unknown') return 'unknown';
    try {
      const userInfo = await client.users.info({ user: userId });
      return (
        userInfo.user?.profile?.display_name ||
        userInfo.user?.real_name ||
        userInfo.user?.name ||
        userId
      );
    } catch {
      return userId;
    }
  }

  private isMessageFromSlackBot(
    message: { botId?: string; userId?: string },
  ): boolean {
    return !!message.botId || (!!this.botUserId && message.userId === this.botUserId);
  }

  private async fetchMessageByTs(
    client: App['client'],
    channelId: string,
    ts: string,
  ): Promise<{ text: string; userId?: string; botId?: string } | null> {
    const history = await client.conversations.history({
      channel: channelId,
      oldest: ts,
      latest: ts,
      inclusive: true,
      limit: 1,
    });
    const msg = history.messages?.[0] as
      | { text?: string; user?: string; bot_id?: string }
      | undefined;
    if (!msg || typeof msg.text !== 'string') return null;
    return {
      text: msg.text,
      userId: msg.user,
      botId: msg.bot_id,
    };
  }

  private async fetchThreadRootMessage(
    client: App['client'],
    channelId: string,
    threadTs: string,
  ): Promise<{ text: string; userId?: string; botId?: string } | null> {
    const replies = await client.conversations.replies({
      channel: channelId,
      ts: threadTs,
      inclusive: true,
      limit: 1,
    });
    const root = replies.messages?.[0] as
      | { text?: string; user?: string; bot_id?: string }
      | undefined;
    if (!root || typeof root.text !== 'string') return null;
    return {
      text: root.text,
      userId: root.user,
      botId: root.bot_id,
    };
  }

  private buildMarketerApprovalContent(
    group: RegisteredGroup,
    keyword: '승인' | 'approve',
    draftThreadTs: string,
    source: 'reaction' | 'thread-reply',
  ): string {
    const trigger = group.trigger?.trim() || '@marketer';
    const mention = trigger.startsWith('@') ? trigger : `@${trigger}`;

    if (source === 'reaction') {
      return `${mention} 승인\nApproval source: :white_check_mark:\nDraft thread: ${draftThreadTs}`;
    }

    return `${mention} ${keyword}\nDraft thread: ${draftThreadTs}`;
  }

  async connect(): Promise<void> {
    // Resolve bot user ID so we can filter self-messages
    try {
      const auth = await this.app.client.auth.test({ token: this.opts.botToken });
      this.botUserId = auth.user_id as string;
      logger.info({ botUserId: this.botUserId }, 'Slack bot authenticated');
    } catch (err) {
      logger.error({ err }, 'Failed to authenticate Slack bot');
      throw err;
    }

    // Listen for all messages in channels the bot is in
    this.app.message(async ({ message, client }) => {
      // Skip bot messages and non-user subtypes (edits, deletes, etc.)
      // Allow file_share subtype through for file uploads
      if ('bot_id' in message && message.bot_id) return;
      if (message.subtype && message.subtype !== 'file_share') return;

      const hasText = 'text' in message && message.text;
      const hasFiles = 'files' in message && Array.isArray(message.files) && message.files.length > 0;
      if (!hasText && !hasFiles) return;

      const channelId = message.channel;
      const chatJid = `slack:${channelId}`;
      const timestamp = this.toIsoTimestamp(message.ts);

      // Report chat metadata for channel discovery
      const isGroup = channelId.startsWith('C') || channelId.startsWith('G');
      this.opts.onChatMetadata(chatJid, timestamp, undefined, 'slack', isGroup);

      // Only deliver full messages for registered groups
      const groups = this.opts.registeredGroups();
      if (!groups[chatJid]) return;

      // For PM agent channels: if the message @mentions the bot, skip it here.
      // The app_mention handler fires separately and will extract richer context
      // (thread history, channel history) before storing the message.
      const rawText = ('text' in message ? message.text : '') || '';
      const group = groups[chatJid];
      if (
        isPmAgentGroup(group) &&
        this.botUserId &&
        rawText.includes(`<@${this.botUserId}>`)
      ) {
        return;
      }

      // Resolve sender display name
      const userId = ('user' in message ? message.user : undefined) || 'unknown';
      const senderName = await this.resolveSenderName(client, userId);

      // Download any attached files into the group workspace
      const filePaths: string[] = [];
      if (hasFiles) {
        const downloadsDir = path.join(GROUPS_DIR, group.folder, 'downloads');
        fs.mkdirSync(downloadsDir, { recursive: true });

        for (const file of (message as { files: Array<{ id: string; name: string; url_private_download?: string }> }).files) {
          if (!file.url_private_download) continue;
          try {
            const resp = await fetch(file.url_private_download, {
              headers: { Authorization: `Bearer ${this.opts.botToken}` },
            });
            if (!resp.ok) {
              logger.warn({ fileId: file.id, status: resp.status }, 'Failed to download Slack file');
              continue;
            }
            // Slack sometimes returns an HTML login page instead of the file
            const contentType = resp.headers.get('content-type') || '';
            if (contentType.includes('text/html')) {
              logger.warn({ fileId: file.id, contentType }, 'Slack returned HTML instead of file — bot may lack files:read scope');
              continue;
            }
            const safeName = `${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
            const filePath = path.join(downloadsDir, safeName);
            const buffer = Buffer.from(await resp.arrayBuffer());
            fs.writeFileSync(filePath, buffer);
            // Path as seen inside the container
            filePaths.push(`/workspace/group/downloads/${safeName}`);
            logger.info({ fileId: file.id, name: file.name, path: filePath }, 'Slack file downloaded');
          } catch (err) {
            logger.error({ fileId: file.id, err }, 'Error downloading Slack file');
          }
        }
      }

      // Build message content with file references
      let content = ('text' in message ? message.text : '') || '';
      if (filePaths.length > 0) {
        const fileList = filePaths.map(p => `[file: ${p}]`).join('\n');
        content = content ? `${content}\n${fileList}` : fileList;
      }
      if (!content) return;

      const fromMe = userId === this.botUserId;

      // Determine which thread_ts to track for reply-in-thread:
      //   - If the message is already in a thread (thread_ts set), reply there
      //   - Otherwise use message.ts to start a new thread from this message
      const threadTs =
        'thread_ts' in message && typeof message.thread_ts === 'string'
          ? message.thread_ts
          : message.ts;

      // Approval replies in a marketer draft thread are normalized into a
      // trigger message so the marketer agent can publish without extra parsing.
      if (
        !fromMe &&
        this.isMarketerGroup(group) &&
        typeof message.thread_ts === 'string' &&
        message.thread_ts !== message.ts
      ) {
        const keyword = this.isApprovalReplyKeyword(rawText);
        if (keyword) {
          try {
            const root = await this.fetchThreadRootMessage(
              client,
              channelId,
              message.thread_ts,
            );
            if (
              root &&
              this.isMessageFromSlackBot(root) &&
              this.isDraftMessageText(root.text)
            ) {
              content = this.buildMarketerApprovalContent(
                group,
                keyword,
                message.thread_ts,
                'thread-reply',
              );
            }
          } catch (err) {
            logger.error(
              { chatJid, threadTs: message.thread_ts, err },
              'Failed to inspect marketer draft thread for approval reply',
            );
          }
        }
      }

      // Update the active thread for this channel so sendMessage() can reply in-thread
      if (!fromMe) {
        this.activeThreadTs.set(chatJid, threadTs);
        logger.debug({ chatJid, threadTs }, 'Active thread updated from message');
      }

      this.opts.onMessage(chatJid, {
        id: message.ts,
        chat_jid: chatJid,
        sender: userId,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: fromMe,
        is_bot_message: fromMe,
        thread_ts: threadTs,
      });
    });

    // Treat checkmark reactions on marketer drafts as explicit approvals.
    this.app.event('reaction_added', async ({ event, client }) => {
      if (!SlackChannel.APPROVAL_REACTIONS.has(event.reaction || '')) return;
      if (!event.item || event.item.type !== 'message') return;
      if (!event.item.channel || !event.item.ts) return;

      const channelId = event.item.channel;
      const chatJid = `slack:${channelId}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!this.isMarketerGroup(group)) return;

      const timestamp = this.toIsoTimestamp(event.event_ts || event.item.ts);
      this.opts.onChatMetadata(chatJid, timestamp, undefined, 'slack', true);

      let reactedMessage: { text: string; userId?: string; botId?: string } | null = null;
      try {
        reactedMessage = await this.fetchMessageByTs(client, channelId, event.item.ts);
      } catch (err) {
        logger.error(
          { chatJid, threadTs: event.item.ts, err },
          'Failed to fetch reacted Slack message',
        );
        return;
      }

      if (
        !reactedMessage ||
        !this.isMessageFromSlackBot(reactedMessage) ||
        !this.isDraftMessageText(reactedMessage.text)
      ) {
        return;
      }

      const approverId = event.user || 'unknown';
      const senderName = await this.resolveSenderName(client, approverId);
      const content = this.buildMarketerApprovalContent(
        group,
        '승인',
        event.item.ts,
        'reaction',
      );

      this.activeThreadTs.set(chatJid, event.item.ts);
      this.opts.onMessage(chatJid, {
        id: event.event_ts || `reaction-${event.item.ts}-${approverId}`,
        chat_jid: chatJid,
        sender: approverId,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        is_bot_message: false,
        thread_ts: event.item.ts,
      });
    });

    // Listen for app_mention events (when someone @mentions the bot).
    // For PM agent channels this handler extracts rich conversation context
    // (thread history or recent channel messages) before storing the message.
    this.app.event('app_mention', async ({ event, client }) => {
      const channelId = event.channel;
      const chatJid = `slack:${channelId}`;
      const timestamp = this.toIsoTimestamp(event.ts);

      this.opts.onChatMetadata(chatJid, timestamp, undefined, 'slack', true);

      const groups = this.opts.registeredGroups();
      if (!groups[chatJid]) return;

      const group = groups[chatJid];
      const userId = event.user || 'unknown';

      // Determine thread tracking:
      //   - If the @mention is in an existing thread (thread_ts set), reply there
      //   - Otherwise use event.ts to start a new thread from this mention
      const mentionThreadTs =
        'thread_ts' in event && typeof event.thread_ts === 'string'
          ? event.thread_ts
          : event.ts;

      // Update the active thread so sendMessage() replies in the correct thread
      this.activeThreadTs.set(chatJid, mentionThreadTs);

      // -----------------------------------------------------------------------
      // PM agent channel: extract rich @mention context for the agent prompt.
      // -----------------------------------------------------------------------
      if (isPmAgentGroup(group)) {
        try {
          const ctx = await extractPmMentionContext({
            text: event.text,
            userId,
            channelId,
            ts: event.ts,
            threadTs:
              'thread_ts' in event && typeof event.thread_ts === 'string'
                ? event.thread_ts
                : undefined,
            client,
            botUserId: this.botUserId,
          });

          const content = formatPmMentionContent(ctx);

          logger.info(
            {
              chatJid,
              senderName: ctx.senderName,
              isInThread: ctx.isInThread,
              contextMessages: ctx.recentMessages.length,
            },
            '[pm-mention] @mention received with context',
          );

          this.opts.onMessage(chatJid, {
            id: event.ts,
            chat_jid: chatJid,
            sender: userId,
            sender_name: ctx.senderName,
            content,
            timestamp,
            is_from_me: false,
            is_bot_message: false,
            thread_ts: mentionThreadTs,
          });
        } catch (err) {
          // Fallback to plain text if context extraction fails
          logger.error(
            { chatJid, err },
            '[pm-mention] Context extraction failed, falling back to plain text',
          );
          this.opts.onMessage(chatJid, {
            id: event.ts,
            chat_jid: chatJid,
            sender: userId,
            sender_name: userId,
            content: event.text,
            timestamp,
            is_from_me: false,
            is_bot_message: false,
            thread_ts: mentionThreadTs,
          });
        }
        return;
      }

      // -----------------------------------------------------------------------
      // Non-PM agent channel: standard @mention handling (resolve name only).
      // -----------------------------------------------------------------------
      const senderName = await this.resolveSenderName(client, userId);

      logger.debug({ chatJid, mentionThreadTs }, 'Active thread updated from @mention');

      this.opts.onMessage(chatJid, {
        id: event.ts,
        chat_jid: chatJid,
        sender: userId,
        sender_name: senderName,
        content: event.text,
        timestamp,
        is_from_me: false,
        is_bot_message: false,
        thread_ts: mentionThreadTs,
      });
    });

    await this.app.start();
    this.connected = true;
    logger.info('Connected to Slack (Socket Mode)');

    // Sync channel names on startup
    await this.syncChannels();
  }

  /**
   * Send a message to a Slack channel, automatically replying in-thread
   * when we have a tracked active thread for that channel.
   *
   * The `threadTs` parameter allows callers to explicitly target a thread,
   * overriding the auto-tracked one. If neither is provided, the message
   * goes to the top level (no thread).
   */
  async sendMessage(jid: string, text: string, threadTs?: string): Promise<void> {
    const channelId = jid.replace('slack:', '');
    const assistantLabel = this.getAssistantLabel(jid);
    const outbound = formatOutbound(text);
    if (!outbound) return;
    const normalizedOutbound = this.normalizeMarketerDraftText(
      this.opts.registeredGroups()[jid],
      outbound,
    );

    // Use the explicitly provided threadTs, fall back to the auto-tracked active thread
    const replyThreadTs = threadTs ?? this.activeThreadTs.get(jid);

    try {
      await this.app.client.chat.postMessage({
        channel: channelId,
        text: `*${assistantLabel}:* ${normalizedOutbound}`,
        // Use mrkdwn so the bot name is bold
        mrkdwn: true,
        // Reply in-thread when we have a tracked thread (PM agent replies go into thread)
        ...(replyThreadTs ? { thread_ts: replyThreadTs } : {}),
      });
      logger.info(
        { jid, length: normalizedOutbound.length, inThread: !!replyThreadTs },
        'Slack message sent',
      );
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Slack message');
    }
  }

  /**
   * Explicitly post a reply into a specific Slack thread.
   * Use when the thread_ts is known and you don't want to rely on auto-tracking.
   */
  async sendMessageInThread(jid: string, text: string, threadTs: string): Promise<void> {
    return this.sendMessage(jid, text, threadTs);
  }

  /**
   * Return the currently-tracked thread_ts for a given chatJid, if any.
   * Useful for tests and for agents that need to know the active thread.
   */
  getActiveThreadTs(jid: string): string | undefined {
    return this.activeThreadTs.get(jid);
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('slack:');
  }

  async sendFile(jid: string, filePath: string, comment?: string): Promise<void> {
    const channelId = jid.replace('slack:', '');
    const assistantLabel = this.getAssistantLabel(jid);
    try {
      const fileContent = fs.readFileSync(filePath);
      const filename = path.basename(filePath);
      await this.app.client.filesUploadV2({
        channel_id: channelId,
        file: fileContent,
        filename,
        initial_comment: comment ? `*${assistantLabel}:* ${comment}` : undefined,
      });
      logger.info({ jid, filename }, 'Slack file uploaded');
    } catch (err) {
      logger.error({ jid, filePath, err }, 'Failed to upload Slack file');
    }
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.app.stop();
    logger.info('Disconnected from Slack');
  }

  /**
   * Sync channel names from Slack API and store in DB.
   */
  async syncChannels(): Promise<void> {
    try {
      logger.info('Syncing Slack channel metadata...');
      const result = await this.app.client.conversations.list({
        types: 'public_channel,private_channel',
        exclude_archived: true,
        limit: 200,
      });

      let count = 0;
      for (const channel of result.channels || []) {
        if (channel.id && channel.name) {
          const jid = `slack:${channel.id}`;
          updateChatName(jid, `#${channel.name}`);
          count++;
        }
      }
      logger.info({ count }, 'Slack channel metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync Slack channels');
    }
  }
}
