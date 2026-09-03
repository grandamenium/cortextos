/**
 * tests/unit/daemon/recovery-watchdog.test.ts
 *
 * Unit tests for the recovery watchdog: the fail-safe liveness discriminator,
 * the frozen-content trigger, and the recover() chokepoint (single-sweep dedup,
 * cross-watchdog cooldown, circuit breaker, discriminator VETO). Pure logic and
 * file-backed state under a tmp dir; `nowMs` and `seen` are injected so every
 * assertion is deterministic (mirrors dormancy.test.ts).
 *
 * Each safety-critical behavior is paired with a discriminating control: the
 * alive-idle VETO and the spawn-carry no-clear both flip if their guard inverts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  RecoveryWatchdog,
  FrozenContentTrigger,
  classifyCodexLiveness,
  classifyProcStateLiveness,
  RECOVERY_FREEZE_MS,
  RESTART_COOLDOWN_MS,
  CIRCUIT_MAX_RESTARTS,
  CIRCUIT_PAUSE_MS,
  type RecoveryManager,
  type MappedAgentSnapshot,
  type LivenessVerdict,
  type RecoveryCandidate,
} from '../../../src/daemon/recovery-watchdog';
import { BOOT_GRACE_MS } from '../../../src/utils/dormancy';
import type { Heartbeat } from '../../../src/types/index';

const NOW = 1_000_000_000_000;

// A fake manager: records restart actions, serves a scripted snapshot / verdict,
// and roots per-agent state dirs under a tmp directory.
class FakeManager implements RecoveryManager {
  snapshot: MappedAgentSnapshot[] = [];
  absent: Array<{ name: string; org?: string }> = [];
  verdict: LivenessVerdict = 'WEDGED';
  forceCalls: string[] = [];
  startCalls: string[] = [];

  constructor(private root: string) {}

  getMappedContentSnapshot(): MappedAgentSnapshot[] {
    return this.snapshot;
  }
  getAbsentDormantAgents(): Array<{ name: string; org?: string }> {
    return this.absent;
  }
  probeAgentLiveness(): LivenessVerdict {
    return this.verdict;
  }
  async forceFreshRestart(name: string): Promise<void> {
    this.forceCalls.push(name);
  }
  async startAbsent(name: string): Promise<void> {
    this.startCalls.push(name);
  }
  stateDirFor(name: string): string {
    const d = join(this.root, name);
    mkdirSync(d, { recursive: true });
    return d;
  }
}

function hb(overrides: Partial<Heartbeat>): Partial<Heartbeat> {
  return { agent: 'a', org: 'o', status: 'idle', current_task: '', mode: 'day', last_heartbeat: '2026-08-24T10:00:00Z', loop_interval: '', ...overrides };
}

let root: string;
let mgr: FakeManager;
let wd: RecoveryWatchdog;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'recovery-wd-'));
  mgr = new FakeManager(root);
  wd = new RecoveryWatchdog(mgr, () => {});
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Discriminator
// ---------------------------------------------------------------------------

describe('classifyCodexLiveness (VETO-first)', () => {
  it('alive-idle codex MUST NOT restart (socket up, pid alive, no turn) ⇒ ALIVE_IDLE', () => {
    expect(classifyCodexLiveness({ socketAlive: true, pid: 123, pidAlive: true, turnInFlight: false })).toBe('ALIVE_IDLE');
  });
  it('wedged codex MUST restart (socket down) ⇒ WEDGED', () => {
    expect(classifyCodexLiveness({ socketAlive: false, pid: 123, pidAlive: true, turnInFlight: false })).toBe('WEDGED');
  });
  it('codex child pid gone ⇒ WEDGED', () => {
    expect(classifyCodexLiveness({ socketAlive: true, pid: null, pidAlive: false, turnInFlight: false })).toBe('WEDGED');
  });
  it('codex turn in flight ⇒ UNCERTAIN (actively working, veto)', () => {
    expect(classifyCodexLiveness({ socketAlive: true, pid: 123, pidAlive: true, turnInFlight: true })).toBe('UNCERTAIN');
  });
});

describe('classifyProcStateLiveness (fail-safe ps)', () => {
  it('idle claude S MUST NOT restart ⇒ UNCERTAIN', () => {
    expect(classifyProcStateLiveness({ pid: 5, pidAlive: true, procState: 'S' })).toBe('UNCERTAIN');
  });
  it('interruptible-sleep variants (S+, Ss, I, R, D, T) ⇒ UNCERTAIN', () => {
    for (const st of ['S+', 'Ss', 'I', 'R', 'D', 'T']) {
      expect(classifyProcStateLiveness({ pid: 5, pidAlive: true, procState: st })).toBe('UNCERTAIN');
    }
  });
  it('zombie Z MUST restart ⇒ WEDGED', () => {
    expect(classifyProcStateLiveness({ pid: 5, pidAlive: true, procState: 'Z' })).toBe('WEDGED');
  });
  it('confirmed-gone pid ⇒ WEDGED', () => {
    expect(classifyProcStateLiveness({ pid: 5, pidAlive: false, procState: null })).toBe('WEDGED');
  });
  it('probe-error (ps missing / no pid) ⇒ UNCERTAIN (veto)', () => {
    expect(classifyProcStateLiveness({ pid: 5, pidAlive: true, procState: null })).toBe('UNCERTAIN');
    expect(classifyProcStateLiveness({ pid: null, pidAlive: false, procState: null })).toBe('UNCERTAIN');
  });
});

// ---------------------------------------------------------------------------
// FrozenContentTrigger
// ---------------------------------------------------------------------------

describe('FrozenContentTrigger', () => {
  const upt = BOOT_GRACE_MS + 60_000; // past boot grace

  it('healthy-changing content MUST NOT flag (freeze resets each sweep)', () => {
    const t = new FrozenContentTrigger(mgr);
    mgr.snapshot = [{ name: 'a', enabled: true, uptimeMs: upt, heartbeat: hb({ current_task: 'task 1' }) }];
    expect(t.evaluate({ nowMs: NOW })).toEqual([]);
    mgr.snapshot = [{ name: 'a', enabled: true, uptimeMs: upt, heartbeat: hb({ current_task: 'task 2' }) }];
    expect(t.evaluate({ nowMs: NOW + RECOVERY_FREEZE_MS + 1 })).toEqual([]);
  });

  it('frozen content past the window MUST flag as a force-fresh candidate', () => {
    const t = new FrozenContentTrigger(mgr);
    const frozen = hb({ status: 'working', current_task: 'stuck task' });
    mgr.snapshot = [{ name: 'a', enabled: true, uptimeMs: upt, heartbeat: frozen }];
    expect(t.evaluate({ nowMs: NOW })).toEqual([]); // first observation
    const out = t.evaluate({ nowMs: NOW + RECOVERY_FREEZE_MS + 1 });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ agent: 'a', action: 'force-fresh-restart' });
  });

  it('boot-grace MUST NOT flag: an agent under boot grace is skipped', () => {
    const t = new FrozenContentTrigger(mgr);
    const frozen = hb({ status: 'working', current_task: 'stuck' });
    mgr.snapshot = [{ name: 'a', enabled: true, uptimeMs: BOOT_GRACE_MS - 1, heartbeat: frozen }];
    t.evaluate({ nowMs: NOW });
    expect(t.evaluate({ nowMs: NOW + RECOVERY_FREEZE_MS + 1 })).toEqual([]);
  });

  it('a frozen idle-beat agent still flags (wedged agents show only daemon idle beats)', () => {
    const t = new FrozenContentTrigger(mgr);
    const idle = hb({ status: '[watchdog] a alive — idle session 2026-08-24T10:00:00Z' });
    mgr.snapshot = [{ name: 'a', enabled: true, uptimeMs: upt, heartbeat: idle }];
    expect(t.evaluate({ nowMs: NOW })).toEqual([]);
    // A later idle beat (different timestamp) normalizes identically ⇒ frozen.
    mgr.snapshot = [{ name: 'a', enabled: true, uptimeMs: upt, heartbeat: hb({ status: '[watchdog] a alive — idle session 2026-08-24T10:50:00Z' }) }];
    expect(t.evaluate({ nowMs: NOW + RECOVERY_FREEZE_MS + 1 })).toHaveLength(1);
  });

  it('disabled agent MUST NOT flag', () => {
    const t = new FrozenContentTrigger(mgr);
    const frozen = hb({ status: 'working', current_task: 'stuck' });
    mgr.snapshot = [{ name: 'a', enabled: false, uptimeMs: upt, heartbeat: frozen }];
    t.evaluate({ nowMs: NOW });
    expect(t.evaluate({ nowMs: NOW + RECOVERY_FREEZE_MS + 1 })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// recover() chokepoint
// ---------------------------------------------------------------------------

const wedge = (agent = 'a'): RecoveryCandidate => ({ agent, action: 'force-fresh-restart', reason: 'wedge' });

describe('recover() — discriminator VETO', () => {
  it('alive-idle codex MUST NOT restart: a non-WEDGED verdict vetoes the action', async () => {
    mgr.verdict = 'ALIVE_IDLE';
    await wd.recover(wedge(), NOW, new Set());
    expect(mgr.forceCalls).toEqual([]);
  });
  it('UNCERTAIN vetoes too', async () => {
    mgr.verdict = 'UNCERTAIN';
    await wd.recover(wedge(), NOW, new Set());
    expect(mgr.forceCalls).toEqual([]);
  });
  it('WEDGED proceeds', async () => {
    mgr.verdict = 'WEDGED';
    await wd.recover(wedge(), NOW, new Set());
    expect(mgr.forceCalls).toEqual(['a']);
  });
  it('start-absent skips the discriminator (absent agent has no process to probe)', async () => {
    mgr.verdict = 'UNCERTAIN'; // would veto a force-fresh, but not a start-absent
    await wd.recover({ agent: 'ghost', action: 'start-absent', reason: 'absent' }, NOW, new Set());
    expect(mgr.startCalls).toEqual(['ghost']);
  });
});

describe('recover() — single-sweep dedup', () => {
  it('the same agent is actioned at most once per sweep', async () => {
    mgr.verdict = 'WEDGED';
    const seen = new Set<string>();
    await wd.recover(wedge('a'), NOW, seen);
    await wd.recover(wedge('a'), NOW, seen);
    expect(mgr.forceCalls).toEqual(['a']);
  });
});

describe('recover() — cross-watchdog cooldown', () => {
  it('a .restart-planned within the cooldown window skips (do not fight another restarter)', async () => {
    mgr.verdict = 'WEDGED';
    const marker = join(mgr.stateDirFor('a'), '.restart-planned');
    writeFileSync(marker, 'planned');
    const recentSec = (NOW - 5 * 60_000) / 1000; // 5 min ago (< 15 min cooldown)
    utimesSync(marker, recentSec, recentSec);
    await wd.recover(wedge('a'), NOW, new Set());
    expect(mgr.forceCalls).toEqual([]);
  });

  it('a .restart-planned older than the cooldown proceeds', async () => {
    mgr.verdict = 'WEDGED';
    const marker = join(mgr.stateDirFor('a'), '.restart-planned');
    writeFileSync(marker, 'planned');
    const oldSec = (NOW - RESTART_COOLDOWN_MS - 60_000) / 1000; // 16 min ago
    utimesSync(marker, oldSec, oldSec);
    await wd.recover(wedge('a'), NOW, new Set());
    expect(mgr.forceCalls).toEqual(['a']);
  });
});

describe('recover() — circuit breaker', () => {
  it('2 recoveries proceed, the 3rd trips, and it resets after the pause', async () => {
    mgr.verdict = 'WEDGED';
    // Distinct sweeps (fresh Set each), spaced 1 min apart — all inside the 15-min window.
    await wd.recover(wedge('a'), NOW, new Set());
    await wd.recover(wedge('a'), NOW + 60_000, new Set());
    expect(mgr.forceCalls).toHaveLength(CIRCUIT_MAX_RESTARTS); // 2 proceeded

    await wd.recover(wedge('a'), NOW + 120_000, new Set());
    expect(mgr.forceCalls).toHaveLength(CIRCUIT_MAX_RESTARTS); // 3rd tripped — no new call

    // After the 30-min pause expires, recovery is allowed again.
    await wd.recover(wedge('a'), NOW + CIRCUIT_PAUSE_MS + 130_000, new Set());
    expect(mgr.forceCalls).toHaveLength(CIRCUIT_MAX_RESTARTS + 1);
  });
});
