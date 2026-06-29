/**
 * Regression tests for detectRateLimitCrash (private method in AgentProcess,
 * src/daemon/agent-process.ts). Tested via AgentProcess.handleExit() behavior.
 *
 * Root cause: bare prose substrings 'rate limit' and 'rate-limit' caused
 * session titles like "Rate Limit Guard" to be misclassified, triggering
 * RATE_LIMIT backoff instead of the normal CRASH path.
 *
 * Fix: removed those two bare phrases; all precise API/CLI signatures retained.
 *
 * Test strategy: configure fs mocks so tailStdoutLog() returns specific content,
 * then fire handleExit() via capturedOnExit and assert whether the restarts.log
 * entry contains RATE_LIMIT (true positive) or CRASH (false positive).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('../../../src/pty/inject.js', () => ({
  injectMessage: vi.fn(),
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
  openSync: vi.fn().mockReturnValue(1),
  readSync: vi.fn(),
  closeSync: vi.fn(),
};

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    mkdirSync: vi.fn(),
    get existsSync() { return fsMocks.existsSync; },
    get readFileSync() { return fsMocks.readFileSync; },
    get writeFileSync() { return fsMocks.writeFileSync; },
    get appendFileSync() { return fsMocks.appendFileSync; },
    get statSync() { return fsMocks.statSync; },
    get openSync() { return fsMocks.openSync; },
    get readSync() { return fsMocks.readSync; },
    get closeSync() { return fsMocks.closeSync; },
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

/**
 * Configure fs mocks so tailStdoutLog() returns `content`.
 * tailStdoutLog reads via openSync/readSync/closeSync with the file's stat size.
 */
function mockStdoutLog(content: string): void {
  fsMocks.existsSync.mockImplementation((p: unknown) =>
    String(p).endsWith('/logs/alice/stdout.log'),
  );
  fsMocks.statSync.mockImplementation((_p: unknown) => ({ size: content.length, mtimeMs: Date.now() - 100 }));
  fsMocks.openSync.mockReturnValue(1);
  fsMocks.readSync.mockImplementation((_fd: number, buffer: Buffer) => {
    buffer.write(content, 0, 'utf-8');
    return content.length;
  });
  fsMocks.closeSync.mockReturnValue(undefined);
}

beforeEach(() => {
  capturedOnExit = null;
  mockPty.spawn.mockClear();
  mockPty.kill.mockClear();
  mockPty.write.mockClear();
  mockPty.onExit.mockClear();
  fsMocks.existsSync.mockReset().mockReturnValue(false);
  fsMocks.readFileSync.mockReset();
  fsMocks.writeFileSync.mockReset();
  fsMocks.appendFileSync.mockReset();
  fsMocks.statSync.mockReset();
  fsMocks.openSync.mockReset().mockReturnValue(1);
  fsMocks.readSync.mockReset();
  fsMocks.closeSync.mockReset();
});

describe('detectRateLimitCrash (via AgentProcess.handleExit) — false-positive guard', () => {
  it('does NOT treat "Reverted comms-check Step 0 Rate Limit Guard" as rate-limited', async () => {
    mockStdoutLog('Reverted comms-check Step 0 Rate Limit Guard');
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    capturedOnExit!(1, 0);
    // Must fall through to CRASH path, not RATE_LIMIT
    expect(fsMocks.appendFileSync).toHaveBeenCalled();
    const logLine = String(fsMocks.appendFileSync.mock.calls[0][1]);
    expect(logLine).not.toContain('RATE_LIMIT');
    expect(logLine).toContain('CRASH');
  });

  it('does NOT treat "crash loop caused by rate limiting" as rate-limited', async () => {
    mockStdoutLog('Diagnosed and fixed comms-check worker crash loop caused by rate limiting');
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    capturedOnExit!(1, 0);
    expect(fsMocks.appendFileSync).toHaveBeenCalled();
    const logLine = String(fsMocks.appendFileSync.mock.calls[0][1]);
    expect(logLine).not.toContain('RATE_LIMIT');
    expect(logLine).toContain('CRASH');
  });

  it('does NOT treat "Comms-check worker crash loop (rate limit) investigation" as rate-limited', async () => {
    mockStdoutLog('Comms-check worker crash loop (rate limit) investigation');
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    capturedOnExit!(1, 0);
    expect(fsMocks.appendFileSync).toHaveBeenCalled();
    const logLine = String(fsMocks.appendFileSync.mock.calls[0][1]);
    expect(logLine).not.toContain('RATE_LIMIT');
    expect(logLine).toContain('CRASH');
  });
});

describe('detectRateLimitCrash (via AgentProcess.handleExit) — true-positive guard', () => {
  it('DOES treat "rate_limit_error" as rate-limited (backs off, no crash_count increment)', async () => {
    mockStdoutLog('Anthropic API rate_limit_error: Too Many Requests');
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    capturedOnExit!(1, 0);
    expect(ap.getStatus().crashCount).toBe(0);
    expect(fsMocks.appendFileSync).toHaveBeenCalled();
    expect(String(fsMocks.appendFileSync.mock.calls[0][1])).toContain('RATE_LIMIT');
  });

  it('DOES treat "overloaded_error" as rate-limited', async () => {
    mockStdoutLog('API Error: overloaded_error: system overloaded. Please retry.');
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    capturedOnExit!(1, 0);
    expect(ap.getStatus().crashCount).toBe(0);
    expect(String(fsMocks.appendFileSync.mock.calls[0][1])).toContain('RATE_LIMIT');
  });

  it('DOES treat "Claude usage limit reached" as rate-limited', async () => {
    mockStdoutLog('Claude usage limit reached. Please upgrade your plan.');
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    capturedOnExit!(1, 0);
    expect(ap.getStatus().crashCount).toBe(0);
    expect(String(fsMocks.appendFileSync.mock.calls[0][1])).toContain('RATE_LIMIT');
  });

  it('DOES treat "reached your weekly limit" as rate-limited', async () => {
    mockStdoutLog("You've reached your weekly limit. Resets Monday.");
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    capturedOnExit!(1, 0);
    expect(ap.getStatus().crashCount).toBe(0);
    expect(String(fsMocks.appendFileSync.mock.calls[0][1])).toContain('RATE_LIMIT');
  });

  it('DOES treat "used 95% of your limit" as rate-limited', async () => {
    mockStdoutLog("You've used 95% of your limit for this week.");
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    capturedOnExit!(1, 0);
    expect(ap.getStatus().crashCount).toBe(0);
    expect(String(fsMocks.appendFileSync.mock.calls[0][1])).toContain('RATE_LIMIT');
  });
});
