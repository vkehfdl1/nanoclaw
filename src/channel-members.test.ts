import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RegisteredGroup } from './types.js';

const { getAgentsByChannelMock } = vi.hoisted(() => ({
  getAgentsByChannelMock: vi.fn(),
}));

vi.mock('./db.js', () => ({
  getAgentsByChannel: getAgentsByChannelMock,
}));

import {
  buildChannelMembersPreamble,
  getChannelMembers,
  prependChannelMembersToPrompt,
  resetChannelMembersCache,
} from './channel-members.js';

function makeAgent(overrides: Partial<RegisteredGroup> = {}): RegisteredGroup {
  return {
    name: 'Agent',
    folder: 'agent',
    trigger: '@agent',
    aliases: ['agent'],
    added_at: '2026-03-02T00:00:00.000Z',
    gateway: { rules: [{ match: 'self_mention' }] },
    role: 'pm-agent',
    ...overrides,
  };
}

function makeFetchResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

describe('channel members', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-02T12:00:00.000Z'));
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    getAgentsByChannelMock.mockReset();
    resetChannelMembersCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('getChannelMembers returns Slack members and registered agents with optional role', async () => {
    getAgentsByChannelMock.mockReturnValue([
      makeAgent({
        name: 'Young-gu',
        folder: 'pm-autorag',
        trigger: '@young-gu',
        aliases: ['young-gu'],
        role: 'pm-agent',
      }),
    ]);

    fetchMock
      .mockResolvedValueOnce(
        makeFetchResponse({ ok: true, members: ['U_ALICE', 'U_BUILD_BOT'] }),
      )
      .mockResolvedValueOnce(
        makeFetchResponse({
          ok: true,
          user: {
            id: 'U_ALICE',
            is_bot: false,
            profile: { display_name: 'Alice' },
            real_name: 'Alice Doe',
            name: 'alice',
          },
        }),
      )
      .mockResolvedValueOnce(
        makeFetchResponse({
          ok: true,
          user: {
            id: 'U_BUILD_BOT',
            is_bot: true,
            profile: { display_name: '' },
            real_name: '',
            name: 'build-bot',
          },
        }),
      );

    const members = await getChannelMembers('C111', 'xoxb-test-token');

    expect(members).toEqual(
      expect.arrayContaining([
        { userId: 'U_ALICE', displayName: 'Alice', isBot: false },
        { userId: 'U_BUILD_BOT', displayName: 'build-bot', isBot: true },
        {
          userId: '@young-gu',
          displayName: 'Young-gu',
          isBot: true,
          agentRole: 'pm-agent',
        },
      ]),
    );
    expect(getAgentsByChannelMock).toHaveBeenCalledWith('slack:C111');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('caches members by channel for 5 minutes', async () => {
    getAgentsByChannelMock.mockReturnValue([]);

    fetchMock
      .mockResolvedValueOnce(
        makeFetchResponse({ ok: true, members: ['U1'] }),
      )
      .mockResolvedValueOnce(
        makeFetchResponse({
          ok: true,
          user: {
            id: 'U1',
            is_bot: false,
            profile: { display_name: 'Alice' },
            real_name: '',
            name: 'alice',
          },
        }),
      );

    const first = await getChannelMembers('C_CACHE', 'xoxb-test-token');
    const second = await getChannelMembers('C_CACHE', 'xoxb-test-token');

    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.setSystemTime(new Date('2026-03-02T12:05:01.000Z'));

    fetchMock
      .mockResolvedValueOnce(
        makeFetchResponse({ ok: true, members: ['U1'] }),
      )
      .mockResolvedValueOnce(
        makeFetchResponse({
          ok: true,
          user: {
            id: 'U1',
            is_bot: false,
            profile: { display_name: 'Alice' },
            real_name: '',
            name: 'alice',
          },
        }),
      );

    await getChannelMembers('C_CACHE', 'xoxb-test-token');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('buildChannelMembersPreamble lists human/agent roles and mention identifiers', () => {
    const preamble = buildChannelMembersPreamble([
      { userId: 'U_ALICE', displayName: 'Alice', isBot: false },
      {
        userId: '@marketer',
        displayName: 'Marketer',
        isBot: true,
        agentRole: 'marketer',
      },
    ]);

    expect(preamble).toContain('[Channel members]');
    expect(preamble).toContain('- Alice (human, mention: <@U_ALICE>)');
    expect(preamble).toContain('- Marketer (agent: marketer, mention: @marketer)');
  });

  it('prependChannelMembersToPrompt uses the source channel when agent is in multiple channels', async () => {
    getAgentsByChannelMock.mockImplementation((jid: string) => {
      if (jid === 'slack:C111') {
        return [makeAgent({ name: 'Young-gu', folder: 'pm-autorag', trigger: '@young-gu', aliases: ['young-gu'], role: 'pm-agent' })];
      }
      if (jid === 'slack:C222') {
        return [makeAgent({ name: 'Marketer', folder: 'marketer', trigger: '@marketer', aliases: ['marketer'], role: 'marketer' })];
      }
      return [];
    });

    fetchMock
      .mockResolvedValueOnce(makeFetchResponse({ ok: true, members: ['U_ALICE'] }))
      .mockResolvedValueOnce(
        makeFetchResponse({
          ok: true,
          user: {
            id: 'U_ALICE',
            is_bot: false,
            profile: { display_name: 'Alice' },
            real_name: '',
            name: 'alice',
          },
        }),
      )
      .mockResolvedValueOnce(makeFetchResponse({ ok: true, members: ['U_BOB'] }))
      .mockResolvedValueOnce(
        makeFetchResponse({
          ok: true,
          user: {
            id: 'U_BOB',
            is_bot: false,
            profile: { display_name: 'Bob' },
            real_name: '',
            name: 'bob',
          },
        }),
      );

    const basePrompt = '<messages>\n<message>hi</message>\n</messages>';
    const promptC111 = await prependChannelMembersToPrompt(
      'slack:C111',
      basePrompt,
      'xoxb-test-token',
    );
    const promptC222 = await prependChannelMembersToPrompt(
      'slack:C222',
      basePrompt,
      'xoxb-test-token',
    );

    expect(promptC111).toContain('Alice');
    expect(promptC111).not.toContain('Bob');
    expect(promptC111).toContain('@young-gu');

    expect(promptC222).toContain('Bob');
    expect(promptC222).not.toContain('Alice');
    expect(promptC222).toContain('@marketer');
  });
});
