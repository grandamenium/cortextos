import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock child_process BEFORE importing the adapter so its execFile is the mock.
vi.mock('child_process', () => ({ exec: vi.fn(), execFile: vi.fn() }));

import { execFile } from 'child_process';
import { codexAdapter } from '../../../../src/workers/hermes/adapters/codex';
import type { AdapterContext } from '../../../../src/workers/hermes/base';

/**
 * Focused unit coverage for the LOAD-BEARING codex classifier + allowlist gate.
 * This is the one piece whose silent regression would undo the whole point of
 * Hermes — the unentitled-model auto-failover (the motivating incident).
 *
 * The classifier (classifyCodexOutcome) is module-private, so we drive it
 * through codexAdapter.execute()/health() with a mocked spawn — this also pins
 * the execute/health wiring, not just the pure logic.
 */

type FakeResp = { err?: unknown; stdout?: string; stderr?: string };

/** Route the mocked execFile's (err, stdout, stderr) callback by (cmd, args). */
function routeExecFile(router: (cmd: string, args: string[]) => FakeResp): void {
  vi.mocked(execFile).mockImplementation(
    // execFile is always called as (cmd, args, opts, cb) by the adapter, but be
    // defensive about the opts-or-cb position like the repo's other mocks.
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

const ctx = { config: {}, env: {} } as unknown as AdapterContext;
const baseInput = { prompt: 'do x', workdir: '/tmp', timeoutMs: 1000 };

let prevPluginRoot: string | undefined;

beforeEach(() => {
  vi.mocked(execFile).mockReset();
  prevPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  // execute() resolves the companion forwarder from CLAUDE_PLUGIN_ROOT.
  process.env.CLAUDE_PLUGIN_ROOT = '/fake/plugin-root';
});

afterEach(() => {
  if (prevPluginRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
  else process.env.CLAUDE_PLUGIN_ROOT = prevPluginRoot;
});

describe('codex execute() — the tonight-vs-flaky position boundary (spec §3.2/§6.1)', () => {
  it('entitlement error BEFORE any token-usage => config-error, NOT retryable (the tonight case)', async () => {
    // A real run emits token usage first; an entitlement error with no usage
    // before it means the turn never started → an entitlement gate, not a blip.
    routeExecFile(() => ({
      err: exitErr(1),
      stdout: '{"type":"error","message":"model gpt-5.3-codex is not available"}',
    }));

    const r = await codexAdapter.execute({ ...baseInput, model: 'gpt-5.3-codex' }, ctx);

    expect(r.ok).toBe(false);
    expect(r.failure).toBe('config-error');
    expect(r.retryable).toBe(false); // 0 retries → immediate failover
    expect(r.servedModel).toBe('gpt-5.3-codex'); // requested model echoed for telemetry
    expect(r.stderrExcerpt).toContain('gpt-5.3-codex');
  });

  it('the SAME entitlement text AFTER token-usage => transient, retryable (mid-flight anomaly)', async () => {
    // Identical error text, but emitted after the turn produced token usage:
    // the turn DID start, so this is not an entitlement gate — treat as transient.
    routeExecFile(() => ({
      err: exitErr(1),
      stdout:
        '{"type":"thread/tokenUsage/updated","tokens":12}\n' +
        '{"type":"error","message":"model gpt-5.3-codex is not available"}',
    }));

    const r = await codexAdapter.execute({ ...baseInput, model: 'gpt-5.3-codex' }, ctx);

    expect(r.ok).toBe(false);
    expect(r.failure).toBe('transient');
    expect(r.retryable).toBe(true); // this is the EXACT line distinguishing tonight from flaky
  });

  it('broker-busy -32001 => transient, retryable (position-independent)', async () => {
    routeExecFile(() => ({ err: exitErr(1), stderr: 'rpc error -32001 broker is busy' }));

    const r = await codexAdapter.execute({ ...baseInput }, ctx);

    expect(r.ok).toBe(false);
    expect(r.failure).toBe('transient');
    expect(r.retryable).toBe(true);
  });

  it('clean exit 0 with a result envelope => ok, output extracted', async () => {
    routeExecFile(() => ({ stdout: '{"output":"all done"}' }));

    const r = await codexAdapter.execute({ ...baseInput }, ctx);

    expect(r.ok).toBe(true);
    expect(r.output).toBe('all done');
    expect(r.servedModel).toBe('gpt-5.5'); // default pin when model omitted
  });
});

describe('codex health() — entitlement allowlist gate (spec §3.2/§6.3)', () => {
  // Binary present + logged in, so the allowlist check is what decides.
  function healthyEnv(): (cmd: string, args: string[]) => FakeResp {
    return (_cmd, args) => {
      if (args.includes('--version')) return { stdout: 'codex 0.130.0' };
      if (args.includes('login') && args.includes('status')) return { stdout: 'Logged in as user' };
      return { stdout: '' };
    };
  }

  it('health("gpt-5.3-codex") => config-error (unentitled model skipped up front)', async () => {
    routeExecFile(healthyEnv());

    const h = await codexAdapter.health('gpt-5.3-codex');

    expect(h.available).toBe(false);
    expect(h.reason).toBe('config-error');
    expect(h.checkedModel).toBe('gpt-5.3-codex');
  });

  it('health() with no model pins gpt-5.5 and is available', async () => {
    routeExecFile(healthyEnv());

    const h = await codexAdapter.health();

    expect(h.available).toBe(true);
    expect(h.checkedModel).toBe('gpt-5.5');
  });

  it('health() => no-binary when codex is absent (ENOENT)', async () => {
    routeExecFile(() => ({ err: Object.assign(new Error('enoent'), { code: 'ENOENT' }) }));

    const h = await codexAdapter.health();

    expect(h.available).toBe(false);
    expect(h.reason).toBe('no-binary');
  });

  it('health() => no-auth when codex login status reports logged out', async () => {
    routeExecFile((_cmd, args) => {
      if (args.includes('--version')) return { stdout: 'codex 0.130.0' };
      if (args.includes('login')) return { err: exitErr(1), stdout: 'Not logged in. Please run codex login' };
      return { stdout: '' };
    });

    const h = await codexAdapter.health();

    expect(h.available).toBe(false);
    expect(h.reason).toBe('no-auth');
  });
});

describe('codex safeModels() — structural exclusion (the prevention layer)', () => {
  it('excludes gpt-5.3-codex and gpt-5.3-codex-spark; defaults to gpt-5.5', () => {
    const models = codexAdapter.safeModels();
    expect(models).not.toContain('gpt-5.3-codex');
    expect(models).not.toContain('gpt-5.3-codex-spark');
    expect(models[0]).toBe('gpt-5.5');
  });
});
