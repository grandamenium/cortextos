import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock the PTY layer so we don't load native bindings or spawn real processes.
// AgentManager → AgentProcess → AgentPTY → node-pty. We mock at AgentProcess.
vi.mock('../../../src/daemon/agent-process.js', () => ({
  AgentProcess: class {
    name: string;
    dir: string;
    constructor(name: string, dir: string) {
      this.name = name;
      this.dir = dir;
    }
    async start() { /* no-op */ }
    async stop() { /* no-op */ }
    getStatus() { return { name: this.name, status: 'stopped' }; }
    onExit() { /* no-op */ }
  },
}));

// Mock FastChecker so it doesn't try to spawn anything either.
vi.mock('../../../src/daemon/fast-checker.js', () => ({
  FastChecker: class {
    start() { /* no-op */ }
    stop() { /* no-op */ }
    wake() { /* no-op */ }
  },
}));

// Mock Telegram so we don't try to make HTTP calls.
vi.mock('../../../src/telegram/api.js', () => ({
  TelegramAPI: class {
    constructor() { /* no-op */ }
  },
}));

vi.mock('../../../src/telegram/poller.js', () => ({
  TelegramPoller: class {
    start() { /* no-op */ }
    stop() { /* no-op */ }
  },
}));

const { AgentManager } = await import('../../../src/daemon/agent-manager.js');

describe('AgentManager.discoverAndStart - BUG-028 fix', () => {
  let testDir: string;
  let ctxRoot: string;
  let frameworkRoot: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-am-test-'));
    ctxRoot = join(testDir, 'instance');
    frameworkRoot = join(testDir, 'framework');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    mkdirSync(join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice'), { recursive: true });
    mkdirSync(join(frameworkRoot, 'orgs', 'acme', 'agents', 'bob'), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('skips agents marked enabled: false in enabled-agents.json', async () => {
    // Mark alice as disabled at the instance level (the file the CLI writes to)
    writeFileSync(
      join(ctxRoot, 'config', 'enabled-agents.json'),
      JSON.stringify({ alice: { enabled: false, org: 'acme' } }),
    );

    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    const startSpy = vi.spyOn(am, 'startAgent').mockResolvedValue();

    await am.discoverAndStart();

    // alice should be skipped (disabled in instance file), bob should be started
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledWith('bob', expect.any(String), expect.any(Object));
  });

  it('starts all discovered agents when enabled-agents.json is missing', async () => {
    // No enabled-agents.json on disk — daemon defaults to enabled-on-discovery
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    const startSpy = vi.spyOn(am, 'startAgent').mockResolvedValue();

    await am.discoverAndStart();

    expect(startSpy).toHaveBeenCalledTimes(2);
    const namesStarted = startSpy.mock.calls.map(call => call[0]).sort();
    expect(namesStarted).toEqual(['alice', 'bob']);
  });

  it('starts all discovered agents when enabled-agents.json is empty {}', async () => {
    writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), '{}');
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    const startSpy = vi.spyOn(am, 'startAgent').mockResolvedValue();

    await am.discoverAndStart();

    // Empty object means no overrides — all discovered agents start
    expect(startSpy).toHaveBeenCalledTimes(2);
  });

  it('still respects per-agent config.json enabled: false (existing behavior)', async () => {
    // Per-agent config.json takes precedence — this is the legacy behavior we
    // explicitly preserved in the BUG-028 fix
    writeFileSync(
      join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice', 'config.json'),
      JSON.stringify({ enabled: false }),
    );

    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    const startSpy = vi.spyOn(am, 'startAgent').mockResolvedValue();

    await am.discoverAndStart();

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledWith('bob', expect.any(String), expect.any(Object));
  });

  it('handles corrupt enabled-agents.json by defaulting to enabled-all', async () => {
    writeFileSync(
      join(ctxRoot, 'config', 'enabled-agents.json'),
      'this is not valid json',
    );

    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    const startSpy = vi.spyOn(am, 'startAgent').mockResolvedValue();

    await am.discoverAndStart();

    // Corrupt file is treated as missing — all discovered agents start
    expect(startSpy).toHaveBeenCalledTimes(2);
  });
});
