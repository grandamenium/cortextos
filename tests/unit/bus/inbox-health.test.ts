import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { checkInboxHealth } from '../../../src/bus/message';

const DEAD_PID = 2147483647;

describe('checkInboxHealth (Fix C — inbox/lock health monitor)', () => {
  let ctxRoot: string;
  const inboxDir = (agent: string) => join(ctxRoot, 'inbox', agent);

  beforeEach(() => {
    ctxRoot = mkdtempSync(join(tmpdir(), 'cortextos-health-'));
  });
  afterEach(() => {
    rmSync(ctxRoot, { recursive: true, force: true });
  });

  function makeInbox(agent: string): string {
    const d = inboxDir(agent);
    mkdirSync(d, { recursive: true });
    return d;
  }
  function addMessages(agent: string, n: number): void {
    const d = inboxDir(agent);
    for (let i = 0; i < n; i++) writeFileSync(join(d, `0-${1000 + i}-from-x.json`), '{}');
  }

  it('healthy inbox → no warnings, lock=none', () => {
    makeInbox('alpha');
    addMessages('alpha', 3);
    const [row] = checkInboxHealth(ctxRoot, { agent: 'alpha' });
    expect(row.depth).toBe(3);
    expect(row.lock).toBe('none');
    expect(row.warnings).toEqual([]);
  });

  it('deep inbox → depth warning', () => {
    makeInbox('beta');
    addMessages('beta', 25);
    const [row] = checkInboxHealth(ctxRoot, { agent: 'beta', depthWarn: 20 });
    expect(row.depth).toBe(25);
    expect(row.warnings.some(w => /depth 25 > 20/.test(w))).toBe(true);
  });

  it('classifies lock states: dead / corrupt / pid-less → stale warning', () => {
    for (const [agent, content] of [['d', String(DEAD_PID)], ['c', 'garbage'], ['e', '']] as const) {
      const d = makeInbox(agent);
      writeFileSync(join(d, '.lock'), content);
    }
    const dead = checkInboxHealth(ctxRoot, { agent: 'd' })[0];
    const corrupt = checkInboxHealth(ctxRoot, { agent: 'c' })[0];
    const empty = checkInboxHealth(ctxRoot, { agent: 'e' })[0];
    expect(dead.lock).toBe('pid_dead');
    expect(corrupt.lock).toBe('pid_corrupt');
    expect(empty.lock).toBe('pid_missing');
    for (const r of [dead, corrupt, empty]) {
      expect(r.warnings.some(w => /stale lock/.test(w))).toBe(true);
    }
  });

  it('a live-pid lock is healthy (no stale warning) when freshly held', () => {
    const d = makeInbox('live');
    writeFileSync(join(d, '.lock'), String(process.pid));
    const [row] = checkInboxHealth(ctxRoot, { agent: 'live' });
    expect(row.lock).toBe('pid_alive');
    expect(row.warnings).toEqual([]);
  });

  it('flags a leftover legacy .lock.d directory', () => {
    const d = makeInbox('legacy');
    mkdirSync(join(d, '.lock.d'));
    const [row] = checkInboxHealth(ctxRoot, { agent: 'legacy' });
    expect(row.legacyLockDir).toBe(true);
    expect(row.warnings.some(w => /legacy \.lock\.d/.test(w))).toBe(true);
  });

  it('scans all agents when no agent specified', () => {
    makeInbox('a1'); makeInbox('a2'); makeInbox('a3');
    const rows = checkInboxHealth(ctxRoot, {});
    expect(rows.map(r => r.agent).sort()).toEqual(['a1', 'a2', 'a3']);
  });
});
