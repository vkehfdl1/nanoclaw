import { AgentGateway, GatewayRule, NewMessage, RegisteredGroup } from './types.js';

/**
 * Check if message content contains any of the given aliases (case-insensitive substring match).
 */
export function matchesAlias(content: string, aliases: string[]): boolean {
  const lower = content.toLowerCase();
  return aliases.some((alias) => lower.includes(alias.toLowerCase()));
}

/**
 * Identify the source agent from a bot message using the `*AgentName:*` prefix convention.
 */
function parseAgentSource(message: NewMessage): string | undefined {
  if (message.agent_source) return message.agent_source;
  const match = message.content.match(/^\*([^:*]+):\*/);
  return match ? match[1].toLowerCase() : undefined;
}

/**
 * Evaluate a single gateway rule against a message.
 * All specified fields in a rule are ANDed together.
 */
export function evaluateRule(
  rule: GatewayRule,
  message: NewMessage,
  agent: RegisteredGroup,
  chatJid: string,
): boolean {
  // channel filter: message must be in one of the listed channels
  if (rule.channel && rule.channel.length > 0) {
    if (!rule.channel.includes(chatJid)) return false;
  }

  // match type
  if (rule.match) {
    switch (rule.match) {
      case 'self_mention':
        if (!matchesAlias(message.content, agent.aliases)) return false;
        break;
      case 'cross_agent':
        if (!message.is_cross_agent && !message.agent_source) return false;
        if (rule.fromAgents && rule.fromAgents.length > 0) {
          const source = parseAgentSource(message);
          if (!source || !rule.fromAgents.some((a) => a.toLowerCase() === source)) {
            return false;
          }
        }
        break;
      case 'any_message':
        // No additional filtering — any message passes
        break;
    }
  }

  // keywords: at least one must be present (OR within keywords, AND with other fields)
  if (rule.keywords && rule.keywords.length > 0) {
    const lower = message.content.toLowerCase();
    if (!rule.keywords.some((kw) => lower.includes(kw.toLowerCase()))) {
      return false;
    }
  }

  return true;
}

/**
 * Evaluate the full gateway for an agent against a message.
 * Rules are ORed: if any rule matches, the message is accepted.
 *
 * Bot messages are excluded by default (excludeBotMessages !== false)
 * unless the message is a cross-agent message.
 */
export function evaluateGateway(
  message: NewMessage,
  agent: RegisteredGroup,
  chatJid: string,
): boolean {
  const gw = agent.gateway;
  if (!gw || !gw.rules || gw.rules.length === 0) return false;

  // Exclude bot messages unless explicitly allowed or cross-agent
  if (
    gw.excludeBotMessages !== false &&
    message.is_bot_message &&
    !message.is_cross_agent
  ) {
    return false;
  }

  // OR across rules
  return gw.rules.some((rule) => evaluateRule(rule, message, agent, chatJid));
}
