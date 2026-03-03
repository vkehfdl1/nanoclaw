import { describe, it, expect } from 'vitest';

import { matchesAlias, evaluateRule, evaluateGateway } from './gateway.js';
import { AgentGateway, GatewayRule, NewMessage, RegisteredGroup } from './types.js';

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
    name: 'Dobby',
    folder: 'main',
    trigger: '@Dobby',
    aliases: ['dobby', '도비'],
    added_at: '2024-01-01T00:00:00.000Z',
    gateway: { rules: [{ match: 'self_mention' }] },
    ...overrides,
  };
}

// --- matchesAlias ---

describe('matchesAlias', () => {
  it('matches case-insensitively', () => {
    expect(matchesAlias('Hello Dobby', ['dobby'])).toBe(true);
    expect(matchesAlias('hello DOBBY', ['dobby'])).toBe(true);
  });

  it('matches Korean aliases via substring', () => {
    expect(matchesAlias('도비 안녕', ['도비'])).toBe(true);
  });

  it('returns false when no alias matches', () => {
    expect(matchesAlias('hello world', ['dobby', '도비'])).toBe(false);
  });

  it('matches any alias in the array (OR)', () => {
    expect(matchesAlias('도비야', ['dobby', '도비'])).toBe(true);
    expect(matchesAlias('hey dobby', ['dobby', '도비'])).toBe(true);
  });

  it('handles empty aliases array', () => {
    expect(matchesAlias('hello', [])).toBe(false);
  });

  it('matches as substring (not just word boundary)', () => {
    expect(matchesAlias('marketer-channel', ['marketer'])).toBe(true);
  });
});

// --- evaluateRule ---

describe('evaluateRule', () => {
  const agent = makeAgent();

  it('self_mention passes when alias is in content', () => {
    const rule: GatewayRule = { match: 'self_mention' };
    const msg = makeMsg({ content: '도비 안녕' });
    expect(evaluateRule(rule, msg, agent, 'slack:C12345678')).toBe(true);
  });

  it('self_mention fails when alias is not in content', () => {
    const rule: GatewayRule = { match: 'self_mention' };
    const msg = makeMsg({ content: 'hello world' });
    expect(evaluateRule(rule, msg, agent, 'slack:C12345678')).toBe(false);
  });

  it('any_message always passes', () => {
    const rule: GatewayRule = { match: 'any_message' };
    const msg = makeMsg({ content: 'random message' });
    expect(evaluateRule(rule, msg, agent, 'slack:C12345678')).toBe(true);
  });

  it('channel filter restricts to listed channels', () => {
    const rule: GatewayRule = { channel: ['slack:C111'], match: 'any_message' };
    expect(evaluateRule(rule, makeMsg(), agent, 'slack:C111')).toBe(true);
    expect(evaluateRule(rule, makeMsg(), agent, 'slack:C222')).toBe(false);
  });

  it('cross_agent passes for cross-agent messages', () => {
    const rule: GatewayRule = { match: 'cross_agent', fromAgents: ['main'] };
    const msg = makeMsg({
      is_cross_agent: true,
      agent_source: 'main',
    });
    expect(evaluateRule(rule, msg, agent, 'slack:C12345678')).toBe(true);
  });

  it('cross_agent fails for non-cross-agent messages', () => {
    const rule: GatewayRule = { match: 'cross_agent' };
    const msg = makeMsg();
    expect(evaluateRule(rule, msg, agent, 'slack:C12345678')).toBe(false);
  });

  it('cross_agent with fromAgents filters by source agent', () => {
    const rule: GatewayRule = { match: 'cross_agent', fromAgents: ['marketer'] };
    const msg = makeMsg({
      is_cross_agent: true,
      agent_source: 'main',
    });
    expect(evaluateRule(rule, msg, agent, 'slack:C12345678')).toBe(false);
  });

  it('keywords filter requires at least one keyword present', () => {
    const rule: GatewayRule = { keywords: ['urgent', 'deploy'] };
    expect(evaluateRule(rule, makeMsg({ content: 'urgent fix needed' }), agent, 'slack:C12345678')).toBe(true);
    expect(evaluateRule(rule, makeMsg({ content: 'hello world' }), agent, 'slack:C12345678')).toBe(false);
  });

  it('channel AND match AND keywords are all ANDed', () => {
    const rule: GatewayRule = {
      channel: ['slack:C111'],
      match: 'self_mention',
      keywords: ['help'],
    };
    // All conditions met
    expect(evaluateRule(rule, makeMsg({ content: 'dobby help me' }), agent, 'slack:C111')).toBe(true);
    // Wrong channel
    expect(evaluateRule(rule, makeMsg({ content: 'dobby help me' }), agent, 'slack:C222')).toBe(false);
    // No alias
    expect(evaluateRule(rule, makeMsg({ content: 'help me' }), agent, 'slack:C111')).toBe(false);
    // No keyword
    expect(evaluateRule(rule, makeMsg({ content: 'dobby hi' }), agent, 'slack:C111')).toBe(false);
  });

  it('rule with no fields matches everything', () => {
    const rule: GatewayRule = {};
    expect(evaluateRule(rule, makeMsg(), agent, 'slack:C12345678')).toBe(true);
  });
});

// --- evaluateGateway ---

