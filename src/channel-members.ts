import { getAgentsByChannel } from './db.js';
import { logger } from './logger.js';
import { ChannelMember } from './types.js';

const CHANNEL_MEMBER_CACHE_TTL_MS = 5 * 60 * 1000;
const SLACK_CHANNEL_PREFIX = 'slack:';

interface ChannelMembersCacheEntry {
  expiresAt: number;
  members: ChannelMember[];
  inFlight?: Promise<ChannelMember[]>;
}

interface SlackConversationsMembersResponse {
  ok: boolean;
  members?: string[];
  error?: string;
  response_metadata?: {
    next_cursor?: string;
  };
}

interface SlackUserInfoResponse {
  ok: boolean;
  error?: string;
  user?: {
    id?: string;
    is_bot?: boolean;
    profile?: {
      display_name?: string;
    };
    real_name?: string;
    name?: string;
  };
}

const channelMemberCache = new Map<string, ChannelMembersCacheEntry>();

function getSlackMentionIdentifier(userId: string): string {
  if (userId.startsWith('@')) {
    return userId;
  }
  return `<@${userId}>`;
}

function getDisplayNameFromUser(user: SlackUserInfoResponse['user'], fallback: string): string {
  return (
    user?.profile?.display_name?.trim() ||
    user?.real_name?.trim() ||
    user?.name?.trim() ||
    fallback
  );
}

async function fetchSlackJson<T>(url: string, botToken: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${botToken}`,
    },
  });
  if (!response.ok) {
    throw new Error(`Slack API request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

async function fetchConversationMemberIds(
  channelId: string,
  botToken: string,
): Promise<string[]> {
  const memberIds: string[] = [];
  let cursor = '';

  do {
    const params = new URLSearchParams({ channel: channelId, limit: '1000' });
    if (cursor) {
      params.set('cursor', cursor);
    }
    const url = `https://slack.com/api/conversations.members?${params.toString()}`;
    const payload = await fetchSlackJson<SlackConversationsMembersResponse>(url, botToken);
    if (!payload.ok) {
      throw new Error(`conversations.members failed: ${payload.error ?? 'unknown_error'}`);
    }
    memberIds.push(...(payload.members ?? []));
    cursor = payload.response_metadata?.next_cursor ?? '';
  } while (cursor);

  return memberIds;
}

async function fetchUserMember(userId: string, botToken: string): Promise<ChannelMember> {
  const params = new URLSearchParams({ user: userId });
  const url = `https://slack.com/api/users.info?${params.toString()}`;
  const payload = await fetchSlackJson<SlackUserInfoResponse>(url, botToken);
  if (!payload.ok) {
    throw new Error(`users.info failed for ${userId}: ${payload.error ?? 'unknown_error'}`);
  }
  return {
    userId,
    displayName: getDisplayNameFromUser(payload.user, userId),
    isBot: Boolean(payload.user?.is_bot),
  };
}

function getAgentMembersForChannel(channelId: string): ChannelMember[] {
  const jid = `${SLACK_CHANNEL_PREFIX}${channelId}`;
  const groups = getAgentsByChannel(jid);
  const seen = new Set<string>();
  const agents: ChannelMember[] = [];

  for (const group of groups) {
    const trigger = group.trigger?.trim();
    const mentionableId = trigger || `@${group.folder}`;
    if (seen.has(mentionableId)) {
      continue;
    }
    seen.add(mentionableId);
    agents.push({
      userId: mentionableId,
      displayName: group.name,
      isBot: true,
      agentRole: group.role ?? 'agent',
    });
  }

  return agents;
}

export function resetChannelMembersCache(): void {
  channelMemberCache.clear();
}

export async function getChannelMembers(
  channelId: string,
  botToken: string,
): Promise<ChannelMember[]> {
  const now = Date.now();
  const cached = channelMemberCache.get(channelId);
  if (cached && cached.expiresAt > now) {
    return cached.members;
  }
  if (cached?.inFlight) {
    return cached.inFlight;
  }

  const inFlight = (async () => {
    const memberIds = await fetchConversationMemberIds(channelId, botToken);
    const userMembers = await Promise.all(
      memberIds.map((userId) => fetchUserMember(userId, botToken)),
    );
    const agentMembers = getAgentMembersForChannel(channelId);
    const members = [...userMembers, ...agentMembers];
    channelMemberCache.set(channelId, {
      members,
      expiresAt: Date.now() + CHANNEL_MEMBER_CACHE_TTL_MS,
    });
    return members;
  })();

  channelMemberCache.set(channelId, {
    expiresAt: 0,
    members: cached?.members ?? [],
    inFlight,
  });

  try {
    return await inFlight;
  } catch (err) {
    if (cached?.members?.length) {
      logger.warn(
        { channelId, err },
        'Using stale cached channel members after Slack API failure',
      );
      return cached.members;
    }
    channelMemberCache.delete(channelId);
    throw err;
  }
}

export function buildChannelMembersPreamble(members: ChannelMember[]): string {
  const lines = members.map((member) => {
    const roleLabel = member.agentRole ? `agent: ${member.agentRole}` : 'human';
    return `- ${member.displayName} (${roleLabel}, mention: ${getSlackMentionIdentifier(member.userId)})`;
  });

  return `[Channel members]\n${lines.join('\n')}`;
}

export async function prependChannelMembersToPrompt(
  chatJid: string,
  prompt: string,
  botToken: string,
): Promise<string> {
  if (!chatJid.startsWith(SLACK_CHANNEL_PREFIX)) {
    return prompt;
  }
  const channelId = chatJid.slice(SLACK_CHANNEL_PREFIX.length);
  if (!channelId) {
    return prompt;
  }

  try {
    const members = await getChannelMembers(channelId, botToken);
    if (members.length === 0) {
      return prompt;
    }
    const preamble = buildChannelMembersPreamble(members);
    return `${preamble}\n\n${prompt}`;
  } catch (err) {
    logger.warn(
      { chatJid, err },
      'Failed to fetch Slack channel members for prompt preamble',
    );
    return prompt;
  }
}
