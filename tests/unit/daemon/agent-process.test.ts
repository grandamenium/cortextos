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

const mockCheckNodeModulesMtime = vi.fn().mockReturnValue({ stale: false });
vi.mock('../../../src/utils/node-modules-mtime.js', () => ({
  checkNodeModulesMtime: mockCheckNodeModulesMtime,
}));

const mockLogEvent = vi.fn();
vi.mock('../../../src/bus/event.js', () => ({
  logEvent: mockLogEvent,
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
  mockCheckNodeModulesMtime.mockReset().mockReturnValue({ stale: false });
  mockLogEvent.mockReset();
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

// Theta-wave 2026-05-15: crash-notification idle-gating. exit_code=0 with a
// fresh heartbeat is a clean idle exit, not a crash. The gate suppresses the
// crash-budget bump, the CRASH row, and the Telegram alert that follows them,
// while preserving the audit trail via an IDLE-EXIT line and an auto-restart.
describe('AgentProcess - idle-exit gate (theta-wave 2026-05-15)', () => {
  // Stub readHeartbeatStatus's fs read so each test can dictate heartbeat age.
  // The helper reads `${ctxRoot}/state/${name}/heartbeat.json` and computes
  // age from `last_heartbeat`. Wiring an ISO timestamp `now - ageMs` here
  // gives the gate exactly the heartbeat age the test wants.
  function mockHeartbeatAgeMs(ageMs: number): void {
    const ts = new Date(Date.now() - ageMs).toISOString();
    const heartbeatJson = JSON.stringify({ last_heartbeat: ts, current_task: '' });
    fsMocks.existsSync.mockImplementation((p: any) =>
      String(p).endsWith('/state/alice/heartbeat.json'),
    );
    fsMocks.readFileSync.mockImplementation((p: any) => {
      if (String(p).endsWith('/state/alice/heartbeat.json')) return heartbeatJson;
      return '';
    });
  }

  it('exitCode=0 + fresh heartbeat → idle path (no CRASH, no crash-bump, no Telegram trigger)', async () => {
    mockHeartbeatAgeMs(5 * 60_000); // 5 min — well inside the 30-min gate.

    const ap = new AgentProcess('alice', mockEnv, {});
    const statusEvents: string[] = [];
    ap.onStatusChanged((s) => statusEvents.push(s.status));
    await ap.start();

    capturedOnExit!(0, 0);

    // Status transitions to 'stopped' (not 'crashed') — the Telegram
    // subscriber in agent-manager.onStatusChanged only fires on 'crashed'
    // and 'halted', so a 'stopped' transition naturally skips the alert.
    expect(ap.getStatus().status).toBe('stopped');
    expect(statusEvents).toContain('stopped');
    expect(statusEvents).not.toContain('crashed');
    // Crash budget untouched — this exit is NOT charged to the daily cap.
    expect(ap.getStatus().crashCount ?? 0).toBe(0);
    // Audit row IS written so operators can still see every PTY exit, but
    // with kind=IDLE-EXIT so log scanners can distinguish from real crashes.
    // Matching by-content (not by call count) keeps the test resilient if a
    // future change adds a sibling write inside the IDLE-EXIT branch.
    const idleRows = fsMocks.appendFileSync.mock.calls
      .filter(([p]) => String(p).endsWith('/logs/alice/restarts.log'))
      .map(([, line]) => String(line))
      .filter(line => /\] IDLE-EXIT: exit_code=0 hb_age_s=\d+ backoff_s=5\b/.test(line));
    expect(idleRows).toHaveLength(1);
    // And NO CRASH row was written (the gate's whole point).
    const crashRows = fsMocks.appendFileSync.mock.calls
      .map(([, line]) => String(line))
      .filter(line => /\] CRASH: /.test(line));
    expect(crashRows).toEqual([]);
  });

  it('exitCode=0 + stale heartbeat → crash path (gate fails open — real CRASH)', async () => {
    // 45 min ≥ 30-min gate window. This is the genuine-crash-with-zero-exit
    // shape: the agent stopped heartbeating before the exit, so the gate
    // refuses to swallow the alert.
    mockHeartbeatAgeMs(45 * 60_000);

    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    capturedOnExit!(0, 0);

    expect(ap.getStatus().status).toBe('crashed');
    expect(ap.getStatus().crashCount).toBe(1);
    expect(fsMocks.appendFileSync).toHaveBeenCalledTimes(1);
    expect(String(fsMocks.appendFileSync.mock.calls[0][1])).toMatch(/\] CRASH: exit_code=0/);
  });

  it('exitCode≠0 + fresh heartbeat → crash path (gate keyed on BOTH conditions)', async () => {
    // Heartbeat freshness alone must NOT swallow a non-zero exit — that's a
    // genuine crash the operator needs to see, regardless of heartbeat state.
    mockHeartbeatAgeMs(2 * 60_000);

    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    capturedOnExit!(1, 0);

    expect(ap.getStatus().status).toBe('crashed');
    expect(ap.getStatus().crashCount).toBe(1);
    expect(String(fsMocks.appendFileSync.mock.calls[0][1])).toMatch(/\] CRASH: exit_code=1/);
  });

  it('stopRequested=true + exit=0 → existing short-circuit still wins (gate never runs)', async () => {
    // Planned shutdown (HARD-RESTART / stop()): the stopRequested guard fires
    // before the idle-exit gate. No IDLE-EXIT row, no CRASH row, no restart.
    mockHeartbeatAgeMs(5 * 60_000); // would otherwise trigger the idle gate

    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    const stopPromise = ap.stop();
    await new Promise(r => setTimeout(r, 50));
    capturedOnExit!(0, 0);
    await stopPromise;

    expect(ap.getStatus().status).toBe('stopped');
    // The IDLE-EXIT branch must NOT have written to restarts.log — only
    // the stopRequested short-circuit fired.
    const writtenKinds = fsMocks.appendFileSync.mock.calls
      .map(([, line]) => String(line))
      .filter(line => /\] (CRASH|IDLE-EXIT): /.test(line));
    expect(writtenKinds).toEqual([]);
  }, 10000);

  it('exit=0 + missing heartbeat file → CRASH path (gate fails open)', async () => {
    // Load-bearing safety net: heartbeatAgeMs() returns MAX_SAFE_INTEGER when
    // heartbeat.json is missing. Without this, an agent that crashed on its
    // first cycle (before ever writing a heartbeat) would be silently swallowed
    // by the gate. This test pins the fail-open contract that the JSDoc
    // documents — if someone later "fixes" the missing-file case to return 0
    // (looks fresh), real crashes get masked.
    fsMocks.existsSync.mockReturnValue(false); // no heartbeat.json on disk

    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    capturedOnExit!(0, 0);

    expect(ap.getStatus().status).toBe('crashed');
    expect(ap.getStatus().crashCount).toBe(1);
    const idleRows = fsMocks.appendFileSync.mock.calls
      .map(([, line]) => String(line))
      .filter(line => /\] IDLE-EXIT: /.test(line));
    expect(idleRows).toEqual([]);
    const crashRows = fsMocks.appendFileSync.mock.calls
      .map(([, line]) => String(line))
      .filter(line => /\] CRASH: exit_code=0/.test(line));
    expect(crashRows).toHaveLength(1);
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

