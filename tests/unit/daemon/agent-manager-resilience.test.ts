import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// SYS-DAEMON-RESILIENCE-01 Part A — Fix 1 (assert-outcome boot, no swallow).
//
// Reproduces the partial-start failure mode: `startAgent` registers the agent
// (this.agents.set) and only AFTER an awaited `agentProcess.start()` wires the
// cron scheduler. If start() rejects, the agent is left registered with a live
// session but NO cron scheduler — and `Promise.allSettled` used to swallow the
// rejection. Fix 1 logs the rejection and asserts+recovers the missing scheduler.

// Names whose mocked AgentProcess.start() will reject (set per-test).
const FAIL_START = new Set<string>();
// Live mock AgentProcess instances, by agent name (latest wins) — lets a test
// drive status transitions (e.g. emit 'halted') for Fix 3.
const INSTANCES = new Map<string, MockAgentProcess>();

class MockAgentProcess {
  name: string;
  // expose config so AgentManager.startAgentCronScheduler can read process['config']
  config: Record<string, unknown>;
  private _status = 'running';
  private _handlers: Array<(s: { name: string; status: string }) => void> = [];
  constructor(name: string, _env: unknown, config: Record<string, unknown>) {
    this.name = name;
    this.config = config ?? {};
    INSTANCES.set(name, this);
  }
  async start() {
    if (FAIL_START.has(this.name)) {
      throw new Error(`simulated start() failure for ${this.name}`);
    }
  }
  async stop() { /* no-op */ }
  getStatus() { return { name: this.name, status: this._status }; }
  onExit() { /* no-op */ }
  onStatusChanged(h: (s: { name: string; status: string }) => void) { this._handlers.push(h); }
  setTelegramHandle() { /* no-op */ }
  // test helper: emit a status transition to all subscribers
  __emit(status: string) {
    this._status = status;
    for (const h of this._handlers) h({ name: this.name, status });
  }
}

vi.mock('../../../src/daemon/agent-process.js', () => ({ AgentProcess: MockAgentProcess }));

vi.mock('../../../src/daemon/fast-checker.js', () => ({
  FastChecker: class { start() {} stop() {} wake() {} },
}));
vi.mock('../../../src/telegram/api.js', () => ({ TelegramAPI: class { constructor() {} } }));
vi.mock('../../../src/telegram/poller.js', () => ({ TelegramPoller: class { start() {} stop() {} } }));

const { AgentManager } = await import('../../../src/daemon/agent-manager.js');

describe('SYS-DAEMON-RESILIENCE-01 Fix 1: assert-outcome boot (no swallow)', () => {
  let testDir: string;
  let ctxRoot: string;
  let frameworkRoot: string;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    FAIL_START.clear();
    INSTANCES.clear();
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-resilience-'));
    ctxRoot = join(testDir, 'instance');
    frameworkRoot = join(testDir, 'framework');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    for (const name of ['goodagent', 'failstart']) {
      const dir = join(frameworkRoot, 'orgs', 'acme', 'agents', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ enabled: true }));
    }
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('recovers a cron scheduler for an agent whose start() rejected (partial start)', async () => {
    FAIL_START.add('failstart');
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');

    await am.discoverAndStart();

    // Both agents are registered: failstart's this.agents.set runs BEFORE the
    // awaited start() that rejects, so it stays in the registry (partial start).
    const names = am.getAgentNames().sort();
    expect(names).toEqual(['failstart', 'goodagent']);

    // Fix 1 assert-outcome: BOTH agents end with a live cron scheduler, including
    // the one whose start() rejected (recovered via lazy-wire). Pre-fix, failstart
    // would have NO scheduler.
    expect(am.getCronScheduler('goodagent')).toBeDefined();
    expect(am.getCronScheduler('failstart')).toBeDefined();
  });

  it('does NOT swallow the rejection — it is logged', async () => {
    FAIL_START.add('failstart');
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');

    await am.discoverAndStart();

    const logged = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('startAgent REJECTED for "failstart"');
    expect(logged).toContain('BOOT-ASSERT');
  });

  it('healthy boot: all agents end with a scheduler and no assert-fail is logged', async () => {
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');

    await am.discoverAndStart();

    expect(am.getCronScheduler('goodagent')).toBeDefined();
    expect(am.getCronScheduler('failstart')).toBeDefined();
    const logged = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).not.toContain('BOOT-ASSERT FAIL');
  });

  // ---- Fix 3: terminal-halt registry cleanup ----

  it('removes a HALTED agent from the registry + scheduler so a later start is not deduped', async () => {
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    await am.discoverAndStart();
    expect(am.getAgentNames()).toContain('goodagent');
    expect(am.getCronScheduler('goodagent')).toBeDefined();
    // dedup BEFORE halt: a start would be deduped (entry present)
    expect(am.inspectAgentOp('start', 'goodagent')).toMatchObject({ ok: false, code: 'DEDUPED' });

    // drive the agent to the terminal 'halted' state
    INSTANCES.get('goodagent')!.__emit('halted');

    // corpse + scheduler removed
    expect(am.getAgentNames()).not.toContain('goodagent');
    expect(am.getCronScheduler('goodagent')).toBeUndefined();
    // a subsequent start is NO LONGER deduped against the corpse
    expect(am.inspectAgentOp('start', 'goodagent')).toEqual({ ok: true });
  });

  it('does NOT remove on transient crashed (self-restart pending)', async () => {
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    await am.discoverAndStart();

    INSTANCES.get('goodagent')!.__emit('crashed');

    // still registered — crashed is transient; handleExit schedules a restart
    expect(am.getAgentNames()).toContain('goodagent');
    expect(am.getCronScheduler('goodagent')).toBeDefined();
  });
});