describe('evaluateGateway', () => {
  it('OR across rules: any matching rule triggers', () => {
    const agent = makeAgent({
      gateway: {
        rules: [
          { channel: ['slack:C111'], match: 'any_message' },
          { match: 'self_mention' },
        ],
      },
    });

    // Matches rule 1 (channel + any_message)
    expect(evaluateGateway(makeMsg(), agent, 'slack:C111')).toBe(true);
    // Matches rule 2 (self_mention, different channel)
    expect(evaluateGateway(makeMsg({ content: '도비 안녕' }), agent, 'slack:C999')).toBe(true);
    // Matches neither
    expect(evaluateGateway(makeMsg({ content: 'hello' }), agent, 'slack:C999')).toBe(false);
  });

  it('excludes bot messages by default', () => {
    const agent = makeAgent({
      gateway: { rules: [{ match: 'any_message' }] },
    });
    const botMsg = makeMsg({ is_bot_message: true });
    expect(evaluateGateway(botMsg, agent, 'slack:C12345678')).toBe(false);
  });

  it('allows cross-agent bot messages through', () => {
    const agent = makeAgent({
      gateway: { rules: [{ match: 'cross_agent' }] },
    });
    const crossMsg = makeMsg({
      is_bot_message: true,
      is_cross_agent: true,
      agent_source: 'marketer',
    });
    expect(evaluateGateway(crossMsg, agent, 'slack:C12345678')).toBe(true);
  });

  it('allows bot messages when excludeBotMessages is false', () => {
    const agent = makeAgent({
      gateway: { rules: [{ match: 'any_message' }], excludeBotMessages: false },
    });
    const botMsg = makeMsg({ is_bot_message: true });
    expect(evaluateGateway(botMsg, agent, 'slack:C12345678')).toBe(true);
  });

  it('returns false for empty rules', () => {
    const agent = makeAgent({ gateway: { rules: [] } });
    expect(evaluateGateway(makeMsg(), agent, 'slack:C12345678')).toBe(false);
  });

  // --- Real agent config scenarios ---

  describe('real agent configs', () => {
    it('main agent (Dobby): responds to self_mention', () => {
      const dobby = makeAgent({
        aliases: ['dobby', '도비'],
        gateway: { rules: [{ match: 'self_mention' }] },
      });

      expect(evaluateGateway(makeMsg({ content: '도비 안녕' }), dobby, 'slack:C0AH91957U0')).toBe(true);
      expect(evaluateGateway(makeMsg({ content: 'just chatting' }), dobby, 'slack:C0AH91957U0')).toBe(false);
    });

    it('pm-autorag: responds to self_mention and cross_agent from main only', () => {
      const pm = makeAgent({
        name: 'Young-gu',
        folder: 'pm-autorag',
        aliases: ['young-gu', '영구'],
        gateway: {
          rules: [
            { match: 'self_mention' },
            { match: 'cross_agent', fromAgents: ['main'] },
          ],
        },
      });

      // In its channel: needs mention (no more any_message)
      expect(evaluateGateway(makeMsg({ content: 'hello' }), pm, 'slack:C09RELR4R9N')).toBe(false);
      expect(evaluateGateway(makeMsg({ content: '영구야 이거 봐봐' }), pm, 'slack:C09RELR4R9N')).toBe(true);
      // Outside: needs mention
      expect(evaluateGateway(makeMsg({ content: 'hello' }), pm, 'slack:C0AH91957U0')).toBe(false);
      expect(evaluateGateway(makeMsg({ content: '영구야 이거 봐봐' }), pm, 'slack:C0AH91957U0')).toBe(true);
      // Cross-agent from main
      expect(evaluateGateway(
        makeMsg({ is_cross_agent: true, agent_source: 'main' }),
        pm,
        'slack:C0AH91957U0',
      )).toBe(true);
      // Cross-agent from marketer (not in fromAgents)
      expect(evaluateGateway(
        makeMsg({ is_cross_agent: true, agent_source: 'marketer' }),
        pm,
        'slack:C0AH91957U0',
      )).toBe(false);
    });

    it('marketer: responds to any_message in its channel, self_mention elsewhere', () => {
      const marketer = makeAgent({
        name: 'Marketer',
        folder: 'marketer',
        aliases: ['marketer', '마케터'],
        gateway: {
          rules: [
            { channel: ['slack:C0AJ9U1DB25'], match: 'any_message' },
            { match: 'self_mention' },
          ],
        },
      });

      expect(evaluateGateway(makeMsg({ content: 'hello' }), marketer, 'slack:C0AJ9U1DB25')).toBe(true);
      expect(evaluateGateway(makeMsg({ content: 'hello' }), marketer, 'slack:C999')).toBe(false);
      expect(evaluateGateway(makeMsg({ content: '마케터 도와줘' }), marketer, 'slack:C999')).toBe(true);
    });

    it('todomon: responds to any_message in its channel, self_mention elsewhere', () => {
      const todomon = makeAgent({
        name: 'Todomon',
        folder: 'todomon',
        aliases: ['todomon', '투두몬'],
        gateway: {
          rules: [
            { channel: ['slack:C0AH3SVQL4C'], match: 'any_message' },
            { match: 'self_mention' },
          ],
        },
      });

      expect(evaluateGateway(makeMsg({ content: 'add task' }), todomon, 'slack:C0AH3SVQL4C')).toBe(true);
      expect(evaluateGateway(makeMsg({ content: '투두몬 할일 추가' }), todomon, 'slack:C999')).toBe(true);
    });

    it('main in marketer channel: only responds to self_mention', () => {
      const dobbyInMarketer = makeAgent({
        aliases: ['dobby', '도비'],
        gateway: { rules: [{ match: 'self_mention' }] },
      });

      expect(evaluateGateway(makeMsg({ content: '도비 도와줘' }), dobbyInMarketer, 'slack:C0AJ9U1DB25')).toBe(true);
      expect(evaluateGateway(makeMsg({ content: 'random message' }), dobbyInMarketer, 'slack:C0AJ9U1DB25')).toBe(false);
    });
  });
});
