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
  resolvePaths: vi.fn().mockReturnValue({ stateDir: '/tmp/test-ctx/state/alice' }),
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

// SYS-1M-DETECT: the MODEL_BILLING_CONFIG escalation shells out to
// `cortextos bus send-message platform-director ...` via execFileSync. Mock it
// so tests never spawn a real process and can assert escalate-once behaviour.
const mockExecFileSync = vi.fn();
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
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
  mockExecFileSync.mockClear();
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

  it('sessionRefresh() writes .session-refresh marker before stop (false-crash FP fix)', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    const stopSpy = vi.spyOn(ap, 'stop').mockResolvedValue();
    vi.spyOn(ap, 'start').mockResolvedValue();
    fsMocks.writeFileSync.mockReset();

    await ap.sessionRefresh();

    const writeIdx = fsMocks.writeFileSync.mock.calls.findIndex(
      (call) => String(call[0]).endsWith('.session-refresh'),
    );
    expect(writeIdx).toBeGreaterThanOrEqual(0);
    expect(String(fsMocks.writeFileSync.mock.calls[writeIdx][0])).toBe('/tmp/test-ctx/state/alice/.session-refresh');
    // The marker must be written BEFORE stop() — a SessionEnd hook firing as
    // the PTY dies must already see the marker, or it classifies a false crash.
    const markerWriteOrder = fsMocks.writeFileSync.mock.invocationCallOrder[writeIdx];
    expect(markerWriteOrder).toBeLessThan(stopSpy.mock.invocationCallOrder[0]);
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

describe('AgentProcess — context exhaustion auto-recovery (SYS-DAEMON-CTX-01)', () => {
  it('detects "100% context used" and restarts fresh without charging crash counter', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    expect(ap.getStatus().status).toBe('running');

    // Simulate tailStdoutLog returning context exhaustion signal
    vi.spyOn(ap as any, 'tailStdoutLog').mockReturnValue('100% context used');

    // Exit 0 — same as real context exhaustion
    capturedOnExit!(0, 0);

    // Must be in 'crashed' state (restart scheduled)
    expect(ap.getStatus().status).toBe('crashed');

    // .force-fresh marker must be written so the next start() skips --continue
    expect(fsMocks.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('.force-fresh'),
      expect.stringContaining('context-exhaustion'),
      'utf-8',
    );

    // restarts.log must record CONTEXT_EXHAUSTION_RECOVERY, not CRASH
    expect(fsMocks.appendFileSync).toHaveBeenCalledTimes(1);
    const [logPath, logLine] = fsMocks.appendFileSync.mock.calls[0];
    expect(String(logPath)).toContain('/logs/alice/restarts.log');
    expect(String(logLine)).toContain('CONTEXT_EXHAUSTION_RECOVERY');
    expect(String(logLine)).toContain('not counted toward max_crashes');
    // Crash counter must NOT have been incremented
    expect(ap.getCrashCount()).toBe(0);
  });

  // NOTE: the 1M-context billing strings ("Extra usage is required for 1M
  // context" / "Usage credits required for 1M context") are deliberately NOT
  // tested here — they are a CONFIG class, handled by the MODEL_BILLING_CONFIG
  // describe block below. A prior version of this test asserted the old 1M
  // string => CONTEXT_EXHAUSTION_RECOVERY, which ENCODED the SYS-1M-DETECT bug
  // (force-fresh on a billing gate = restart loop). See the anti-collapse test.

  it('detects "conversation too long" compaction failure', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    vi.spyOn(ap as any, 'tailStdoutLog').mockReturnValue(
      'conversation too long to continue without compaction',
    );
    capturedOnExit!(0, 0);

    expect(ap.getStatus().status).toBe('crashed');
    const [, logLine] = fsMocks.appendFileSync.mock.calls[0];
    expect(String(logLine)).toContain('CONTEXT_EXHAUSTION_RECOVERY');
    expect(ap.getCrashCount()).toBe(0);
  });

  it('ANSI-stripped context string is still detected', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    // Simulate TUI status bar with ANSI escape codes around the text
    vi.spyOn(ap as any, 'tailStdoutLog').mockReturnValue(
      '\x1b[32m100% context used\x1b[0m',
    );
    capturedOnExit!(0, 0);

    expect(ap.getStatus().status).toBe('crashed');
    const [, logLine] = fsMocks.appendFileSync.mock.calls[0];
    expect(String(logLine)).toContain('CONTEXT_EXHAUSTION_RECOVERY');
  });

  it('clean exit 0 WITHOUT context signal goes through regular crash path', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    // No context exhaustion string — tailStdoutLog returns empty (default: no log file)
    vi.spyOn(ap as any, 'tailStdoutLog').mockReturnValue('');

    capturedOnExit!(0, 0);

    // Regular crash path — crash counter incremented
    expect(ap.getStatus().status).toBe('crashed');
    expect(ap.getCrashCount()).toBe(1);
    // Should be CRASH in log, not CONTEXT_EXHAUSTION_RECOVERY
    const [, logLine] = fsMocks.appendFileSync.mock.calls[0];
    expect(String(logLine)).toContain('] CRASH:');
    expect(String(logLine)).not.toContain('CONTEXT_EXHAUSTION_RECOVERY');
  });

  it('non-zero exit code with context string goes through regular crash path', async () => {
    // Regression guard: context exhaustion check is gated on exitCode === 0.
    // If Claude exits non-zero (e.g. SIGKILL) with context strings in the log,
    // it should be treated as a real crash, not a context exhaustion.
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    vi.spyOn(ap as any, 'tailStdoutLog').mockReturnValue('100% context used');
    capturedOnExit!(1, 0);

    expect(ap.getCrashCount()).toBe(1);
    const [, logLine] = fsMocks.appendFileSync.mock.calls[0];
    expect(String(logLine)).toContain('] CRASH:');
  });
});