// Issue #07 fix: pty.spawn() rejection (e.g. `posix_spawnp failed` after a
// pnpm install stales the daemon's node-pty binding) used to leave the agent
// silently stuck in 'crashed' state forever. These tests guard the symmetry
// with handleExit: bounded retry, SPAWN-FAIL row, HALT at maxCrashesPerDay,
// side-channel callback for the cross-agent storm detector.
describe('AgentProcess - issue #07: pty.spawn() failure recovery', () => {
  it('records SPAWN-FAIL to restarts.log and schedules a retry', async () => {
    mockPty.spawn.mockRejectedValueOnce(new Error('posix_spawnp failed.'));
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    expect(ap.getStatus().status).toBe('crashed');
    expect(ap.getStatus().crashCount).toBe(1);
    // restarts.log must have a SPAWN-FAIL row carrying the error signature
    // and the backoff window the operator can expect.
    expect(fsMocks.appendFileSync).toHaveBeenCalledTimes(1);
    const [logPath, logLine] = fsMocks.appendFileSync.mock.calls[0];
    expect(String(logPath)).toContain('/logs/alice/restarts.log');
    expect(String(logLine)).toMatch(/\] SPAWN-FAIL: crash_count=1 backoff_s=5 err=.*posix_spawnp failed/);
  });

  it('fires onSpawnFailureRaised with the err signature before status change', async () => {
    mockPty.spawn.mockRejectedValueOnce(new Error('posix_spawnp failed.'));

    const ap = new AgentProcess('alice', mockEnv, {});
    const callOrder: string[] = [];
    let capturedSig: string | null = null;
    ap.onSpawnFailureRaised(sig => { callOrder.push('spawn-fail'); capturedSig = sig; });
    ap.onStatusChanged(() => { callOrder.push('status-change'); });

    await ap.start();

    // Storm detector must hear BEFORE the alert handler — that's how the
    // alert handler picks the spawn-fail-specific message over the generic
    // "auto-restarting" one.
    expect(callOrder[0]).toBe('spawn-fail');
    expect(callOrder).toContain('status-change');
    expect(capturedSig).toMatch(/posix_spawnp failed/);
  });

  it('schedules retry with exponential backoff and triggers it after the window', async () => {
    vi.useFakeTimers();
    try {
      // First spawn fails, second succeeds — covers a transient resource
      // failure (e.g. EAGAIN) that resolves between retries.
      mockPty.spawn
        .mockRejectedValueOnce(new Error('posix_spawnp failed.'))
        .mockResolvedValueOnce(undefined);

      const ap = new AgentProcess('alice', mockEnv, {});
      await ap.start();
      expect(ap.getStatus().status).toBe('crashed');

      // Advance just past 5s (crash #1 backoff) — second spawn fires, succeeds.
      await vi.advanceTimersByTimeAsync(5100);
      expect(mockPty.spawn).toHaveBeenCalledTimes(2);
      expect(ap.getStatus().status).toBe('running');
    } finally {
      vi.useRealTimers();
    }
  });

  it('HALTS at max_crashes_per_day and writes SPAWN-FAIL-HALTED', async () => {
    // max=2 → first failure schedules retry (crashCount becomes 1, halt
    // gate not yet tripped). Construct an agent that's ALREADY one crash
    // away from halt to keep the test concise.
    mockPty.spawn.mockRejectedValueOnce(new Error('posix_spawnp failed.'));
    const ap = new AgentProcess('alice', mockEnv, { max_crashes_per_day: 1 });

    await ap.start();

    expect(ap.getStatus().status).toBe('halted');
    expect(fsMocks.appendFileSync).toHaveBeenCalledTimes(1);
    const [, logLine] = fsMocks.appendFileSync.mock.calls[0];
    expect(String(logLine)).toMatch(/\] SPAWN-FAIL-HALTED: crash_count=1 max_crashes=1 err=.*posix_spawnp failed/);
  });

  it('does NOT retry or increment crashCount when stop is in flight', async () => {
    // Operator-initiated teardown that races with a spawn failure: we should
    // record the failure (storm detector still cares) but not schedule a
    // recovery — the user asked to stop.
    mockPty.spawn.mockImplementationOnce(async () => {
      // Simulate concurrent stop() while spawn is in flight. We poke the
      // internal flag directly because triggering it via the public API in
      // a single synchronous tick is awkward and not what we're testing.
      (ap as unknown as { stopRequested: boolean }).stopRequested = true;
      throw new Error('posix_spawnp failed.');
    });
    const ap = new AgentProcess('alice', mockEnv, {});

    await ap.start();

    expect(ap.getStatus().status).toBe('crashed');
    expect(ap.getStatus().crashCount ?? 0).toBe(0);
    // No restarts.log row, no .crash_count_today increment — this is a
    // stop-race, not a real crash from the agent's perspective.
    expect(fsMocks.appendFileSync).not.toHaveBeenCalled();
    // Regression guard: stopRequested must be CLEARED as we consume it.
    // If left latched, the next legitimate crash would also take the
    // teardown branch and get silently eaten as "intentional stop".
    expect((ap as unknown as { stopRequested: boolean }).stopRequested).toBe(false);
  });

  it('does NOT retry during daemon shutdown', async () => {
    fsMocks.existsSync.mockImplementation((p: unknown) =>
      typeof p === 'string' && p.endsWith('/state/alice/.daemon-stop'),
    );
    fsMocks.statSync.mockImplementation(() => ({ mtimeMs: Date.now() - 2_000 } as never));
    mockPty.spawn.mockRejectedValueOnce(new Error('posix_spawnp failed.'));

    const ap = new AgentProcess('alice', mockEnv, {});
    let spawnFailHeard = false;
    ap.onSpawnFailureRaised(() => { spawnFailHeard = true; });

    await ap.start();

    // Storm detector still hears — a stale binding caused this regardless of
    // why we were starting an agent. But no per-agent retry / crash count
    // increment, because the daemon is on its way down.
    expect(spawnFailHeard).toBe(true);
    expect(ap.getStatus().status).toBe('crashed');
    expect(ap.getStatus().crashCount ?? 0).toBe(0);
    expect(fsMocks.appendFileSync).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Fleet-resilience #5 — getStatusDeep() wiring.
// Helper-level behaviour is exercised in tests/unit/utils/agent-status.test.ts;
// here we just confirm AgentProcess routes the deep-health helpers and stays
// crash-free when every on-disk state file is missing (the mock returns
// existsSync=false unconditionally).
// ---------------------------------------------------------------------------
describe('AgentProcess - issue #07 follow-up #5: getStatusDeep wiring', () => {
  it('getStatus() returns the cheap shape — none of the deep-health fields populated', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    const s = ap.getStatus();
    expect(s.name).toBe('alice');
    expect(s.status).toBe('running');
    expect(s.lastHeartbeatAgeSeconds).toBeUndefined();
    expect(s.crashCountToday).toBeUndefined();
    expect(s.lastRestartKind).toBeUndefined();
    expect(s.lastSpawnFailureAgeSeconds).toBeUndefined();
  });

  it('onStatusChanged is multi-subscriber — every registered handler fires', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    const calls: string[] = [];
    ap.onStatusChanged((s) => calls.push(`a:${s.status}`));
    ap.onStatusChanged((s) => calls.push(`b:${s.status}`));
    ap.onStatusChanged((s) => calls.push(`c:${s.status}`));
    await ap.start();
    // start() runs notifyStatusChange for each transition; we just need at
    // least one fan-out to confirm all three handlers fired.
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls.some((c) => c.startsWith('a:'))).toBe(true);
    expect(calls.some((c) => c.startsWith('b:'))).toBe(true);
    expect(calls.some((c) => c.startsWith('c:'))).toBe(true);
  });

  it('a throwing onStatusChanged handler does not abort the rest of the chain', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    const calls: string[] = [];
    ap.onStatusChanged(() => { throw new Error('boom'); });
    ap.onStatusChanged((s) => calls.push(`b:${s.status}`));
    await ap.start();
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  it('getStatusDeep() returns crash-budget + null-spawn-failure even with empty state dir', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    const s = ap.getStatusDeep();
    expect(s.name).toBe('alice');
    expect(s.status).toBe('running');
    // No heartbeat/restart/inbox state on disk → fields stay undefined.
    expect(s.lastHeartbeatAgeSeconds).toBeUndefined();
    expect(s.lastHeartbeatTask).toBeUndefined();
    expect(s.lastInboxMessageAgeSeconds).toBeUndefined();
    expect(s.lastRestartKind).toBeUndefined();
    expect(s.lastRestartReason).toBeUndefined();
    // Crash-budget always populates from in-memory fallback.
    expect(s.crashCountToday).toBe(0);
    expect(s.maxCrashesPerDay).toBe(10);
    expect(s.crashesRemaining).toBe(10);
    // No spawn-failure history file → null (definitively no event), not undefined.
    expect(s.lastSpawnFailureAgeSeconds).toBeNull();
  });
});

