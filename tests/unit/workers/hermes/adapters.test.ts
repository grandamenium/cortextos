import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock child_process BEFORE importing the adapters so their execFile is the mock.
vi.mock('child_process', () => ({ exec: vi.fn(), execFile: vi.fn() }));

import { execFile } from 'child_process';
import { claudeAdapter } from '../../../../src/workers/hermes/adapters/claude';
import { geminiAdapter } from '../../../../src/workers/hermes/adapters/gemini';
import type { AdapterContext } from '../../../../src/workers/hermes/base';

/**
 * SECONDARY L3 unit coverage for the claude + gemini classifiers (spec §6.1).
 * Mirrors codex-classifier.test.ts: mock child_process at module load, then
 * drive each adapter's execute()/health() with a routed execFile callback so we
 * pin the REAL verdict mapping (not just that a function was called).
 *
 * Both adapters shell out via execFile. The classifier logic is module-private,
 * so it is exercised end-to-end through execute()/health() with a mocked spawn.
 */

type FakeResp = { err?: unknown; stdout?: string; stderr?: string };

/** Route the mocked execFile's (err, stdout, stderr) callback by (cmd, args). */
function routeExecFile(router: (cmd: string, args: string[]) => FakeResp): void {
  vi.mocked(execFile).mockImplementation(
    ((cmd: unknown, args: unknown, optsOrCb: unknown, maybeCb?: unknown) => {
      const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as
        | ((e: unknown, so: string, se: string) => void)
        | undefined;
      const r = router(cmd as string, (args as string[]) ?? []);
      cb?.(r.err ?? null, r.stdout ?? '', r.stderr ?? '');
      return {} as never;
    }) as never,
  );
}

/** A non-zero exit error shaped like execFile's ExecFileException. */
function exitErr(code: number): Error & { code: number } {
  return Object.assign(new Error(`exit ${code}`), { code });
}

/** A kill-by-timeout error: execFile sets err.killed when the timeout fires. */
function timeoutErr(): Error & { killed: boolean } {
  return Object.assign(new Error('killed'), { killed: true });
}

/** The claude binary run() spawns (no `timeout` shell wrapper). */
const CLAUDE_BINARY = process.platform === 'win32' ? 'claude.cmd' : 'claude';

const ctx = { config: {}, env: {} } as unknown as AdapterContext;
const baseInput = { prompt: 'do x', workdir: '/tmp', timeoutMs: 1000 };

beforeEach(() => {
  vi.mocked(execFile).mockReset();
});

