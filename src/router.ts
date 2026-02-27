import { Channel, NewMessage } from './types.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(messages: NewMessage[]): string {
  const lines = messages.map((m) =>
    `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${escapeXml(m.content)}</message>`,
  );
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

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
