import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture the PTY exit handler so tests can simulate exits at controlled times
let capturedOnExit: ((exitCode: number, signal?: number) => void) | null = null;

const mockPty = {
  spawn: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn(),
  write: vi.fn(),
  getPid: vi.fn().mockReturnValue(12345),
  isAlive: vi.fn().mockReturnValue(true),
  onExit: vi.fn().mockImplementation((cb: (exitCode: number, signal?: number) => void) => {
    capturedOnExit = cb;
  }),
};

vi.mock('../../../src/pty/agent-pty.js', () => ({
  AgentPTY: function AgentPTY() { return mockPty; },
}));

const mockInjectMessage = vi.fn();
vi.mock('../../../src/pty/inject.js', () => ({
  injectMessage: mockInjectMessage,
  MessageDedup: class { isDuplicate() { return false; } },
}));

vi.mock('../../../src/utils/atomic.js', () => ({
  ensureDir: vi.fn(),
  atomicWriteSync: vi.fn(),
}));

vi.mock('../../../src/utils/env.js', () => ({
  writeCortextosEnv: vi.fn(),
  resolveEnv: vi.fn().mockReturnValue({ instanceId: 'test', ctxRoot: '/tmp/test' }),
}));

vi.mock('../../../src/bus/reminders.js', () => ({
  getOverdueReminders: vi.fn().mockReturnValue([]),
}));

vi.mock('../../../src/utils/paths.js', () => ({
  resolvePaths: vi.fn().mockReturnValue({}),
}));

const fsMocks = {
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  statSync: vi.fn(),
};

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  // Getter-based exposure of the fsMocks vi.fn()s. Two consumer patterns
  // need to coexist on this file:
  //   (1) `fsMocks.X.mockReset()` — used by the BUG-040 / restarts.log
  //       tests added by this patch
  //   (2) `vi.mocked(fs.X).mockImplementation(...)` — used by the
  //       verifyCronsAfterIdle tests + BUG-048 reschedule tests
  // For (2) to work, `fs.X` MUST resolve to the same vi.fn() instance as
  // `fsMocks.X`. Naive direct reference (`existsSync: fsMocks.existsSync`)
  // breaks because vi.mock factories are hoisted + executed BEFORE the
  // `const fsMocks = {...}` initializer — so the lookup captures
  // `undefined`. Arrow wrappers (`(...args) => fsMocks.X(...args)`) keep
  // (1) working but break (2) because `fs.X` is no longer a vi.fn — it's
  // a plain arrow function, and `vi.mocked()` does not recognize it as
  // mockable. Getters thread the needle: the lookup is deferred until
  // call time (after fsMocks is initialized), and the value returned IS
  // the underlying vi.fn so `vi.mocked()` recognizes it.
  return {
    ...actual,
    mkdirSync: vi.fn(),
    get existsSync() { return fsMocks.existsSync; },
    get readFileSync() { return fsMocks.readFileSync; },
    get writeFileSync() { return fsMocks.writeFileSync; },
    get appendFileSync() { return fsMocks.appendFileSync; },
    get statSync() { return fsMocks.statSync; },
  };
});

const { AgentProcess } = await import('../../../src/daemon/agent-process.js');

const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/test-ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'alice',
  agentDir: '/tmp/fw/orgs/acme/agents/alice',
  org: 'acme',
  projectRoot: '/tmp/fw',
};

beforeEach(() => {
  capturedOnExit = null;
  mockPty.spawn.mockClear();
  mockPty.kill.mockClear();
  mockPty.write.mockClear();
  mockPty.isAlive.mockClear();
  mockPty.isAlive.mockReturnValue(true);
  mockPty.onExit.mockClear();
  mockInjectMessage.mockClear();
  fsMocks.existsSync.mockReset().mockReturnValue(false);
  fsMocks.readFileSync.mockReset();
  fsMocks.writeFileSync.mockReset();
  fsMocks.appendFileSync.mockReset();
  fsMocks.statSync.mockReset();
});

