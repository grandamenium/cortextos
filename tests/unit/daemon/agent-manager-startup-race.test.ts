/**
 * Regression tests for the daemon startup race (3-agent dropout).
 *
 * Root cause (2026-05-27 incident):
 *   discoverAndStart() was a sequential for…await loop. When cortextos-improver
 *   had startup_delay=30s, its startAgent() call blocked the entire loop for 30
 *   seconds. During that window, external `cortextos start <agent>` IPC calls
 *   raced in and pre-registered agents under the same names. The sequential loop
 *   then called startAgent() again for those names, hit the BUG-011 branch (agent
 *   already in registry), and queued a pendingRestart — which fired on the NEXT
 *   stop() and triggered another cycle, silently leaving 3 agents stuck.
 *
 * Fix #2 — parallel discoverAndStart: all startAgent calls are launched via
 *   Promise.allSettled so no startup_delay blocks other agents.
 *
 * Fix #3 — idempotent startAgent: if an agent is already in the registry when
 *   startAgent() is called (e.g. via a racing IPC start-agent), the call is a
 *   no-op instead of queuing a pendingRestart cascade.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('../../../src/daemon/agent-process.js', () => ({
  AgentProcess: class {
    name: string;
    dir: string;
    constructor(name: string, dir: string) { this.name = name; this.dir = dir; }
    async start() {}
    async stop() {}
    getStatus() { return { name: this.name, status: 'stopped' }; }
    onExit() {}
  },
}));

vi.mock('../../../src/daemon/fast-checker.js', () => ({
  FastChecker: class {
    start() {}
    stop() {}
    wake() {}
  },
}));

vi.mock('../../../src/telegram/api.js', () => ({
  TelegramAPI: class { constructor() {} },
}));

vi.mock('../../../src/telegram/poller.js', () => ({
  TelegramPoller: class {
    start() {}
    stop() {}
  },
}));

const { AgentManager } = await import('../../../src/daemon/agent-manager.js');

// ---------------------------------------------------------------------------
// Fix #2: parallel discoverAndStart
// ---------------------------------------------------------------------------
describe('Fix #2 — discoverAndStart runs all startAgent calls in parallel', () => {
  let testDir: string;
  let ctxRoot: string;
  let frameworkRoot: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'ctx-race-fix2-'));
    ctxRoot = join(testDir, 'instance');
    frameworkRoot = join(testDir, 'framework');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    mkdirSync(join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice'), { recursive: true });
    mkdirSync(join(frameworkRoot, 'orgs', 'acme', 'agents', 'bob'), { recursive: true });
    mkdirSync(join(frameworkRoot, 'orgs', 'acme', 'agents', 'carol'), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('starts all three agents even when one startup_delay is very long', async () => {
    const callOrder: string[] = [];
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');

    // Simulate startup_delay: alice takes 100ms, bob and carol are instant.
    vi.spyOn(am, 'startAgent').mockImplementation(async (name: string) => {
      if (name === 'alice') await new Promise(r => setTimeout(r, 100));
      callOrder.push(name);
    });

    const start = Date.now();
    await am.discoverAndStart();
    const elapsed = Date.now() - start;

    // All three must have started.
    expect(callOrder.sort()).toEqual(['alice', 'bob', 'carol']);

    // With parallel execution the total time is bounded by the slowest agent
    // (alice: 100ms), not the sum of all delays. Sequential would be ≥300ms
    // if all had 100ms; here alice has 100ms, bob/carol are instant → ≤200ms.
    expect(elapsed).toBeLessThan(300);
  });

  it('still starts all agents even if one startAgent rejects', async () => {
    const started: string[] = [];
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');

    vi.spyOn(am, 'startAgent').mockImplementation(async (name: string) => {
      if (name === 'bob') throw new Error('bob failed to start');
      started.push(name);
    });

    // Promise.allSettled must not propagate the bob rejection to the caller.
    await expect(am.discoverAndStart()).resolves.toBeUndefined();

    // alice and carol still started despite bob's failure.
    expect(started.sort()).toEqual(['alice', 'carol']);
  });
});

// ---------------------------------------------------------------------------
// Fix #3: idempotent startAgent (no pendingRestarts cascade)
// ---------------------------------------------------------------------------
describe('Fix #3 — startAgent is idempotent when agent already in registry', () => {
  let testDir: string;
  let ctxRoot: string;
  let frameworkRoot: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'ctx-race-fix3-'));
    ctxRoot = join(testDir, 'instance');
    frameworkRoot = join(testDir, 'framework');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    mkdirSync(join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice'), { recursive: true });
    // Write a minimal config so startAgent can load it.
    writeFileSync(
      join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice', 'config.json'),
      JSON.stringify({ agent_name: 'alice', enabled: true }),
    );
    // Write a minimal .env so startAgent doesn't error on missing Telegram creds.
    writeFileSync(
      join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice', '.env'),
      'BOT_TOKEN=\nCHAT_ID=\n',
    );
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns without error when called twice for the same agent', async () => {
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');

    // First call: register alice in the agents Map via the real flow.
    // We inject alice directly to simulate "already started by discoverAndStart".
    (am as any).agents.set('alice', { name: 'alice' });

    // Second call: should silently no-op, not throw or queue a restart.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(
      am.startAgent('alice', join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice')),
    ).resolves.toBeUndefined();

    // Must log the idempotent skip message.
    const allLogs = logSpy.mock.calls.flat().join('\n');
    expect(allLogs).toMatch(/start\(alice\) skipped — already in registry/);

    logSpy.mockRestore();
  });

  it('does not queue a pendingRestart (no cascade on stopAgent)', async () => {
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');

    // Simulate the IPC race: inject alice into registry then call startAgent.
    (am as any).agents.set('alice', { name: 'alice' });
    await am.startAgent('alice', join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice'));

    // The old code would have called this.pendingRestarts.add(alice).
    // After the fix, pendingRestarts is gone and nothing is queued.
    expect((am as any).pendingRestarts).toBeUndefined();
  });
});