describe('AgentProcess — MODEL_BILLING_CONFIG 1M-billing partition (SYS-1M-DETECT)', () => {
  // The load-bearing guard. A 1M-context billing/config error at session start
  // (exit 0, empty context) must HALT-and-escalate, NEVER force-fresh — a
  // force-fresh relaunches the SAME explicit model and re-hits the SAME gate
  // (the restart loop this exists to prevent). The partition is string-
  // discriminated and must never collapse into the context-exhaustion path.

  // restarts.log lines accumulate across start() + every handleExit; search all
  // of them rather than trusting a fixed index.
  const allRestartsLogText = () =>
    fsMocks.appendFileSync.mock.calls.map((c: any[]) => String(c[1])).join('\n');

  it('v2.1.111+ string "Usage credits required for 1M context" → HALT + escalate, NOT force-fresh', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    vi.spyOn(ap as any, 'tailStdoutLog').mockReturnValue('Usage credits required for 1M context');
    capturedOnExit!(0, 0);

    expect(ap.getStatus().status).toBe('halted');
    expect(ap.getCrashCount()).toBe(0); // NOT charged against max_crashes_per_day
    const log = allRestartsLogText();
    expect(log).toContain('MODEL_BILLING_CONFIG');
    expect(log).not.toContain('CONTEXT_EXHAUSTION_RECOVERY');
    // escalated to platform-director via the bus (shelled execFileSync)
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    const [cmd, cmdArgs] = mockExecFileSync.mock.calls[0];
    expect(cmd).toBe('cortextos');
    expect(cmdArgs).toEqual(expect.arrayContaining(['bus', 'send-message', 'platform-director']));
  });

  it('anti-collapse: legacy string "Extra usage is required for 1M context" also HALTs (never force-fresh)', async () => {
    // Regression guard: a prior test asserted this legacy string =>
    // CONTEXT_EXHAUSTION_RECOVERY, which ENCODED the bug (force-fresh on a
    // billing gate). Both wordings must partition to MODEL_BILLING_CONFIG.
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    vi.spyOn(ap as any, 'tailStdoutLog').mockReturnValue('Extra usage is required for 1M context');
    capturedOnExit!(0, 0);

    expect(ap.getStatus().status).toBe('halted');
    const log = allRestartsLogText();
    expect(log).toContain('MODEL_BILLING_CONFIG');
    expect(log).not.toContain('CONTEXT_EXHAUSTION_RECOVERY');
  });

  it('ANSI-wrapped billing string is still detected (TUI escape codes stripped)', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    vi.spyOn(ap as any, 'tailStdoutLog').mockReturnValue(
      '\x1b[31mUsage credits required for 1M context\x1b[0m',
    );
    capturedOnExit!(0, 0);

    expect(ap.getStatus().status).toBe('halted');
    expect(allRestartsLogText()).toContain('MODEL_BILLING_CONFIG');
  });

  it('escalates ONCE per halt-episode (latch holds across repeated billing exits)', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    vi.spyOn(ap as any, 'tailStdoutLog').mockReturnValue('Usage credits required for 1M context');
    capturedOnExit!(0, 0);
    capturedOnExit!(0, 0); // second billing exit in the SAME episode (no 'running' in between)

    expect(ap.getStatus().status).toBe('halted');
    expect(mockExecFileSync).toHaveBeenCalledTimes(1); // latch: PD is not re-spammed
  });

  it('non-zero exit with a billing string is a real crash (partition gated on exitCode === 0)', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    vi.spyOn(ap as any, 'tailStdoutLog').mockReturnValue('Usage credits required for 1M context');
    capturedOnExit!(1, 0);

    expect(ap.getCrashCount()).toBe(1);
    expect(allRestartsLogText()).not.toContain('MODEL_BILLING_CONFIG');
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });
});