describe('claude execute() — classifier verdicts (spec §6.1)', () => {
  // claude spawns the `claude` binary DIRECTLY; the wall-clock cap is the
  // execFile timeout in run() (killedByTimeout), not a `timeout` shell wrapper.
  it('spawns the claude binary directly, NOT a `timeout` shell wrapper', async () => {
    // Regression: the old impl spawned `timeout <secs> claude …`, which ENOENTs
    // on macOS (no GNU coreutils `timeout`/`gtimeout`) while health() — which
    // only probes the claude binary — passes, silently disabling this backstop.
    // A child_process mock returns rc-0 regardless of cmd, so this is the ONLY
    // assertion that catches the wrong spawn target. Spawned cmd MUST be claude.
    let spawnedCmd: string | undefined;
    let spawnedArgs: string[] = [];
    routeExecFile((cmd, args) => {
      spawnedCmd = cmd;
      spawnedArgs = args;
      return { stdout: '{"is_error":false,"result":"ok"}' };
    });

    await claudeAdapter.execute({ ...baseInput }, ctx);

    expect(spawnedCmd).toBe(CLAUDE_BINARY);
    expect(spawnedCmd).not.toBe('timeout');
    // argv carries the real claude flags directly, not `<secs> claude …`.
    expect(spawnedArgs[0]).toBe('-p');
    expect(spawnedArgs).toContain('--output-format');
    expect(spawnedArgs).not.toContain(CLAUDE_BINARY); // binary is argv[0], not nested
  });

  it('ENOENT (spawn fail) => failure no-binary, not retryable', async () => {
    // run() maps err.code === "ENOENT" to code 127 + spawnError.
    routeExecFile(() => ({ err: Object.assign(new Error('enoent'), { code: 'ENOENT' }) }));

    const r = await claudeAdapter.execute({ ...baseInput }, ctx);

    expect(r.ok).toBe(false);
    expect(r.failure).toBe('no-binary');
    expect(r.retryable).toBe(false);
    expect(r.exitCode).toBe(127);
  });

  it('killedByTimeout (execFile SIGKILL cap) => failure timeout, retryable', async () => {
    // The cap is now the execFile { timeout, killSignal: SIGKILL } in run(),
    // which sets killedByTimeout — there is no shell `timeout` rc-124 anymore.
    routeExecFile(() => ({ err: timeoutErr() }));

    const r = await claudeAdapter.execute({ ...baseInput }, ctx);

    expect(r.ok).toBe(false);
    expect(r.failure).toBe('timeout');
    expect(r.retryable).toBe(true);
  });

  it('exit 0 with is_error:true => failure process-fail EVEN ON EXIT 0 (load-bearing)', async () => {
    routeExecFile(() => ({ stdout: '{"is_error":true,"result":"x"}' }));

    const r = await claudeAdapter.execute({ ...baseInput }, ctx);

    expect(r.ok).toBe(false);
    expect(r.failure).toBe('process-fail');
    expect(r.exitCode).toBe(0);
    expect(r.retryable).toBe(true);
  });

  it('exit 0 with is_error:false => ok, output extracted', async () => {
    routeExecFile(() => ({ stdout: '{"is_error":false,"result":"ok"}' }));

    const r = await claudeAdapter.execute({ ...baseInput }, ctx);

    expect(r.ok).toBe(true);
    expect(r.output).toBe('ok');
    expect(r.exitCode).toBe(0);
  });

  it('non-zero exit with auth-text stderr => failure no-auth, not retryable', async () => {
    routeExecFile(() => ({ err: exitErr(1), stderr: 'unauthorized' }));

    const r = await claudeAdapter.execute({ ...baseInput }, ctx);

    expect(r.ok).toBe(false);
    expect(r.failure).toBe('no-auth');
    expect(r.retryable).toBe(false);
  });

  it('non-zero exit with rate text => failure rate-limit, retryable', async () => {
    routeExecFile(() => ({ err: exitErr(1), stderr: '429 rate limit exceeded' }));

    const r = await claudeAdapter.execute({ ...baseInput }, ctx);

    expect(r.ok).toBe(false);
    expect(r.failure).toBe('rate-limit');
    expect(r.retryable).toBe(true);
  });
});

describe('gemini health() — auth gate (spec §6.1)', () => {
  let prevKey: string | undefined;

  beforeEach(() => {
    prevKey = process.env.GEMINI_API_KEY;
  });

  afterEach(() => {
    if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevKey;
  });

  it('missing GEMINI_API_KEY => available:false, reason no-auth', async () => {
    delete process.env.GEMINI_API_KEY;

    const h = await geminiAdapter.health();

    expect(h.available).toBe(false);
    expect(h.reason).toBe('no-auth');
  });

  it('GEMINI_API_KEY present => available:true', async () => {
    process.env.GEMINI_API_KEY = 'fake-key';

    const h = await geminiAdapter.health();

    expect(h.available).toBe(true);
  });
});

describe('gemini execute() — envelope classifier (spec §6.1)', () => {
  // gemini.execute writes the prompt to a temp file then spawns python3; the
  // mock just invokes the callback with the gemini_task.py JSON envelope on
  // stdout. The temp-file write really happens (os.tmpdir) — that is fine.
  it('envelope ok:false failure rate-limit => failure rate-limit, retryable', async () => {
    routeExecFile(() => ({ stdout: '{"ok":false,"failure":"rate-limit","detail":"429"}' }));

    const r = await geminiAdapter.execute({ ...baseInput }, ctx);

    expect(r.ok).toBe(false);
    expect(r.failure).toBe('rate-limit');
    expect(r.retryable).toBe(true);
  });

  it('envelope ok:true => ok, output extracted', async () => {
    routeExecFile(() => ({ stdout: '{"ok":true,"output":"hi","servedModel":"gemini-2.5-pro"}' }));

    const r = await geminiAdapter.execute({ ...baseInput }, ctx);

    expect(r.ok).toBe(true);
    expect(r.output).toBe('hi');
    expect(r.servedModel).toBe('gemini-2.5-pro');
  });

  it('envelope ok:false failure no-auth => failure no-auth, not retryable', async () => {
    routeExecFile(() => ({ stdout: '{"ok":false,"failure":"no-auth"}' }));

    const r = await geminiAdapter.execute({ ...baseInput }, ctx);

    expect(r.ok).toBe(false);
    expect(r.failure).toBe('no-auth');
    expect(r.retryable).toBe(false);
  });
});