describe('AgentProcess - fleet-resilience #7 (crash-budget reset on planned restart)', () => {
  it('markPlannedRestart() + start() with accrued crashes zeros .crash_count_today and emits CRASH-RESET', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    // Simulate 9 accrued crashes today (would normally come from prior
    // handleExit calls). Setting directly keeps the test focused on the
    // reset path itself; the crash-accumulation path is covered by the
    // BUG-011 / Issue #07 tests above.
    (ap as unknown as { crashCount: number }).crashCount = 9;

    ap.markPlannedRestart();
    await ap.start();

    expect(ap.getStatus().crashCount).toBe(0);

    // .crash_count_today overwritten with <today>:0 (NOT incremented).
    const today = new Date().toISOString().split('T')[0];
    expect(fsMocks.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('.crash_count_today'),
      `${today}:0`,
      'utf-8',
    );

    // restarts.log gets a CRASH-RESET audit line with from-count + reason.
    expect(fsMocks.appendFileSync).toHaveBeenCalledTimes(1);
    const [logPath, logLine] = fsMocks.appendFileSync.mock.calls[0];
    expect(String(logPath)).toContain('/logs/alice/restarts.log');
    expect(String(logLine)).toMatch(/\] CRASH-RESET: from=9 reason=planned_restart\b/);
    expect(String(logLine).endsWith('\n')).toBe(true);

    // logEvent fires with the canonical action + meta.
    expect(mockLogEvent).toHaveBeenCalledTimes(1);
    const [, agentArg, , category, action, severity, meta] = mockLogEvent.mock.calls[0];
    expect(agentArg).toBe('alice');
    expect(category).toBe('action');
    expect(action).toBe('crash_budget_reset');
    expect(severity).toBe('info');
    expect(meta).toEqual({ agent: 'alice', from_count: 9, reason: 'planned_restart' });
  });

  it('markPlannedRestart() + start() with crashCount=0 is a no-op (no write, no append, no event)', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    ap.markPlannedRestart();
    await ap.start();

    expect(ap.getStatus().crashCount).toBe(0);
    // No .crash_count_today write attributable to reset (start() normally
    // doesn't write to it on the happy path — only handleExit does).
    expect(fsMocks.writeFileSync).not.toHaveBeenCalledWith(
      expect.stringContaining('.crash_count_today'),
      expect.anything(),
      expect.anything(),
    );
    expect(fsMocks.appendFileSync).not.toHaveBeenCalled();
    expect(mockLogEvent).not.toHaveBeenCalled();
  });

  it('start() WITHOUT markPlannedRestart does NOT reset accrued crashes', async () => {
    // Crash auto-restart path: handleExit → setTimeout → this.start(). That
    // call goes directly to start() and never touches markPlannedRestart, so
    // the flag stays false and the budget keeps accruing toward maxCrashesPerDay.
    const ap = new AgentProcess('alice', mockEnv, {});
    (ap as unknown as { crashCount: number }).crashCount = 5;

    await ap.start();

    expect(ap.getStatus().crashCount).toBe(5);
    expect(fsMocks.appendFileSync).not.toHaveBeenCalled();
    expect(mockLogEvent).not.toHaveBeenCalled();
  });

  it('markPlannedRestart flag is consumed (not sticky across lifecycles)', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    (ap as unknown as { crashCount: number }).crashCount = 3;

    ap.markPlannedRestart();
    await ap.start();
    expect(mockLogEvent).toHaveBeenCalledTimes(1);
    mockLogEvent.mockClear();
    fsMocks.appendFileSync.mockClear();

    // Simulate a crash to bump the counter again, then a non-planned restart
    // (e.g. the auto-restart timer firing). The previous markPlannedRestart()
    // must NOT carry over.
    (ap as unknown as { crashCount: number }).crashCount = 2;
    (ap as unknown as { status: string }).status = 'crashed';
    await ap.start();

    expect(ap.getStatus().crashCount).toBe(2);
    expect(fsMocks.appendFileSync).not.toHaveBeenCalled();
    expect(mockLogEvent).not.toHaveBeenCalled();
  });
});

