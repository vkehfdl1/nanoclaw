import { App, LogLevel } from '@slack/bolt';

import { ASSISTANT_NAME } from '../config.js';
import { updateChatName } from '../db.js';
import { logger } from '../logger.js';
import { Channel, OnInboundMessage, OnChatMetadata, RegisteredGroup } from '../types.js';

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  botToken: string;
  appToken: string;
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
      // Skip bot messages, subtypes (edits, deletes, etc.), and thread replies
      if (
        message.subtype ||
        !('text' in message) ||
        !message.text ||
        ('bot_id' in message && message.bot_id)
      ) {
        return;
      }

      const channelId = message.channel;
      const chatJid = `slack:${channelId}`;
      const timestamp = new Date(
        Number(message.ts.split('.')[0]) * 1000,
      ).toISOString();

      // Report chat metadata for channel discovery
      const isGroup = channelId.startsWith('C') || channelId.startsWith('G');
      this.opts.onChatMetadata(chatJid, timestamp, undefined, 'slack', isGroup);

      // Only deliver full messages for registered groups
      const groups = this.opts.registeredGroups();
      if (!groups[chatJid]) return;

      // Resolve sender display name
      let senderName = message.user || 'unknown';
      try {
        const userInfo = await client.users.info({ user: message.user as string });
        senderName =
          userInfo.user?.profile?.display_name ||
          userInfo.user?.real_name ||
          userInfo.user?.name ||
          senderName;
      } catch {
        // Fall back to user ID
      }

      const fromMe = message.user === this.botUserId;

      this.opts.onMessage(chatJid, {
        id: message.ts,
        chat_jid: chatJid,
        sender: message.user || '',
        sender_name: senderName,
        content: message.text,
        timestamp,
        is_from_me: fromMe,
        is_bot_message: fromMe,
      });
    });

    // Also listen for app_mention events (when someone @mentions the bot)
    this.app.event('app_mention', async ({ event, client }) => {
      const channelId = event.channel;
      const chatJid = `slack:${channelId}`;
      const timestamp = new Date(
        Number(event.ts.split('.')[0]) * 1000,
      ).toISOString();

      this.opts.onChatMetadata(chatJid, timestamp, undefined, 'slack', true);

      const groups = this.opts.registeredGroups();
      if (!groups[chatJid]) return;

      const userId = event.user || 'unknown';
      let senderName: string = userId;
      try {
        const userInfo = await client.users.info({ user: userId });
        senderName =
          userInfo.user?.profile?.display_name ||
          userInfo.user?.real_name ||
          userInfo.user?.name ||
          senderName;
      } catch {
        // Fall back to user ID
      }

      this.opts.onMessage(chatJid, {
        id: event.ts,
        chat_jid: chatJid,
        sender: userId,
        sender_name: senderName,
        content: event.text,
        timestamp,
        is_from_me: false,
        is_bot_message: false,
      });
    });

    await this.app.start();
    this.connected = true;
    logger.info('Connected to Slack (Socket Mode)');

    // Sync channel names on startup
    await this.syncChannels();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const channelId = jid.replace('slack:', '');
    try {
      await this.app.client.chat.postMessage({
        channel: channelId,
        text: `*${ASSISTANT_NAME}:* ${text}`,
        // Use mrkdwn so the bot name is bold
        mrkdwn: true,
      });
      logger.info({ jid, length: text.length }, 'Slack message sent');
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
