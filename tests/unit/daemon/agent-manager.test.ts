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
    // BUG-043: startAgent now accepts a 4th `org` argument
    expect(startSpy).toHaveBeenCalledWith('bob', expect.any(String), expect.any(Object), 'acme');
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
    // BUG-043: startAgent now accepts a 4th `org` argument
    expect(startSpy).toHaveBeenCalledWith('bob', expect.any(String), expect.any(Object), 'acme');
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

describe('AgentManager.discoverAndStart - BUG-043 fix (multi-org support)', () => {
  let testDir: string;
  let ctxRoot: string;
  let frameworkRoot: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-am-multiorg-'));
    ctxRoot = join(testDir, 'instance');
    frameworkRoot = join(testDir, 'framework');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    // Two orgs with agents in each — simulates a multi-org install
    // (e.g. James's lifeos + cointally + testorg setup)
    mkdirSync(join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice'), { recursive: true });
    mkdirSync(join(frameworkRoot, 'orgs', 'acme', 'agents', 'bob'), { recursive: true });
    mkdirSync(join(frameworkRoot, 'orgs', 'widgetco', 'agents', 'carol'), { recursive: true });
    mkdirSync(join(frameworkRoot, 'orgs', 'widgetco', 'agents', 'dave'), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('discovers agents from ALL orgs, not just the daemon startup org', async () => {
    // BUG-043: before the fix, an AgentManager constructed with org='acme'
    // would only discover agents in orgs/acme/. Agents in orgs/widgetco/
    // were silently invisible. This test pins the multi-org scan in place.
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    const startSpy = vi.spyOn(am, 'startAgent').mockResolvedValue();

    await am.discoverAndStart();

    expect(startSpy).toHaveBeenCalledTimes(4);
    const namesStarted = startSpy.mock.calls.map(call => call[0]).sort();
    expect(namesStarted).toEqual(['alice', 'bob', 'carol', 'dave']);
  });

  it('passes the correct per-agent org as the 4th argument to startAgent', async () => {
    // BUG-043: startAgent must know which org the agent lives under
    // so it can build the right filesystem path. discoverAgents now
    // attaches org per discovered entry, and discoverAndStart threads
    // it through.
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    const startSpy = vi.spyOn(am, 'startAgent').mockResolvedValue();

    await am.discoverAndStart();

    const callsByName = new Map<string, readonly unknown[]>();
    for (const call of startSpy.mock.calls) {
      callsByName.set(call[0] as string, call);
    }
    expect(callsByName.get('alice')?.[3]).toBe('acme');
    expect(callsByName.get('bob')?.[3]).toBe('acme');
    expect(callsByName.get('carol')?.[3]).toBe('widgetco');
    expect(callsByName.get('dave')?.[3]).toBe('widgetco');
  });

  it('respects enabled-agents.json disable-flags across multiple orgs', async () => {
    // alice in acme and dave in widgetco are both disabled. The fix must
    // still honor per-agent enable/disable regardless of which org the
    // agent is in.
    writeFileSync(
      join(ctxRoot, 'config', 'enabled-agents.json'),
      JSON.stringify({
        alice: { enabled: false, org: 'acme' },
        dave: { enabled: false, org: 'widgetco' },
      }),
    );
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    const startSpy = vi.spyOn(am, 'startAgent').mockResolvedValue();

    await am.discoverAndStart();

    expect(startSpy).toHaveBeenCalledTimes(2);
    const namesStarted = startSpy.mock.calls.map(call => call[0]).sort();
    expect(namesStarted).toEqual(['bob', 'carol']);
  });

  it('returns empty list when orgs/ does not exist (backward compat)', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'cortextos-am-empty-'));
    try {
      // No orgs/ dir at all — daemon should not error, just discover nothing
      const am = new AgentManager('test-instance', ctxRoot, emptyDir, 'acme');
      const startSpy = vi.spyOn(am, 'startAgent').mockResolvedValue();

      await am.discoverAndStart();

      expect(startSpy).not.toHaveBeenCalled();
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

describe('AgentManager.restartAgent - BUG-007 fix (rebuild Telegram poller)', () => {
  let testDir: string;
  let ctxRoot: string;
  let frameworkRoot: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-am-restart-test-'));
    ctxRoot = join(testDir, 'instance');
    frameworkRoot = join(testDir, 'framework');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    mkdirSync(join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice'), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('delegates to stopAgent then startAgent (in order)', async () => {
    // BUG-007: previously restartAgent only stopped/started the AgentProcess and
    // FastChecker inline, leaving the TelegramPoller from the previous incarnation
    // running. The fix delegates to stopAgent (which DOES clean up the poller) and
    // startAgent (which builds a fresh poller from the agent's .env). This test
    // pins that delegation in place so a future regression to inline cleanup
    // would fail loudly.
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    // Inject a fake agent so restartAgent's existence check passes without
    // actually running the full startAgent flow
    (am as any).agents.set('alice', { process: {}, checker: {}, poller: { stop() {} } });

    const stopSpy = vi.spyOn(am, 'stopAgent').mockResolvedValue();
    const startSpy = vi.spyOn(am, 'startAgent').mockResolvedValue();

    await am.restartAgent('alice');

    expect(stopSpy).toHaveBeenCalledWith('alice');
    expect(startSpy).toHaveBeenCalledWith('alice', '');
    // Verify call order: stop must complete before start, so the old poller
    // is fully torn down before the new one is constructed
    const stopOrder = stopSpy.mock.invocationCallOrder[0];
    const startOrder = startSpy.mock.invocationCallOrder[0];
    expect(stopOrder).toBeLessThan(startOrder);
  });

  it('is a no-op when the agent does not exist', async () => {
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    const stopSpy = vi.spyOn(am, 'stopAgent').mockResolvedValue();
    const startSpy = vi.spyOn(am, 'startAgent').mockResolvedValue();

    await am.restartAgent('nonexistent');

    expect(stopSpy).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();
  });
});