describe('AgentProcess - fleet-resilience #8 (node_modules mtime warning)', () => {
  const daemonStartedAt = new Date('2026-05-15T10:00:00Z');

  it('emits node_modules_mtime_warning + log line when checker reports stale', async () => {
    const staleMtime = new Date('2026-05-15T10:05:00Z');
    mockCheckNodeModulesMtime.mockReturnValue({ stale: true, mtime: staleMtime });

    const logs: string[] = [];
    const ap = new AgentProcess('alice', mockEnv, {}, (m) => logs.push(m), daemonStartedAt);
    await ap.start();

    expect(mockCheckNodeModulesMtime).toHaveBeenCalledWith(mockEnv.frameworkRoot, daemonStartedAt);
    expect(logs.some((l) => l.includes('node_modules newer than daemon start'))).toBe(true);
    expect(mockLogEvent).toHaveBeenCalledTimes(1);
    const [, agentArg, , category, action, severity, meta] = mockLogEvent.mock.calls[0];
    expect(agentArg).toBe('alice');
    expect(category).toBe('action');
    expect(action).toBe('node_modules_mtime_warning');
    expect(severity).toBe('warning');
    expect(meta).toEqual({
      agent: 'alice',
      node_modules_mtime: staleMtime.toISOString(),
      daemon_started_at: daemonStartedAt.toISOString(),
    });
  });

  it('is silent when checker reports fresh mtime', async () => {
    mockCheckNodeModulesMtime.mockReturnValue({ stale: false });

    const logs: string[] = [];
    const ap = new AgentProcess('alice', mockEnv, {}, (m) => logs.push(m), daemonStartedAt);
    await ap.start();

    expect(mockCheckNodeModulesMtime).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => l.includes('node_modules newer than daemon start'))).toBe(false);
    expect(mockLogEvent).not.toHaveBeenCalled();
  });

  it('skips the check entirely when daemonStartedAt is omitted (unit-test friendly)', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    expect(mockCheckNodeModulesMtime).not.toHaveBeenCalled();
    expect(mockLogEvent).not.toHaveBeenCalled();
  });

  it('does not throw if the checker throws (telemetry must never block boot)', async () => {
    mockCheckNodeModulesMtime.mockImplementation(() => {
      throw new Error('disk on fire');
    });

    const ap = new AgentProcess('alice', mockEnv, {}, undefined, daemonStartedAt);
    await expect(ap.start()).resolves.toBeUndefined();
    expect(ap.getStatus().status).toBe('running');
    expect(mockLogEvent).not.toHaveBeenCalled();
  });
});
