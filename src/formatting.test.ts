import { describe, it, expect } from 'vitest';

import { ASSISTANT_NAME } from './config.js';
import { evaluateGateway } from './gateway.js';
import {
  escapeXml,
  formatMessages,
  formatOutbound,
  normalizeSlackMarkdown,
  stripInternalTags,
} from './router.js';
import { NewMessage, RegisteredGroup } from './types.js';

function makeMsg(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: '1',
    chat_jid: 'slack:C12345678',
    sender: 'U12345678',
    sender_name: 'Alice',
    content: 'hello',
    timestamp: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeAgent(overrides: Partial<RegisteredGroup> = {}): RegisteredGroup {
  return {
    name: ASSISTANT_NAME,
    folder: 'main',
    trigger: `@${ASSISTANT_NAME}`,
    aliases: [ASSISTANT_NAME.toLowerCase()],
    added_at: '2024-01-01T00:00:00.000Z',
    gateway: { rules: [{ match: 'self_mention' }] },
    ...overrides,
  };
}

// --- escapeXml ---

describe('escapeXml', () => {
  it('escapes ampersands', () => {
    expect(escapeXml('a & b')).toBe('a &amp; b');
  });

  it('escapes less-than', () => {
    expect(escapeXml('a < b')).toBe('a &lt; b');
  });

  it('escapes greater-than', () => {
    expect(escapeXml('a > b')).toBe('a &gt; b');
  });

  it('escapes double quotes', () => {
    expect(escapeXml('"hello"')).toBe('&quot;hello&quot;');
  });

  it('handles multiple special characters together', () => {
    expect(escapeXml('a & b < c > d "e"')).toBe(
      'a &amp; b &lt; c &gt; d &quot;e&quot;',
    );
  });

  it('passes through strings with no special chars', () => {
    expect(escapeXml('hello world')).toBe('hello world');
  });

  it('handles empty string', () => {
    expect(escapeXml('')).toBe('');
  });
});

// --- formatMessages ---

describe('formatMessages', () => {
  it('formats a single message as XML', () => {
    const result = formatMessages([makeMsg()]);
    expect(result).toBe(
      '<messages>\n' +
        '<message sender="Alice" time="2024-01-01T00:00:00.000Z">hello</message>\n' +
        '</messages>',
    );
  });

  it('formats multiple messages', () => {
    const msgs = [
      makeMsg({ id: '1', sender_name: 'Alice', content: 'hi', timestamp: 't1' }),
      makeMsg({ id: '2', sender_name: 'Bob', content: 'hey', timestamp: 't2' }),
    ];
    const result = formatMessages(msgs);
    expect(result).toContain('sender="Alice"');
    expect(result).toContain('sender="Bob"');
    expect(result).toContain('>hi</message>');
    expect(result).toContain('>hey</message>');
  });

  it('escapes special characters in sender names', () => {
    const result = formatMessages([makeMsg({ sender_name: 'A & B <Co>' })]);
    expect(result).toContain('sender="A &amp; B &lt;Co&gt;"');
  });

  it('escapes special characters in content', () => {
    const result = formatMessages([
      makeMsg({ content: '<script>alert("xss")</script>' }),
    ]);
    expect(result).toContain(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
    );
  });

  it('handles empty array', () => {
    const result = formatMessages([]);
    expect(result).toBe('<messages>\n\n</messages>');
  });
});

// --- Outbound formatting (internal tag stripping + prefix) ---

describe('stripInternalTags', () => {
  it('strips single-line internal tags', () => {
    expect(stripInternalTags('hello <internal>secret</internal> world')).toBe(
      'hello  world',
    );
  });

  it('strips multi-line internal tags', () => {
    expect(
      stripInternalTags('hello <internal>\nsecret\nstuff\n</internal> world'),
    ).toBe('hello  world');
  });

  it('strips multiple internal tag blocks', () => {
    expect(
      stripInternalTags(
        '<internal>a</internal>hello<internal>b</internal>',
      ),
    ).toBe('hello');
  });

  it('returns empty string when text is only internal tags', () => {
    expect(stripInternalTags('<internal>only this</internal>')).toBe('');
  });

  it('strips malformed internal block closed with </invoke>', () => {
    expect(stripInternalTags('hello <internal>secret</invoke> world')).toBe(
      'hello  world',
    );
  });

  it('strips from unclosed <internal> to EOF', () => {
    expect(stripInternalTags('hello <internal>secret')).toBe('hello');
  });

  it('strips entire text when it starts with unclosed <internal>', () => {
    expect(stripInternalTags('<internal>secret')).toBe('');
  });

  it('removes stray invoke tags', () => {
    expect(stripInternalTags('hello </invoke> world')).toBe('hello  world');
  });
});

describe('normalizeSlackMarkdown', () => {
  it('converts double asterisks to single', () => {
    expect(normalizeSlackMarkdown('**bold**')).toBe('*bold*');
  });

  it('converts multiple double-asterisk spans', () => {
    expect(normalizeSlackMarkdown('**a** and **b**')).toBe('*a* and *b*');
  });

  it('leaves single asterisks unchanged', () => {
    expect(normalizeSlackMarkdown('*already bold*')).toBe('*already bold*');
  });

  it('converts markdown headings to bold text', () => {
    expect(normalizeSlackMarkdown('## Heading')).toBe('*Heading*');
  });

  it('converts h1 through h6', () => {
    expect(normalizeSlackMarkdown('# H1')).toBe('*H1*');
    expect(normalizeSlackMarkdown('### H3')).toBe('*H3*');
    expect(normalizeSlackMarkdown('###### H6')).toBe('*H6*');
  });

  it('only converts headings at line start', () => {
    expect(normalizeSlackMarkdown('text ## not heading')).toBe('text ## not heading');
  });

  it('converts markdown links to text (url)', () => {
    expect(normalizeSlackMarkdown('[Click here](https://example.com)')).toBe(
      'Click here (https://example.com)',
    );
  });

  it('handles multiple links in one line', () => {
    expect(
      normalizeSlackMarkdown('[a](http://a.com) and [b](http://b.com)'),
    ).toBe('a (http://a.com) and b (http://b.com)');
  });

  it('handles mixed formatting', () => {
    const input = '## Title\n**bold** and [link](http://x.com)';
    const expected = '*Title*\n*bold* and link (http://x.com)';
    expect(normalizeSlackMarkdown(input)).toBe(expected);
  });

  it('passes through plain text unchanged', () => {
    expect(normalizeSlackMarkdown('plain text')).toBe('plain text');
  });
});

describe('formatOutbound', () => {
  it('returns text with internal tags stripped', () => {
    expect(formatOutbound('hello world')).toBe('hello world');
  });

  it('returns empty string when all text is internal', () => {
    expect(formatOutbound('<internal>hidden</internal>')).toBe('');
  });

  it('strips internal tags from remaining text', () => {
    expect(
      formatOutbound('<internal>thinking</internal>The answer is 42'),
    ).toBe('The answer is 42');
  });

  it('returns only safe prefix for unclosed internal tags', () => {
    expect(formatOutbound('A <internal>hidden')).toBe('A');
  });

  it('normalizes Slack markdown in output', () => {
    expect(formatOutbound('**bold** text')).toBe('*bold* text');
  });

  it('normalizes headings in output', () => {
    expect(formatOutbound('## Title')).toBe('*Title*');
  });

  it('normalizes links in output', () => {
    expect(formatOutbound('[link](http://x.com)')).toBe('link (http://x.com)');
  });
});

// --- Gateway evaluation (replaces TRIGGER_PATTERN tests) ---

describe('gateway evaluation (replaces trigger gating)', () => {
  it('self_mention agent: processes when alias present', () => {
    const agent = makeAgent();
    const msg = makeMsg({ content: `${ASSISTANT_NAME.toLowerCase()} do something` });
    expect(evaluateGateway(msg, agent, 'slack:C12345678')).toBe(true);
  });

  it('self_mention agent: does not process without alias', () => {
    const agent = makeAgent();
    const msg = makeMsg({ content: 'hello no trigger' });
    expect(evaluateGateway(msg, agent, 'slack:C12345678')).toBe(false);
  });

  it('any_message agent: always processes', () => {
    const agent = makeAgent({
      gateway: { rules: [{ match: 'any_message' }] },
    });
    const msg = makeMsg({ content: 'hello no trigger' });
    expect(evaluateGateway(msg, agent, 'slack:C12345678')).toBe(true);
  });

  it('channel-scoped any_message: only processes in matching channel', () => {
    const agent = makeAgent({
      gateway: { rules: [{ channel: ['slack:C111'], match: 'any_message' }] },
    });
    expect(evaluateGateway(makeMsg({ content: 'hello' }), agent, 'slack:C111')).toBe(true);
    expect(evaluateGateway(makeMsg({ content: 'hello' }), agent, 'slack:C222')).toBe(false);
  });

  it('excludes bot messages by default', () => {
    const agent = makeAgent({
      gateway: { rules: [{ match: 'any_message' }] },
    });
    const botMsg = makeMsg({ is_bot_message: true });
    expect(evaluateGateway(botMsg, agent, 'slack:C12345678')).toBe(false);
  });
});
