import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('../../../src/daemon/agent-process.js', () => ({
  AgentProcess: class {
    name: string;
    constructor(name: string) {
      this.name = name;
    }
    async start() { /* no-op */ }
    async stop() { /* no-op */ }
    getStatus() { return { name: this.name, status: 'stopped' as const }; }
    onStatusChanged() { /* no-op */ }
    isBootstrapped() { return false; }
  },
}));

vi.mock('../../../src/daemon/fast-checker.js', () => ({
  FastChecker: class { start() { return Promise.resolve(); } stop() {} wake() {} handleCallback() { return Promise.resolve(); } },
}));

vi.mock('../../../src/telegram/api.js', () => ({
  TelegramAPI: class {
    constructor() {}
    sendMessage() { return Promise.resolve(); }
  },
  collectTelegramCommands: vi.fn().mockReturnValue([]),
  registerTelegramCommands: vi.fn().mockResolvedValue({ status: 'ok', count: 0 }),
}));

vi.mock('../../../src/telegram/poller.js', () => ({
  TelegramPoller: class {
    lastExitReason = 'stopped-externally';
    onMessage() {}
    onCallback() {}
    onReaction() {}
    start() { return Promise.resolve(); }
    stop() {}
  },
}));

const { AgentManager } = await import('../../../src/daemon/agent-manager.js');

describe('AgentManager occupied-slot recovery', () => {
  let testDir: string;
  let ctxRoot: string;
  let frameworkRoot: string;
  let agentDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-am-slot-'));
    ctxRoot = join(testDir, 'instance');
    frameworkRoot = join(testDir, 'framework');
    agentDir = join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    mkdirSync(agentDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('clears a live occupied slot once before starting, without pendingRestarts noise', async () => {
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    const fakeEntry = {
      process: {
        getStatus: () => ({ name: 'alice', status: 'running' as const, pid: 4321 }),
        stop: vi.fn(),
      },
      checker: { stop: vi.fn() },
      poller: undefined,
      activityPoller: undefined,
    };
    (am as unknown as { agents: Map<string, unknown> }).agents.set('alice', fakeEntry);

    const stopSpy = vi.spyOn(am, 'stopAgent').mockImplementation(async (name: string) => {
      (am as unknown as { agents: Map<string, unknown> }).agents.delete(name);
    });

    await am.startAgent('alice', agentDir, {}, 'acme');

    expect(stopSpy).toHaveBeenCalledWith('alice');
    expect((am as unknown as { pendingRestarts: Set<string> }).pendingRestarts.has('alice')).toBe(false);
    expect((am as unknown as { agents: Map<string, unknown> }).agents.has('alice')).toBe(true);
  });

  it('falls back to pendingRestarts only when the occupied slot still survives stopAgent()', async () => {
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    const fakeEntry = {
      process: {
        getStatus: () => ({ name: 'alice', status: 'running' as const, pid: 4321 }),
        stop: vi.fn(),
      },
      checker: { stop: vi.fn() },
      poller: undefined,
      activityPoller: undefined,
    };
    (am as unknown as { agents: Map<string, unknown> }).agents.set('alice', fakeEntry);

    vi.spyOn(am, 'stopAgent').mockResolvedValue();

    await am.startAgent('alice', agentDir, {}, 'acme');

    expect((am as unknown as { pendingRestarts: Set<string> }).pendingRestarts.has('alice')).toBe(true);
  });
});
