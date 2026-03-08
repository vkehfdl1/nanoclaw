import { Channel, NewMessage, OutboundMessageOptions } from './types.js';

export interface ReplyAudit {
  reply_needed: boolean;
  reply_sent: boolean;
  reason: string;
}

export type ReplyAuditParseResult =
  | { kind: 'valid'; audit: ReplyAudit }
  | { kind: 'missing' }
  | { kind: 'malformed'; error: string };

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(messages: NewMessage[]): string {
  const lines = messages.map((m) => {
    const threadAttr = (m.thread_ts && m.thread_ts !== m.id)
      ? ` thread="${escapeXml(m.thread_ts)}"`
      : '';
    return `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}"${threadAttr}>${escapeXml(m.content)}</message>`;
  });
  return `<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  let sanitized = text;

  // Remove complete internal blocks, including the malformed </invoke> closer.
  sanitized = sanitized.replace(/<internal>[\s\S]*?<\/(?:internal|invoke)>/gi, '');

  // If any <internal> remains unclosed, drop everything after it to avoid leaks.
  const lower = sanitized.toLowerCase();
  const unclosedStart = lower.indexOf('<internal>');
  if (unclosedStart !== -1) {
    sanitized = sanitized.slice(0, unclosedStart);
  }

  // Remove stray tag tokens if they appear standalone.
  sanitized = sanitized
    .replace(/<\/?internal>/gi, '')
    .replace(/<\/?invoke>/gi, '');

  return sanitized.trim();
}

export function parseReplyAudit(rawText: string): ReplyAuditParseResult {
  const matches = [...rawText.matchAll(/<internal>([\s\S]*?)<\/(?:internal|invoke)>/gi)];
  if (matches.length === 0) {
    return rawText.toLowerCase().includes('<internal>')
      ? { kind: 'malformed', error: 'Unclosed <internal> block' }
      : { kind: 'missing' };
  }

  const lastBlock = matches[matches.length - 1]?.[1]?.trim();
  if (!lastBlock) {
    return { kind: 'malformed', error: 'Empty final <internal> block' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(lastBlock);
  } catch (err) {
    return {
      kind: 'malformed',
      error: `Invalid JSON in final <internal> block: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'malformed', error: 'Final <internal> block must be a JSON object' };
  }

  const auditValue = (parsed as Record<string, unknown>).reply_audit;
  if (typeof auditValue !== 'object' || auditValue === null || Array.isArray(auditValue)) {
    return { kind: 'malformed', error: 'Missing reply_audit object' };
  }

  const audit = auditValue as Record<string, unknown>;
  if (typeof audit.reply_needed !== 'boolean') {
    return { kind: 'malformed', error: 'reply_audit.reply_needed must be boolean' };
  }
  if (typeof audit.reply_sent !== 'boolean') {
    return { kind: 'malformed', error: 'reply_audit.reply_sent must be boolean' };
  }
  if (typeof audit.reason !== 'string' || audit.reason.trim() === '') {
    return { kind: 'malformed', error: 'reply_audit.reason must be a non-empty string' };
  }

  return {
    kind: 'valid',
    audit: {
      reply_needed: audit.reply_needed,
      reply_sent: audit.reply_sent,
      reason: audit.reason.trim(),
    },
  };
}

export function normalizeSlackMarkdown(text: string): string {
  let out = text;
  // **bold** → *bold*
  out = out.replace(/\*\*(.+?)\*\*/g, '*$1*');
  // ## Heading → *Heading*
  out = out.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');
  // [text](url) → text (url)
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  return out;
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return normalizeSlackMarkdown(text);
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
  options?: OutboundMessageOptions,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text, options);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
