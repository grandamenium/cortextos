import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildReplyContext } from '../../../src/daemon/agent-manager.js';

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
    scheduleCronVerification() { /* no-op */ }
  },
}));

// Mock FastChecker so it doesn't try to spawn anything either.
// start() must be async because the real FastChecker.start() is async and
// agent-manager.ts:235 calls .catch() on the return value. A sync no-op
// returns undefined, which throws TypeError when .catch is invoked.
vi.mock('../../../src/daemon/fast-checker.js', () => ({
  FastChecker: class {
    async start() { /* no-op */ }
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

describe('buildReplyContext - Telegram reply context (BUG fix: media replies lost)', () => {
  it('returns undefined when no reply message', () => {
    expect(buildReplyContext(undefined)).toBeUndefined();
  });

  it('returns text content for plain text replies', () => {
    const msg = { message_id: 1, chat: { id: 1 }, text: 'Hello world' };
    expect(buildReplyContext(msg)).toBe('Hello world');
  });

  it('returns caption for media messages with captions', () => {
    const msg = { message_id: 2, chat: { id: 1 }, photo: [{ file_id: 'x', width: 100, height: 100, file_size: 1 }], caption: 'Check this out' };
    expect(buildReplyContext(msg)).toBe('Check this out');
  });

  it('returns [video] for video messages without caption', () => {
    const msg = { message_id: 3, chat: { id: 1 }, video: { file_id: 'v1', width: 1920, height: 1080, duration: 30 } };
    expect(buildReplyContext(msg)).toBe('[video]');
  });

  it('returns [photo] for photo messages without caption', () => {
    const msg = { message_id: 4, chat: { id: 1 }, photo: [{ file_id: 'p1', width: 100, height: 100, file_size: 1 }] };
    expect(buildReplyContext(msg)).toBe('[photo]');
  });

  it('returns [voice message] for voice messages', () => {
    const msg = { message_id: 5, chat: { id: 1 }, voice: { file_id: 'vc1', duration: 5 } };
    expect(buildReplyContext(msg)).toBe('[voice message]');
  });

  it('returns [video note] for video note messages', () => {
    const msg = { message_id: 6, chat: { id: 1 }, video_note: { file_id: 'vn1', length: 240, duration: 10 } };
    expect(buildReplyContext(msg)).toBe('[video note]');
  });

  it('returns [audio] for audio messages', () => {
    const msg = { message_id: 7, chat: { id: 1 }, audio: { file_id: 'a1', duration: 120 } };
    expect(buildReplyContext(msg)).toBe('[audio]');
  });

  it('returns document name for document messages', () => {
    const msg = { message_id: 8, chat: { id: 1 }, document: { file_id: 'd1', file_name: 'report.pdf' } };
    expect(buildReplyContext(msg)).toBe('[document: report.pdf]');
  });

  it('returns [document: file] when document has no file_name', () => {
    const msg = { message_id: 9, chat: { id: 1 }, document: { file_id: 'd2' } };
    expect(buildReplyContext(msg)).toBe('[document: file]');
  });

  it('prefers text over caption when both present', () => {
    const msg = { message_id: 10, chat: { id: 1 }, text: 'Text content', caption: 'Caption content' };
    expect(buildReplyContext(msg)).toBe('Text content');
  });

  it('strips control characters from text', () => {
    const msg = { message_id: 11, chat: { id: 1 }, text: 'Hello\x00world' };
    const result = buildReplyContext(msg);
    expect(result).not.toContain('\x00');
  });
});

describe('AgentManager.startAgent - starting-set mutex (double-spawn prevention)', () => {
  let testDir: string;
  let ctxRoot: string;
  let frameworkRoot: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-am-starting-test-'));
    ctxRoot = join(testDir, 'instance');
    frameworkRoot = join(testDir, 'framework');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    mkdirSync(join(ctxRoot, 'logs', 'alice'), { recursive: true });
    mkdirSync(join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice'), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('clears the starting flag after a successful start', async () => {
    // After startAgent resolves successfully, the starting set should NOT
    // contain the agent name — otherwise a subsequent legitimate restart
    // would be rejected as a duplicate.
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    await am.startAgent('alice', join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice'));
    expect((am as any).starting.has('alice')).toBe(false);
  });

  it('clears the starting flag even when startAgent throws', async () => {
    // The finally block must clear the flag on error so a failed start does
    // not leave the agent permanently unstartable. Force a throw by pointing
    // at a nonexistent agent dir AND no auto-discovery — startAgent will
    // exit via the early-return error path.
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    await am.startAgent('nonexistent', '/no/such/dir').catch(() => { /* expected */ });
    expect((am as any).starting.has('nonexistent')).toBe(false);
  });

  it('rejects a re-entrant call for the same agent while starting is in flight', async () => {
    // Simulates the race window: call 1 enters startAgent and adds 'alice' to
    // the starting set. Before call 1 reaches the final agents.set(), call 2
    // arrives. Call 2 should bail at the starting-set check.
    //
    // We construct this directly by manipulating the starting set, since the
    // synchronous-up-to-first-await property makes the natural race
    // unreproducible in a single-threaded test. The test pins the GUARD
    // behavior, not the timing.
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    (am as any).starting.add('alice');

    // The startAgent call should bail immediately without ever touching the
    // agents map. We assert no entry was added.
    await am.startAgent('alice', join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice'));
    expect((am as any).agents.has('alice')).toBe(false);
  });

  it('does NOT bail on a re-entrant call for a DIFFERENT agent', async () => {
    // The starting set is per-agent, not global. A different agent name
    // should still be allowed to start while another agent is mid-start.
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    mkdirSync(join(frameworkRoot, 'orgs', 'acme', 'agents', 'bob'), { recursive: true });
    mkdirSync(join(ctxRoot, 'logs', 'bob'), { recursive: true });
    (am as any).starting.add('alice');

    // Bob's start should proceed normally even though alice is in starting set
    await am.startAgent('bob', join(frameworkRoot, 'orgs', 'acme', 'agents', 'bob'));
    expect((am as any).agents.has('bob')).toBe(true);
  });
});
