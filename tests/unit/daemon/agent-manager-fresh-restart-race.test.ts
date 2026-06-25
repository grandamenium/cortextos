import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const observedStartModes: string[] = [];

class MockAgentProcess {
  name: string;
  env: { ctxRoot: string };

  constructor(name: string, env: { ctxRoot: string }) {
    this.name = name;
    this.env = env;
  }

  setTelegramHandle() { /* no-op */ }
  onStatusChanged() { /* no-op */ }
  isBootstrapped() { return false; }

  async start() {
    const stateDir = join(this.env.ctxRoot, 'state', this.name);
    const forceFreshPath = join(stateDir, '.force-fresh');
    const mode = existsSync(forceFreshPath) ? 'fresh' : 'continue';
    if (existsSync(forceFreshPath)) unlinkSync(forceFreshPath);
    observedStartModes.push(mode);
  }

  async stop() { /* no-op */ }

  getStatus() {
    return { name: this.name, status: 'running' as const, pid: 4321 };
  }
}

vi.mock('../../../src/daemon/agent-process.js', () => ({
  AgentProcess: MockAgentProcess,
}));

vi.mock('../../../src/daemon/fast-checker.js', () => ({
  FastChecker: class {
    start() { return Promise.resolve(); }
    stop() {}
    wake() {}
    handleCallback() { return Promise.resolve(); }
  },
}));

vi.mock('../../../src/telegram/api.js', () => ({
  TelegramAPI: class {
    constructor() {}
    sendMessage() { return Promise.resolve(); }
  },
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

vi.mock('../../../src/bus/metrics.js', () => ({
  collectTelegramCommands: vi.fn().mockReturnValue([]),
  registerTelegramCommands: vi.fn().mockResolvedValue({ status: 'ok', count: 0 }),
}));

const { AgentManager } = await import('../../../src/daemon/agent-manager.js');

describe('AgentManager queued fresh restart handling', () => {
  let testDir: string;
  let ctxRoot: string;
  let frameworkRoot: string;
  let agentDir: string;

  beforeEach(() => {
    observedStartModes.length = 0;
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-am-fresh-race-'));
    ctxRoot = join(testDir, 'instance');
    frameworkRoot = join(testDir, 'framework');
    agentDir = join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice');

    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'config.json'), JSON.stringify({ enabled: true }), 'utf-8');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('re-arms .force-fresh before honoring a queued restart whose markers were already consumed', async () => {
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    vi.spyOn(am as unknown as { isPidAlive(pid: number): boolean }, 'isPidAlive').mockReturnValue(true);
    vi.spyOn(am as unknown as { startAgentCronScheduler(name: string): void }, 'startAgentCronScheduler').mockImplementation(() => {});

    const stateDir = join(ctxRoot, 'state', 'alice');
    mkdirSync(stateDir, { recursive: true });
    const handoffDocPath = join(testDir, 'handoff.md');
    writeFileSync(handoffDocPath, '# handoff\n', 'utf-8');
    writeFileSync(join(stateDir, '.handoff-doc-path'), `${handoffDocPath}\n`, 'utf-8');
    writeFileSync(join(stateDir, '.force-fresh'), 'planned fresh restart\n', 'utf-8');

    let resolveStop: (() => void) | null = null;
    (am as unknown as {
      agents: Map<string, unknown>;
    }).agents.set('alice', {
      process: {
        getStatus: () => ({ name: 'alice', status: 'running' as const, pid: 4321 }),
        stop: vi.fn().mockImplementation(() => new Promise<void>((resolve) => {
          resolveStop = resolve;
        })),
      },
      checker: { stop: vi.fn() },
      poller: undefined,
      activityPoller: undefined,
    });

    const restartPromise = am.restartAgent('alice');
    await new Promise((resolve) => setTimeout(resolve, 0));

    await am.startAgent('alice', agentDir, {}, 'acme');

    unlinkSync(join(stateDir, '.force-fresh'));
    unlinkSync(join(stateDir, '.handoff-doc-path'));

    resolveStop?.();
    await restartPromise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(observedStartModes).toEqual(['fresh']);
    expect((am as unknown as { pendingRestarts: Map<string, { forceFresh: boolean }> }).pendingRestarts.has('alice')).toBe(false);
  });
});