describe('AgentProcess - BUG-011 fix (stop awaits PTY exit)', () => {
  it('stop() awaits the PTY exit handler before resolving', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    expect(capturedOnExit).not.toBeNull();
    expect(ap.getStatus().status).toBe('running');

    let stopResolved = false;
    const stopPromise = ap.stop().then(() => { stopResolved = true; });

    // Give stop() a moment to enter its kill phase. The 4s of internal sleeps
    // (1s after Ctrl-C + 3s after /exit) plus the awaitExit will keep stop()
    // in flight. After 100ms, it should NOT have resolved.
    await new Promise(r => setTimeout(r, 100));
    expect(stopResolved).toBe(false);

    // Now simulate the PTY exit firing
    capturedOnExit!(0, 0);

    // After the exit fires, stop() should be able to resolve
    // (after its internal sleeps finish — wait long enough)
    await stopPromise;
    expect(stopResolved).toBe(true);
    expect(ap.getStatus().status).toBe('stopped');
  }, 10000);

  it('stop() does NOT trigger crash recovery on intentional stop (the BUG-011 regression)', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    // Stop and have the exit fire DURING the await window
    const stopPromise = ap.stop();
    await new Promise(r => setTimeout(r, 100));
    capturedOnExit!(0, 0);
    await stopPromise;

    // The agent should be 'stopped', NOT 'crashed'.
    // Before the fix, the exit handler could fire after stopping=false and
    // call into the crash recovery branch, leaving status='crashed'.
    expect(ap.getStatus().status).toBe('stopped');
  }, 10000);

  it('handleExit DOES trigger crash recovery on UNINTENTIONAL exit (regression check)', async () => {
    // Make sure we didn't accidentally break the real crash recovery path
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    expect(ap.getStatus().status).toBe('running');

    // Fire the exit handler WITHOUT calling stop() first — simulates a real crash
    capturedOnExit!(1, 0);

    // The agent should be in 'crashed' state (crash recovery scheduled)
    expect(ap.getStatus().status).toBe('crashed');
  });

  it('unexpected PTY exit persists a CRASH line to restarts.log', async () => {
    // Default fs mocks: no .daemon-stop marker, no .crash_count_today file.
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    expect(ap.getStatus().status).toBe('running');

    // Fire exit handler WITHOUT calling stop() first — simulates a real crash.
    capturedOnExit!(1, 0);

    expect(ap.getStatus().status).toBe('crashed');
    // restarts.log must have received a CRASH entry with the exit code and
    // crash counter. Before the fix, daemon-classified crashes only wrote
    // to stdout and left restarts.log empty.
    expect(fsMocks.appendFileSync).toHaveBeenCalledTimes(1);
    const [logPath, logLine] = fsMocks.appendFileSync.mock.calls[0];
    expect(String(logPath)).toContain('/logs/alice/restarts.log');
    expect(String(logLine)).toMatch(/\] CRASH: exit_code=1 crash_count=1 backoff_s=5\b/);
    expect(String(logLine).endsWith('\n')).toBe(true);
  });

  it('PTY exit during daemon shutdown is NOT classified as a crash', async () => {
    // Simulate agent-manager.ts:stopAll() having written a fresh .daemon-stop
    // marker moments ago. handleExit should recognize the shutdown-in-progress
    // signal and bail out before touching the crash counter or restarts.log.
    fsMocks.existsSync.mockImplementation((p: any) => {
      const path = String(p);
      return path.endsWith('/state/alice/.daemon-stop');
    });
    fsMocks.statSync.mockImplementation((p: any) => ({ mtimeMs: Date.now() - 2_000 }));

    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    expect(ap.getStatus().status).toBe('running');

    // PM2 SIGTERM propagated to the PTY's Claude Code child: it exits
    // cleanly with code 0 before its own stopAgent() call has a chance to
    // set stopRequested. Before the fix, this produced a phantom crash
    // and incremented .crash_count_today.
    capturedOnExit!(0, 0);

    // Agent state is 'running' still — handleExit returned early without
    // toggling status. No crash write, no log append, no restart scheduled.
    expect(ap.getStatus().status).toBe('running');
    expect(fsMocks.appendFileSync).not.toHaveBeenCalled();
    expect(fsMocks.writeFileSync).not.toHaveBeenCalledWith(
      expect.stringContaining('.crash_count_today'),
      expect.anything(),
      expect.anything(),
    );
  });

  it('stale .daemon-stop marker (>60s old) does NOT mask a real crash', async () => {
    // Regression guard: if a prior shutdown failed to clean up its marker,
    // we do NOT want it to silently swallow genuine crashes hours later.
    // The 60s window in isDaemonShuttingDown() is the load-bearing check.
    fsMocks.existsSync.mockImplementation((p: any) =>
      String(p).endsWith('/state/alice/.daemon-stop'),
    );
    fsMocks.statSync.mockImplementation((p: any) => ({ mtimeMs: Date.now() - 3_600_000 })); // 1h old

    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    capturedOnExit!(1, 0);

    expect(ap.getStatus().status).toBe('crashed');
    expect(fsMocks.appendFileSync).toHaveBeenCalledTimes(1);
    expect(String(fsMocks.appendFileSync.mock.calls[0][1])).toMatch(/\] CRASH: /);
  });

  it('sessionRefresh() delegates to stop() then start() (in order)', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    // Spy on stop and start so we can verify the delegation
    const stopSpy = vi.spyOn(ap, 'stop').mockResolvedValue();
    const startSpy = vi.spyOn(ap, 'start').mockResolvedValue();

    await ap.sessionRefresh();

    expect(stopSpy).toHaveBeenCalled();
    expect(startSpy).toHaveBeenCalled();
    // Verify call order: stop must complete before start
    const stopOrder = stopSpy.mock.invocationCallOrder[0];
    const startOrder = startSpy.mock.invocationCallOrder[0];
    expect(stopOrder).toBeLessThan(startOrder);
  });
});

