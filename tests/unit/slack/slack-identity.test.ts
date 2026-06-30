import { describe, it, expect, vi } from 'vitest';
import {
  resolveSlackIdentity,
  evaluateSlackTrust,
  formatSlackOriginator,
  type SlackIdentity,
  type SlackUserInfoFetcher,
} from '../../../src/slack/slack-identity.js';
import type { TeamMember } from '../../../src/types/index.js';

const TEAM: TeamMember[] = [
  { name: 'Jordan Lee', role: 'Operations Manager', slack_handle: 'jordan.lee', trust_level: 'manager' },
  { name: 'David Owner', role: 'Owner', slack_handle: '@David.Owner', trust_level: 'owner' },
];

describe('resolveSlackIdentity', () => {
  it('cache miss calls fetch and populates the cache', async () => {
    const fetch: SlackUserInfoFetcher = vi
      .fn()
      .mockResolvedValue({ handle: 'jordan.lee', displayName: 'Jordan Lee' });
    const cache = new Map<string, { handle: string | null; displayName: string }>();

    const id = await resolveSlackIdentity('U1', fetch, TEAM, cache);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(cache.get('U1')).toEqual({ handle: 'jordan.lee', displayName: 'Jordan Lee' });
    expect(id).toEqual({
      userId: 'U1',
      handle: 'jordan.lee',
      displayName: 'Jordan Lee',
      trustLevel: 'manager',
    });
  });

  it('cache hit does NOT call fetch', async () => {
    const fetch = vi.fn() as unknown as SlackUserInfoFetcher;
    const cache = new Map([['U1', { handle: 'jordan.lee', displayName: 'Jordan Lee' }]]);

    const id = await resolveSlackIdentity('U1', fetch, TEAM, cache);

    expect(fetch).not.toHaveBeenCalled();
    expect(id.handle).toBe('jordan.lee');
    expect(id.trustLevel).toBe('manager');
  });

  it('resolves trustLevel from team_members case-insensitively', async () => {
    const fetch: SlackUserInfoFetcher = vi
      .fn()
      .mockResolvedValue({ handle: 'JORDAN.LEE', displayName: 'Jordan Lee' });
    const id = await resolveSlackIdentity('U1', fetch, TEAM, new Map());
    expect(id.trustLevel).toBe('manager');
  });

  it('resolves trustLevel tolerating a leading @ on either side', async () => {
    // member stored as '@David.Owner', fetched handle has no @ and different case
    const fetch: SlackUserInfoFetcher = vi
      .fn()
      .mockResolvedValue({ handle: 'david.owner', displayName: 'David Owner' });
    const id = await resolveSlackIdentity('U2', fetch, TEAM, new Map());
    expect(id.trustLevel).toBe('owner');
  });

  it('unknown member -> trustLevel null', async () => {
    const fetch: SlackUserInfoFetcher = vi
      .fn()
      .mockResolvedValue({ handle: 'stranger', displayName: 'Some Stranger' });
    const id = await resolveSlackIdentity('U9', fetch, TEAM, new Map());
    expect(id.trustLevel).toBeNull();
    expect(id.handle).toBe('stranger');
  });

  it('teamMembers undefined -> trustLevel null', async () => {
    const fetch: SlackUserInfoFetcher = vi
      .fn()
      .mockResolvedValue({ handle: 'jordan.lee', displayName: 'Jordan Lee' });
    const id = await resolveSlackIdentity('U1', fetch, undefined, new Map());
    expect(id.trustLevel).toBeNull();
  });

  it('fetch returns null -> handle null, displayName=userId, trustLevel null, NOT cached', async () => {
    const fetch: SlackUserInfoFetcher = vi.fn().mockResolvedValue(null);
    const cache = new Map<string, { handle: string | null; displayName: string }>();

    const id = await resolveSlackIdentity('U7', fetch, TEAM, cache);

    expect(id).toEqual({ userId: 'U7', handle: null, displayName: 'U7', trustLevel: null });
    // failures retry: nothing cached
    expect(cache.has('U7')).toBe(false);
  });

  it('displayName falls back to handle, then userId', async () => {
    const fetchHandle: SlackUserInfoFetcher = vi
      .fn()
      .mockResolvedValue({ handle: 'just.handle', displayName: '' });
    const idHandle = await resolveSlackIdentity('U3', fetchHandle, undefined, new Map());
    expect(idHandle.displayName).toBe('just.handle');

    const fetchNothing: SlackUserInfoFetcher = vi
      .fn()
      .mockResolvedValue({ handle: null, displayName: '' });
    const idNothing = await resolveSlackIdentity('U4', fetchNothing, undefined, new Map());
    expect(idNothing.displayName).toBe('U4');
  });
});

