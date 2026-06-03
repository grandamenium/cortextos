import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { StaleAgentWatchdog } from '../../../src/daemon/stale-watchdog';
import { staleWatchdogEnabled } from '../../../src/daemon/index';
import type { AgentManager } from '../../../src/daemon/agent-manager';

interface Spies {
  restartAgent: ReturnType<typeof vi.fn>;
  stopAgent: ReturnType<typeof vi.fn>;
}

function fakeAgentManager(statuses: Array<{ name: string; status: string }>, spies: Spies): AgentManager {
  return {
    getAllStatuses: () => statuses,
    restartAgent: spies.restartAgent,
    stopAgent: spies.stopAgent,
  } as unknown as AgentManager;
}

function seedHeartbeat(ctxRoot: string, agent: string, lastHeartbeat: string): void {
  const dir = join(ctxRoot, 'state', agent);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'heartbeat.json'), JSON.stringify({ agent, last_heartbeat: lastHeartbeat }), 'utf-8');
}

function seedAgentConfig(frameworkRoot: string, org: string, agent: string, config: object): void {
  const dir = join(frameworkRoot, 'orgs', org, 'agents', agent);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config), 'utf-8');
}

const STALE = '2020-01-01T00:00:00.000Z'; // years old → stale under any threshold
const FRESH = new Date().toISOString();

describe('staleWatchdogEnabled (safety guard)', () => {
  const original = process.env.CTX_STALE_WATCHDOG;
  afterEach(() => {
    if (original === undefined) delete process.env.CTX_STALE_WATCHDOG;
    else process.env.CTX_STALE_WATCHDOG = original;
  });

  it('is OFF by default (unset)', () => {
    delete process.env.CTX_STALE_WATCHDOG;
    expect(staleWatchdogEnabled()).toBe(false);
  });

  it('arms only on the exact value "1"', () => {
    process.env.CTX_STALE_WATCHDOG = '1';
    expect(staleWatchdogEnabled()).toBe(true);
    for (const v of ['0', 'true', 'yes', '']) {
      process.env.CTX_STALE_WATCHDOG = v;
      expect(staleWatchdogEnabled()).toBe(false);
    }
  });
});

describe('StaleAgentWatchdog lifecycle', () => {
  let ctxRoot: string;
  beforeEach(() => { ctxRoot = mkdtempSync(join(tmpdir(), 'cortextos-sw-')); });
  afterEach(() => { rmSync(ctxRoot, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it('start() is idempotent and unrefs the timer; stop() clears it', () => {
    const unref = vi.fn();
    const fakeTimer = { unref } as unknown as NodeJS.Timeout;
    const setIntervalSpy = vi.spyOn(global, 'setInterval').mockReturnValue(fakeTimer);
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval').mockImplementation(() => {});

    const wd = new StaleAgentWatchdog(
      fakeAgentManager([], { restartAgent: vi.fn(), stopAgent: vi.fn() }),
      ctxRoot,
      ctxRoot,
    );

    wd.start();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(unref).toHaveBeenCalledTimes(1);

    wd.start(); // second start must not install a second interval
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    wd.stop();
    expect(clearIntervalSpy).toHaveBeenCalledWith(fakeTimer);
  });
});

describe('StaleAgentWatchdog.checkAndRestart behavior', () => {
  let ctxRoot: string;
  let frameworkRoot: string;
  let spies: Spies;

  beforeEach(() => {
    ctxRoot = mkdtempSync(join(tmpdir(), 'cortextos-sw-ctx-'));
    frameworkRoot = mkdtempSync(join(tmpdir(), 'cortextos-sw-fw-'));
    spies = { restartAgent: vi.fn(), stopAgent: vi.fn() };
  });
  afterEach(() => {
    rmSync(ctxRoot, { recursive: true, force: true });
    rmSync(frameworkRoot, { recursive: true, force: true });
  });

  it('restarts a running agent whose heartbeat is stale', async () => {
    seedHeartbeat(ctxRoot, 'a1', STALE);
    const wd = new StaleAgentWatchdog(
      fakeAgentManager([{ name: 'a1', status: 'running' }], spies),
      ctxRoot,
      frameworkRoot,
    );
    await wd.checkAndRestart();
    expect(spies.restartAgent).toHaveBeenCalledWith('a1');
  });

  it('does NOT restart an agent with a fresh heartbeat', async () => {
    seedHeartbeat(ctxRoot, 'a1', FRESH);
    const wd = new StaleAgentWatchdog(
      fakeAgentManager([{ name: 'a1', status: 'running' }], spies),
      ctxRoot,
      frameworkRoot,
    );
    await wd.checkAndRestart();
    expect(spies.restartAgent).not.toHaveBeenCalled();
  });

  it('does NOT restart a non-running agent even if stale', async () => {
    seedHeartbeat(ctxRoot, 'a1', STALE);
    const wd = new StaleAgentWatchdog(
      fakeAgentManager([{ name: 'a1', status: 'stopped' }], spies),
      ctxRoot,
      frameworkRoot,
    );
    await wd.checkAndRestart();
    expect(spies.restartAgent).not.toHaveBeenCalled();
  });

  it('respects per-agent stale_watchdog_enabled:false', async () => {
    seedHeartbeat(ctxRoot, 'a1', STALE);
    seedAgentConfig(frameworkRoot, 'testorg', 'a1', { stale_watchdog_enabled: false });
    const wd = new StaleAgentWatchdog(
      fakeAgentManager([{ name: 'a1', status: 'running' }], spies),
      ctxRoot,
      frameworkRoot,
    );
    await wd.checkAndRestart();
    expect(spies.restartAgent).not.toHaveBeenCalled();
  });
});
