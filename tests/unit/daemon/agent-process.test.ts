import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture the PTY exit handler so tests can simulate exits at controlled times
let capturedOnExit: ((exitCode: number, signal?: number) => void) | null = null;

const mockPty = {
  spawn: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn(),
  write: vi.fn(),
  getPid: vi.fn().mockReturnValue(12345),
  isAlive: vi.fn().mockReturnValue(true),
  // Default: no rate-limit signature in output (safe for all existing tests)
  getOutputBuffer: vi.fn().mockReturnValue({ hasRateLimitSignature: () => false }),
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
  resolveAgentCwd: vi.fn((agentDir, override) => (override?.trim() || agentDir || process.cwd())),
  isAgentDirScaffolded: vi.fn().mockReturnValue(true),
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
  mockPty.getOutputBuffer.mockClear();
  mockPty.getOutputBuffer.mockReturnValue({ hasRateLimitSignature: () => false });
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

describe('AgentProcess - sessionRefresh writes .session-refresh marker', () => {
  it('sessionRefresh writes the marker synchronously before stop() can resolve', async () => {
    // hook-crash-alert.ts (SessionEnd hook) looks for a .session-refresh
    // file in the agent's stateDir to classify an exit as a planned session
    // rotation and post ♻️ instead of 🚨 CRASH. Before the fix, nothing in
    // the codebase wrote this marker — every 4h rotation fell through to
    // the default crash classification. sessionRefresh must write the
    // marker BEFORE awaiting this.stop(), so the hook sees it regardless
    // of how fast the PTY tears down.
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    // Kick off sessionRefresh. The marker write is synchronous (happens
    // before the first await inside sessionRefresh) so it MUST have
    // completed by the time the caller gets the returned promise back —
    // there is no need to await anything here.
    const refreshPromise = ap.sessionRefresh();

    const markerWrite = fsMocks.writeFileSync.mock.calls.find((call: unknown[]) => {
      const path = call[0];
      return typeof path === 'string' && path.endsWith('/.session-refresh');
    });
    expect(markerWrite).toBeDefined();
    // Second arg is the marker contents — "session timer reached limit"
    // is what hook-crash-alert reads into the `reason` field.
    expect(String(markerWrite?.[1])).toContain('session timer reached limit');

    // Clean up: fire the PTY exit so stop() can resolve, and let
    // sessionRefresh finish without leaving a dangling promise. Any
    // subsequent failure inside the mock re-spawn path is irrelevant —
    // the assertion above already fired.
    if (capturedOnExit) capturedOnExit(129, 0);
    refreshPromise.catch(() => { /* test done */ });
  }, 10000);
});

// ---------------------------------------------------------------------------
// Regression: updateRotationResumeSuccess() called after restart (2b63494)
// ---------------------------------------------------------------------------
//
// Bug: writeRotationEvent() inserted a row with resume_success=null but
// there was no follow-up PATCH once the new session was confirmed running.
// Fix: updateRotationResumeSuccess() is called after start() in both
// sessionRefresh() and crash recovery. These tests verify the call happens.

describe('AgentProcess - updateRotationResumeSuccess called after restart (2b63494)', () => {
  it('sessionRefresh() calls updateRotationResumeSuccess() after start() completes', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    // Spy on the private method — it should be called after start() in sessionRefresh
    const rrsSpy = vi.spyOn(ap as unknown as { updateRotationResumeSuccess: () => Promise<void> }, 'updateRotationResumeSuccess')
      .mockResolvedValue(undefined);

    // Mock stop() so we don't need PTY teardown gymnastics
    vi.spyOn(ap, 'stop').mockResolvedValue();
    // Mock start() so PTY re-spawn succeeds synchronously
    vi.spyOn(ap, 'start').mockResolvedValue();

    await ap.sessionRefresh();

    expect(rrsSpy).toHaveBeenCalledOnce();
  });

  it('crash recovery restart calls updateRotationResumeSuccess() after start()', async () => {
    vi.useFakeTimers();
    try {
      const ap = new AgentProcess('alice', mockEnv, {});
      await ap.start();
      expect(ap.getStatus().status).toBe('running');

      const rrsSpy = vi.spyOn(ap as unknown as { updateRotationResumeSuccess: () => Promise<void> }, 'updateRotationResumeSuccess')
        .mockResolvedValue(undefined);

      // Simulate crash (unintentional exit)
      capturedOnExit!(1, 0);
      expect(ap.getStatus().status).toBe('crashed');

      // Advance past the backoff (crash #1 = 5s) to trigger the restart setTimeout
      await vi.advanceTimersByTimeAsync(6000);

      expect(rrsSpy).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  }, 15000);
});

describe('AgentProcess — CrashLoopPauser (instar-inspired sliding window)', () => {
  it('triggers CRASH_LOOP halt when crash_window fills', async () => {
    const ap = new AgentProcess('alice', mockEnv, {
      crash_window: { seconds: 60, max_crashes: 3 },
    });
    await ap.start();

    // Fire 3 crashes in rapid succession (well within the 60s window).
    capturedOnExit!(1, 0);
    expect(ap.getStatus().status).toBe('crashed'); // first crash — normal recovery

    // Reset mocks and simulate the restart + second crash
    mockPty.spawn.mockClear();
    mockPty.onExit.mockClear();
    capturedOnExit = null;
    await ap.start();
    capturedOnExit!(1, 0);
    expect(ap.getStatus().status).toBe('crashed'); // second crash — still normal

    mockPty.spawn.mockClear();
    mockPty.onExit.mockClear();
    capturedOnExit = null;
    await ap.start();
    capturedOnExit!(1, 0);
    // Third crash in window → CRASH_LOOP → halted
    expect(ap.getStatus().status).toBe('halted');
  });

  it('does not trigger CRASH_LOOP when no crash_window is configured (backward compat)', async () => {
    const ap = new AgentProcess('alice', mockEnv, {
      max_crashes_per_day: 5,
    });
    await ap.start();

    // 3 crashes — without crash_window, these are just normal crash recovery
    for (let i = 0; i < 3; i++) {
      capturedOnExit!(1, 0);
      if (ap.getStatus().status !== 'halted') {
        mockPty.spawn.mockClear();
        mockPty.onExit.mockClear();
        capturedOnExit = null;
        await ap.start();
      }
    }
    // Should be 'crashed' (recovering), NOT 'halted', because daily max is 5
    expect(ap.getStatus().status).not.toBe('halted');
  });
});

// ---------------------------------------------------------------------------
// Premature-voluntary-exit guard
// ---------------------------------------------------------------------------
//
// Symptom (Greg, 2026-05-28): orchestrator agent restart-looping for an hour.
// Inside the claude session, a prompt or handoff doc contained `/exit`, which
// exits cleanly (code 0, no signal). The daemon classified the clean exit as
// a crash, restarted with 5s→10s→20s→40s→80s exponential backoff, and
// re-injected the same prompt each time — re-triggering the same /exit. The
// watchdog circuit-breaker tripped within minutes.
//
// Fix: detect clean exits with uptime < threshold + no markers as "premature
// voluntary exits." Back off LONGER (default 5 min), do NOT increment the
// crash counter, and HALT after N premature exits inside a sliding window
// (rapid restart will just re-trigger the same prompt path).
describe('AgentProcess — premature voluntary exit guard', () => {
  it('classifies a clean code-0 exit with short uptime as premature (does not crash-count)', async () => {
    vi.useFakeTimers();
    try {
      const ap = new AgentProcess('alice', mockEnv, {
        // Tight window to keep the test fast: 2 premature exits in 60s halts.
        premature_exit_window: { seconds: 60, max_exits: 2, threshold_seconds: 30, backoff_seconds: 60 },
      });
      await ap.start();
      expect(ap.getStatus().status).toBe('running');
      const before = ap.getStatus().crashCount ?? 0;

      // Simulate `/exit` inside the claude session: clean exit, no signal,
      // uptime well under the 30s threshold.
      capturedOnExit!(0, 0);

      // Status flips to 'crashed' so the dashboard's existing restart UI works,
      // but the underlying classification is premature-exit (not a real crash).
      expect(ap.getStatus().status).toBe('crashed');
      // crashCount MUST NOT have been incremented — premature exits live in
      // their own counter. Otherwise rapid `/exit` events would exhaust
      // max_crashes_per_day in minutes and HALT the agent for the wrong reason.
      expect(ap.getStatus().crashCount).toBe(before);

      // The classification line landed in restarts.log with the
      // PREMATURE_EXIT kind, not CRASH.
      expect(fsMocks.appendFileSync).toHaveBeenCalledTimes(1);
      const [logPath, logLine] = fsMocks.appendFileSync.mock.calls[0];
      expect(String(logPath)).toContain('/logs/alice/restarts.log');
      expect(String(logLine)).toMatch(/\] PREMATURE_EXIT: exit_code=0 premature_exits=1\b/);
      expect(String(logLine)).toMatch(/backoff_s=60\b/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the configured longer backoff for premature exits (not exponential 5s)', async () => {
    vi.useFakeTimers();
    try {
      const startSpy = vi.fn().mockResolvedValue(undefined);
      const ap = new AgentProcess('alice', mockEnv, {
        premature_exit_window: { seconds: 600, max_exits: 3, threshold_seconds: 60, backoff_seconds: 300 },
      });
      await ap.start();

      // Spy AFTER initial start so the restart-scheduled start() is observable
      vi.spyOn(ap, 'start').mockImplementation(startSpy);

      capturedOnExit!(0, 0);
      expect(ap.getStatus().status).toBe('crashed');

      // Normal crash backoff for crash #1 is 5s. Advance 30s — start() must
      // NOT have been called yet (premature backoff is 5 min).
      await vi.advanceTimersByTimeAsync(30_000);
      expect(startSpy).not.toHaveBeenCalled();

      // Advance to just past 5 min — restart fires.
      await vi.advanceTimersByTimeAsync(280_000);
      expect(startSpy).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('halts the agent after max_exits premature exits in the sliding window', async () => {
    const ap = new AgentProcess('alice', mockEnv, {
      premature_exit_window: { seconds: 600, max_exits: 3, threshold_seconds: 30, backoff_seconds: 60 },
    });
    await ap.start();

    // Premature exit #1 — should keep us in crashed, schedule a restart
    capturedOnExit!(0, 0);
    expect(ap.getStatus().status).toBe('crashed');

    // Restart and fire premature exit #2
    mockPty.spawn.mockClear();
    mockPty.onExit.mockClear();
    capturedOnExit = null;
    await ap.start();
    capturedOnExit!(0, 0);
    expect(ap.getStatus().status).toBe('crashed');

    // Restart and fire premature exit #3 — halts (manual intervention required)
    mockPty.spawn.mockClear();
    mockPty.onExit.mockClear();
    capturedOnExit = null;
    await ap.start();
    capturedOnExit!(0, 0);
    expect(ap.getStatus().status).toBe('halted');

    // The HALT line landed in restarts.log as PREMATURE_EXIT_LOOP
    const lastCall = fsMocks.appendFileSync.mock.calls.at(-1);
    expect(String(lastCall?.[1])).toMatch(/\] PREMATURE_EXIT_LOOP: /);
  });

  it('a non-zero exit code is NOT treated as premature (real crashes still crash)', async () => {
    const ap = new AgentProcess('alice', mockEnv, {
      premature_exit_window: { seconds: 600, max_exits: 3 },
    });
    await ap.start();
    const beforeCrash = ap.getStatus().crashCount ?? 0;

    // exit_code=1 (real failure), uptime well below threshold — must NOT
    // be classified as premature even though the timing matches.
    capturedOnExit!(1, 0);

    expect(ap.getStatus().status).toBe('crashed');
    // crashCount went up by 1 — this is a real crash, not a premature exit.
    expect(ap.getStatus().crashCount).toBe(beforeCrash + 1);

    // restarts.log got a CRASH line, not PREMATURE_EXIT
    const lastCall = fsMocks.appendFileSync.mock.calls.at(-1);
    expect(String(lastCall?.[1])).toMatch(/\] CRASH: exit_code=1\b/);
  });

  it('a signal-terminated exit (signal != 0) is NOT premature', async () => {
    const ap = new AgentProcess('alice', mockEnv, {
      premature_exit_window: { seconds: 600, max_exits: 3 },
    });
    await ap.start();
    const beforeCrash = ap.getStatus().crashCount ?? 0;

    // exit_code=0 but signal=15 (SIGTERM) — process was killed, not a
    // voluntary /exit. Falls through to the normal crash branch.
    capturedOnExit!(0, 15);

    expect(ap.getStatus().status).toBe('crashed');
    expect(ap.getStatus().crashCount).toBe(beforeCrash + 1);
  });

  it('seconds:0 disables the guard entirely (clean exit treated as crash)', async () => {
    const ap = new AgentProcess('alice', mockEnv, {
      premature_exit_window: { seconds: 0 },
    });
    await ap.start();
    const beforeCrash = ap.getStatus().crashCount ?? 0;

    capturedOnExit!(0, 0);

    // With the guard disabled, a clean exit is just a code-0 crash again.
    expect(ap.getStatus().status).toBe('crashed');
    expect(ap.getStatus().crashCount).toBe(beforeCrash + 1);
    const lastCall = fsMocks.appendFileSync.mock.calls.at(-1);
    expect(String(lastCall?.[1])).toMatch(/\] CRASH: /);
  });

  it('default configuration (no premature_exit_window) still activates the guard with defaults', async () => {
    // No premature_exit_window in config = guard ON with built-in defaults
    // (10 min window, 3 max exits, 60s threshold, 5 min backoff). This keeps
    // the fleet-wide footgun guarded without operators needing to opt in.
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    capturedOnExit!(0, 0);

    // Classified as premature, not as a real crash
    expect(ap.getStatus().status).toBe('crashed');
    const lastCall = fsMocks.appendFileSync.mock.calls.at(-1);
    expect(String(lastCall?.[1])).toMatch(/\] PREMATURE_EXIT: /);
  });
});