describe('evaluateSlackTrust', () => {
  it('unconfigured (undefined) -> allowed + openWarning (loudly open)', () => {
    expect(evaluateSlackTrust('anyone', undefined)).toEqual({ allowed: true, openWarning: true });
  });

  it('unconfigured (empty array) -> allowed + openWarning', () => {
    expect(evaluateSlackTrust('anyone', [])).toEqual({ allowed: true, openWarning: true });
  });

  it('configured + handle in list -> allowed, no warning', () => {
    expect(evaluateSlackTrust('jordan.lee', ['jordan.lee'])).toEqual({
      allowed: true,
      openWarning: false,
    });
  });

  it('configured + handle NOT in list -> blocked (fail-closed)', () => {
    expect(evaluateSlackTrust('stranger', ['jordan.lee'])).toEqual({
      allowed: false,
      openWarning: false,
    });
  });

  it('configured + handle null -> blocked', () => {
    expect(evaluateSlackTrust(null, ['jordan.lee'])).toEqual({
      allowed: false,
      openWarning: false,
    });
  });

  it('matches case-insensitively', () => {
    expect(evaluateSlackTrust('Jordan.Lee', ['jordan.lee']).allowed).toBe(true);
    expect(evaluateSlackTrust('jordan.lee', ['JORDAN.LEE']).allowed).toBe(true);
  });

  it('tolerates a leading @ on either side', () => {
    expect(evaluateSlackTrust('@jordan.lee', ['jordan.lee']).allowed).toBe(true);
    expect(evaluateSlackTrust('jordan.lee', ['@jordan.lee']).allowed).toBe(true);
  });
});

describe('formatSlackOriginator', () => {
  it('handle + trustLevel -> "Name (@handle, trust)"', () => {
    const id: SlackIdentity = {
      userId: 'U1',
      handle: 'jordan.lee',
      displayName: 'Jordan Lee',
      trustLevel: 'manager',
    };
    expect(formatSlackOriginator(id)).toBe('Jordan Lee (@jordan.lee, manager)');
  });

  it('handle only (no trustLevel) -> "Name (@handle)"', () => {
    const id: SlackIdentity = {
      userId: 'U1',
      handle: 'stranger',
      displayName: 'Some Stranger',
      trustLevel: null,
    };
    expect(formatSlackOriginator(id)).toBe('Some Stranger (@stranger)');
  });

  it('no handle -> displayName only', () => {
    const id: SlackIdentity = {
      userId: 'U7',
      handle: null,
      displayName: 'U7',
      trustLevel: null,
    };
    expect(formatSlackOriginator(id)).toBe('U7');
  });

  it('trustLevel is read ONLY from the identity object, not any external source', () => {
    // Two identities with identical handle/name but different trustLevel must
    // render differently — proving trust comes from identity, not the handle.
    const base = { userId: 'U1', handle: 'h', displayName: 'Name' };
    expect(formatSlackOriginator({ ...base, trustLevel: 'owner' })).toBe('Name (@h, owner)');
    expect(formatSlackOriginator({ ...base, trustLevel: null })).toBe('Name (@h)');
  });
});
