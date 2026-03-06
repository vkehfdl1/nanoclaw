import fs from 'fs';
import path from 'path';

import { App, LogLevel } from '@slack/bolt';

import { ASSISTANT_NAME, GROUPS_DIR } from '../config.js';
import { updateChatName } from '../db.js';
import { logger } from '../logger.js';
import { formatOutbound } from '../router.js';
import { isSlackAudioFile, transcribeSlackAudioFile } from '../transcription.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  OutboundMessageOptions,
  RegisteredGroup,
} from '../types.js';

/**
 * Parse the agent name from a bot message's `*AgentName:*` prefix.
 */
function parseAgentLabel(content: string): string | undefined {
  const match = content.match(/^\*([^:*]+):\*/);
  return match ? match[1] : undefined;
}

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  botToken: string;
  appToken: string;
}

interface SlackFileAttachment {
  id: string;
  name: string;
  url_private_download?: string;
  mimetype?: string;
  filetype?: string;
}

export class SlackChannel implements Channel {
  name = 'slack';

  private app: App;
  private connected = false;
  private botUserId = '';
  private opts: SlackChannelOpts;

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
    if (group?.name) return group.name;
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
      // Mark bot messages but let them through (for cross-agent alias mention routing)
      const isOwnBot = 'bot_id' in message && !!message.bot_id;

      // Skip non-user subtypes (edits, deletes, etc.) — allow file_share and bot_message
      if (message.subtype && message.subtype !== 'file_share' && message.subtype !== 'bot_message') return;

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

      const group = groups[chatJid];

      // Resolve sender display name
      const userId = ('user' in message ? message.user : undefined) || 'unknown';
      const senderName = isOwnBot
        ? (parseAgentLabel(('text' in message ? message.text : '') || '') ?? 'bot')
        : await this.resolveSenderName(client, userId);

      // Download any attached files into the group workspace (skip for own bot messages)
      const filePaths: string[] = [];
      const transcriptBlocks: string[] = [];
      if (hasFiles && !isOwnBot) {
        const downloadsDir = path.join(GROUPS_DIR, group.folder, 'downloads');
        fs.mkdirSync(downloadsDir, { recursive: true });

        for (const file of (message as { files: SlackFileAttachment[] }).files) {
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

            if (isSlackAudioFile(file)) {
              try {
                const transcript = await transcribeSlackAudioFile(filePath, {
                  mimeType: file.mimetype,
                  fileName: file.name,
                });
                if (transcript) {
                  transcriptBlocks.push(`[Voice: ${transcript}]`);
                  logger.info(
                    { fileId: file.id, length: transcript.length },
                    'Transcribed Slack audio file',
                  );
                } else {
                  transcriptBlocks.push('[Voice Message - transcription unavailable]');
                }
              } catch (err) {
                logger.error({ fileId: file.id, err }, 'Slack audio transcription error');
                transcriptBlocks.push('[Voice Message - transcription failed]');
              }
            }
          } catch (err) {
            logger.error({ fileId: file.id, err }, 'Error downloading Slack file');
          }
        }
      }

      // Build message content with file references
      let content = ('text' in message ? message.text : '') || '';
      if (transcriptBlocks.length > 0) {
        const transcriptText = transcriptBlocks.join('\n');
        content = content ? `${content}\n${transcriptText}` : transcriptText;
      }
      if (filePaths.length > 0) {
        const fileList = filePaths.map(p => `[file: ${p}]`).join('\n');
        content = content ? `${content}\n${fileList}` : fileList;
      }
      if (!content) return;

      const fromMe = userId === this.botUserId || isOwnBot;

      // Parse agent source from bot message *AgentName:* prefix
      const agentSource = isOwnBot ? parseAgentLabel(content) : undefined;

      // Determine which thread_ts to track for reply-in-thread:
      //   - If the message is already in a thread (thread_ts set), reply there
      //   - Otherwise use message.ts to start a new thread from this message
      const threadTs =
        'thread_ts' in message && typeof message.thread_ts === 'string'
          ? message.thread_ts
          : message.ts;

      this.opts.onMessage(chatJid, {
        id: message.ts,
        chat_jid: chatJid,
        sender: userId,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: fromMe,
        is_bot_message: isOwnBot,
        agent_source: agentSource,
        thread_ts: threadTs,
      });
    });

    await this.app.start();
    this.connected = true;
    logger.info('Connected to Slack (Socket Mode)');

    // Sync channel names on startup
    await this.syncChannels();
  }

  async sendMessage(
    jid: string,
    text: string,
    options?: OutboundMessageOptions,
  ): Promise<void> {
    const channelId = jid.replace('slack:', '');
    const assistantLabel = options?.agentLabel || this.getAssistantLabel(jid);
    const outbound = formatOutbound(text);
    if (!outbound) return;

    try {
      const payload: {
        channel: string;
        text: string;
        mrkdwn: boolean;
        thread_ts?: string;
      } = {
        channel: channelId,
        text: `*${assistantLabel}:* ${outbound}`,
        mrkdwn: true,
      };
      if (options?.threadTs) {
        payload.thread_ts = options.threadTs;
      }
      await this.app.client.chat.postMessage(payload);
      logger.info(
        {
          jid,
          length: outbound.length,
          inThread: !!options?.threadTs,
          threadTs: options?.threadTs,
        },
        'Slack message sent',
      );
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Slack message');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('slack:');
  }

  async sendFile(jid: string, filePath: string, comment?: string, agentLabel?: string): Promise<void> {
    const channelId = jid.replace('slack:', '');
    const assistantLabel = agentLabel || this.getAssistantLabel(jid);
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
