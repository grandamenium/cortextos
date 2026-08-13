import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { dispatchSlackMessage, makeUserNameResolver, type DispatchTarget } from '../../../src/slack/dispatcher';
import type { SlackSocketMessageEvent } from '../../../src/slack/socket-mode';
import { FastChecker } from '../../../src/daemon/fast-checker';

// A minimal fake standing in for FastChecker — the dispatcher only calls
// isDuplicate() and queueSlackMessage() on its targets, so a real FastChecker
// (which needs a real AgentProcess + BusPaths) would be unnecessary
// machinery for testing pure routing logic.
class FakeChecker {
  queued: string[] = [];
  private seen = new Set<string>();
  isDuplicate(text: string): boolean {
    if (this.seen.has(text)) return true;
    this.seen.add(text);
    return false;
  }
  queueSlackMessage(formatted: string): void {
    this.queued.push(formatted);
  }
}

function makeAgent(root: string, name: string, slackJson: object): void {
  const dir = join(root, 'orgs', 'wyre', 'agents', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'slack.json'), JSON.stringify(slackJson));
}

const noopResolver = async (userId: string) => `name-${userId}`;

describe('dispatchSlackMessage', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sp3b-dispatch-'));
  });

  const baseEvent: SlackSocketMessageEvent = {
    type: 'message',
    team: 'T1',
    channel: 'C1',
    user: 'U1',
    text: 'hello',
    ts: '1.1',
  };

  it('delivers to a single agent whose slack.json matches both channel and user', async () => {
    makeAgent(root, 'boss', {
      display_name: 'boss', channels: {}, allowed_channels: ['C1'], allowed_users: ['T1:U1'],
    });
    const checker = new FakeChecker();
    const targets: DispatchTarget[] = [{ name: 'boss', checker: checker as unknown as FastChecker }];

    const result = await dispatchSlackMessage(baseEvent, targets, root, 'wyre', noopResolver);

    expect(result.delivered).toEqual(['boss']);
    expect(checker.queued).toHaveLength(1);
    expect(checker.queued[0]).toContain('=== SLACK from [USER: name-U1] (channel:C1) ===');
  });

  it('delivers to ALL matching agents when multiple agents watch the same channel (N:1)', async () => {
    makeAgent(root, 'boss', { display_name: 'boss', channels: {}, allowed_channels: ['C1'], allowed_users: ['T1:U1'] });
    makeAgent(root, 'dev', { display_name: 'dev', channels: {}, allowed_channels: ['C1'], allowed_users: ['T1:U1'] });
    const bossChecker = new FakeChecker();
    const devChecker = new FakeChecker();
    const targets: DispatchTarget[] = [
      { name: 'boss', checker: bossChecker as unknown as FastChecker },
      { name: 'dev', checker: devChecker as unknown as FastChecker },
    ];

    const result = await dispatchSlackMessage(baseEvent, targets, root, 'wyre', noopResolver);

    expect(result.delivered.sort()).toEqual(['boss', 'dev']);
    expect(bossChecker.queued).toHaveLength(1);
    expect(devChecker.queued).toHaveLength(1);
  });

  it('skips an agent whose slack.json does not include the channel', async () => {
    makeAgent(root, 'boss', { display_name: 'boss', channels: {}, allowed_channels: ['C-OTHER'], allowed_users: ['T1:U1'] });
    const checker = new FakeChecker();
    const targets: DispatchTarget[] = [{ name: 'boss', checker: checker as unknown as FastChecker }];

    const result = await dispatchSlackMessage(baseEvent, targets, root, 'wyre', noopResolver);

    expect(result.delivered).toEqual([]);
    expect(result.skippedNoChannelMatch).toBe(true);
    expect(checker.queued).toHaveLength(0);
  });

  it('fail-closed: skips an agent whose channel matches but user is NOT in allowed_users', async () => {
    makeAgent(root, 'boss', { display_name: 'boss', channels: {}, allowed_channels: ['C1'], allowed_users: ['T1:U-SOMEONE-ELSE'] });
    const checker = new FakeChecker();
    const targets: DispatchTarget[] = [{ name: 'boss', checker: checker as unknown as FastChecker }];

    const result = await dispatchSlackMessage(baseEvent, targets, root, 'wyre', noopResolver);

    expect(result.delivered).toEqual([]);
    expect(result.skippedUserNotAllowed).toEqual(['boss']);
    expect(checker.queued).toHaveLength(0);
  });

  it('fail-closed: the SAME user_id from a DIFFERENT team is rejected (composite key)', async () => {
    makeAgent(root, 'boss', { display_name: 'boss', channels: {}, allowed_channels: ['C1'], allowed_users: ['T-DIFFERENT:U1'] });
    const checker = new FakeChecker();
    const targets: DispatchTarget[] = [{ name: 'boss', checker: checker as unknown as FastChecker }];

    // baseEvent.team is 'T1', not 'T-DIFFERENT' — same user id, wrong workspace.
    const result = await dispatchSlackMessage(baseEvent, targets, root, 'wyre', noopResolver);

    expect(result.delivered).toEqual([]);
    expect(result.skippedUserNotAllowed).toEqual(['boss']);
  });

  it('respects per-agent dedup — the same event queued twice for one agent is queued once', async () => {
    makeAgent(root, 'boss', { display_name: 'boss', channels: {}, allowed_channels: ['C1'], allowed_users: ['T1:U1'] });
    const checker = new FakeChecker();
    const targets: DispatchTarget[] = [{ name: 'boss', checker: checker as unknown as FastChecker }];

    await dispatchSlackMessage(baseEvent, targets, root, 'wyre', noopResolver);
    const second = await dispatchSlackMessage(baseEvent, targets, root, 'wyre', noopResolver);

    expect(checker.queued).toHaveLength(1);
    expect(second.delivered).toEqual([]); // deduped, not "delivered" a second time
  });

  it('skips an agent with no slack.json entirely', async () => {
    // no makeAgent() call for 'dev' — no slack.json on disk
    const checker = new FakeChecker();
    const targets: DispatchTarget[] = [{ name: 'dev', checker: checker as unknown as FastChecker }];

    const result = await dispatchSlackMessage(baseEvent, targets, root, 'wyre', noopResolver);

    expect(result.delivered).toEqual([]);
    expect(checker.queued).toHaveLength(0);
  });
});

describe('makeUserNameResolver', () => {
  it('resolves and caches a user name, calling the underlying fetch only once', async () => {
    let calls = 0;
    const resolver = makeUserNameResolver(async (userId) => {
      calls++;
      return { real_name: `Real ${userId}` };
    });

    const first = await resolver('U1');
    const second = await resolver('U1');

    expect(first).toBe('Real U1');
    expect(second).toBe('Real U1');
    expect(calls).toBe(1);
  });

  it('falls back to name when real_name is absent', async () => {
    const resolver = makeUserNameResolver(async () => ({ name: 'shortname' }));
    expect(await resolver('U1')).toBe('shortname');
  });

  it('falls back to the raw user id when the lookup throws', async () => {
    const resolver = makeUserNameResolver(async () => {
      throw new Error('users.info failed');
    });
    expect(await resolver('U1')).toBe('U1');
  });

  it('falls back to the raw user id when the lookup returns null', async () => {
    const resolver = makeUserNameResolver(async () => null);
    expect(await resolver('U1')).toBe('U1');
  });
});