describe('AgentProcess - BUG-048 fix (session timer re-reads config)', () => {
  it('fires sessionRefresh when config on disk still matches original short duration', async () => {
    const refreshSpy = vi.fn().mockResolvedValue(undefined);

    vi.useFakeTimers();
    try {
      const ap = new AgentProcess('alice', mockEnv, { max_session_seconds: 1 });
      vi.spyOn(ap, 'sessionRefresh').mockImplementation(refreshSpy);
      await ap.start();
      await vi.advanceTimersByTimeAsync(2000);
    } finally {
      vi.useRealTimers();
    }

    expect(refreshSpy).toHaveBeenCalledOnce();
  });

  it('reschedules when config.json on disk has a longer max_session_seconds', async () => {
    const fs = await import('fs');
    const mockExistsSync = vi.mocked(fs.existsSync);
    const mockReadFileSync = vi.mocked(fs.readFileSync);

    const refreshSpy = vi.fn().mockResolvedValue(undefined);

    // Config on disk says 1 hour — much longer than initial 1s
    mockExistsSync.mockImplementation((p: unknown) =>
      typeof p === 'string' && p.endsWith('config.json'),
    );
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (typeof p === 'string' && p.endsWith('config.json')) {
        return JSON.stringify({ max_session_seconds: 3600 });
      }
      return '';
    });

    vi.useFakeTimers();
    try {
      const ap = new AgentProcess('alice', mockEnv, { max_session_seconds: 1 });
      vi.spyOn(ap, 'sessionRefresh').mockImplementation(refreshSpy);
      await ap.start();
      // Advance past the initial 1s timer — should reschedule, not fire refresh
      await vi.advanceTimersByTimeAsync(2000);
    } finally {
      vi.useRealTimers();
      mockExistsSync.mockReturnValue(false);
      mockReadFileSync.mockReset();
    }

    // sessionRefresh must NOT have been called — config said 1h, not 1s
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('does not loop when max_session_seconds overflows int32 setTimeout (regression)', async () => {
    // Without the clamp, max_session_seconds: 3600000 (1000h = 3.6T ms) would
    // exceed Node's int32 setTimeout max (~2.147B ms), get coerced to 1ms,
    // fire immediately, re-read the same overflow value, reschedule, and loop
    // tightly — locking the daemon. Clamp at the call site prevents this.
    const fs = await import('fs');
    const mockExistsSync = vi.mocked(fs.existsSync);
    const mockReadFileSync = vi.mocked(fs.readFileSync);

    const refreshSpy = vi.fn().mockResolvedValue(undefined);
    const logSpy = vi.fn();

    mockExistsSync.mockImplementation((p: unknown) =>
      typeof p === 'string' && p.endsWith('config.json'),
    );
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (typeof p === 'string' && p.endsWith('config.json')) {
        return JSON.stringify({ max_session_seconds: 3_600_000 });
      }
      return '';
    });

    vi.useFakeTimers();
    try {
      const ap = new AgentProcess('alice', mockEnv, { max_session_seconds: 3_600_000 });
      vi.spyOn(ap, 'sessionRefresh').mockImplementation(refreshSpy);
      vi.spyOn(ap as unknown as { log: (m: string) => void }, 'log').mockImplementation(logSpy);
      await ap.start();
      // Advance past the int32 setTimeout cap. Without clamp this would log
      // thousands of "rescheduling" lines as the 1ms-coerced timer keeps firing.
      await vi.advanceTimersByTimeAsync(5000);
    } finally {
      vi.useRealTimers();
      mockExistsSync.mockReturnValue(false);
      mockReadFileSync.mockReset();
    }

    const rescheduleCount = logSpy.mock.calls.filter(
      ([msg]) => typeof msg === 'string' && msg.includes('rescheduling'),
    ).length;
    expect(rescheduleCount).toBeLessThan(5);
    expect(refreshSpy).not.toHaveBeenCalled();
  });
});