describe('AgentProcess - onboarding marker (do not auto-write .onboarded on heartbeat)', () => {
  // Regression: buildStartupPrompt used to auto-write the .onboarded marker
  // whenever a heartbeat.json existed, on the assumption the agent had
  // onboarded and just forgot the marker. That silently suppressed FIRST BOOT
  // for agents that were manually scaffolded (heartbeat present) but never
  // actually ran onboarding. The marker must be explicit: a heartbeat alone
  // must NOT mark an agent onboarded. This is general daemon behavior (it was
  // surfaced via a manually-scaffolded opencode agent, but applies to any
  // runtime).
  it('does not auto-mark a heartbeat-only agent as onboarded (still routes to FIRST BOOT)', async () => {
    fsMocks.existsSync.mockImplementation((path: string) => {
      if (path.endsWith('/.force-fresh')) return false;
      if (path.endsWith('/.onboarded')) return false;
      if (path.endsWith('/heartbeat.json')) return true;
      if (path.endsWith('/ONBOARDING.md')) return true;
      return false;
    });

    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    const prompt = mockPty.spawn.mock.calls[0]?.[1] ?? '';
    expect(prompt).toContain('FIRST BOOT');
    expect(prompt).toContain('read ONBOARDING.md and complete the onboarding protocol');
    // The buggy auto-write must be gone: no .onboarded written from heartbeat presence.
    expect(fsMocks.writeFileSync).not.toHaveBeenCalledWith(
      expect.stringContaining('/.onboarded'),
      expect.anything(),
      expect.anything(),
    );
  });

  it('respects an existing .onboarded marker (suppresses FIRST BOOT)', async () => {
    fsMocks.existsSync.mockImplementation((path: string) => {
      if (path.endsWith('/.force-fresh')) return false;
      if (path.endsWith('/.onboarded')) return true;
      if (path.endsWith('/heartbeat.json')) return true;
      if (path.endsWith('/ONBOARDING.md')) return true;
      return false;
    });

    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    const prompt = mockPty.spawn.mock.calls[0]?.[1] ?? '';
    expect(prompt).not.toContain('FIRST BOOT');
    expect(prompt).not.toContain('complete the onboarding protocol');
  });
});
