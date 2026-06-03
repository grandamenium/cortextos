import { describe, it, expect, vi } from 'vitest';
import { runHermesDispatch } from '../../../../src/workers/hermes/orchestrator';
import type { HermesBus } from '../../../../src/workers/hermes/orchestrator';
import type {
  AdapterContext,
  BackendId,
  ExecResult,
  HealthResult,
  WorkerAdapter,
} from '../../../../src/workers/hermes/base';
import type { HermesAttemptRecord, HermesLogger } from '../../../../src/workers/hermes/logger';

/**
 * REQUIRED capstone (spec §6.3): backend-down -> fallback. Drives the real
 * orchestrator through its DI seams with fake adapters + spy bus/logger, and
 * asserts the end-to-end chain advance + failover recording — not just that a
 * function was called.
 */

interface FakeOpts {
  health?: HealthResult;
  execute?: () => Promise<ExecResult>;
  safeModels?: string[];
}

function fakeAdapter(id: BackendId, opts: FakeOpts = {}): WorkerAdapter {
  return {
    id,
    binary: id,
    safeModels: () => opts.safeModels ?? [`${id}-default`],
    health: vi.fn(async () => opts.health ?? { available: true, latencyMs: 1 }),
    execute: vi.fn(
      opts.execute ??
        (async () => ({
          ok: true,
          output: `${id}-out`,
          retryable: false,
          servedModel: `${id}-default`,
        })),
    ),
  };
}

function spyBus() {
  const events: Array<{ name: string; meta: Record<string, unknown> }> = [];
  const completed: Array<{ taskId: string; result: string }> = [];
  const messages: Array<{ to: string; pri: string; text: string }> = [];
  const bus: HermesBus = {
    completeTask: (taskId, result) => completed.push({ taskId, result }),
    sendMessage: (to, pri, text) => messages.push({ to, pri, text }),
    logEvent: (_cat, name, _sev, meta) => events.push({ name, meta }),
  };
  return { bus, events, completed, messages };
}

function spyLogger() {
  const records: HermesAttemptRecord[] = [];
  const log: HermesLogger = { record: (r) => records.push(r as HermesAttemptRecord) };
  return { log, records };
}

const ctx = { config: {}, env: {} } as unknown as AdapterContext;
// Deterministic, instant: constant clock (never over budget) + no-op sleep.
const fastDeps = { ctx, now: () => 0, sleep: async () => {} };

describe('hermes fallback — backend-down -> fallback (spec §6.3)', () => {
  it('codex process-fail exhausts its 1 retry, chain advances to gemini, gemini serves', async () => {
    const codex = fakeAdapter('codex', {
      execute: async () => ({
        ok: false,
        failure: 'process-fail',
        retryable: true,
        servedModel: 'codex-default',
        exitCode: 1,
        stderrExcerpt: 'boom',
      }),
    });
    const gemini = fakeAdapter('gemini', {
      execute: async () => ({
        ok: true,
        output: 'gemini result',
        retryable: false,
        servedModel: 'gemini-2.5-pro',
      }),
    });
    const claude = fakeAdapter('claude');
    const adapters = (b: BackendId) => ({ codex, gemini, claude })[b];

    const { bus, events, completed } = spyBus();
    const { log, records } = spyLogger();

    const outcome = await runHermesDispatch(
      { taskId: 't1', prompt: 'p', workdir: '/w', parent: 'planner' },
      { adapters, bus, log, ...fastDeps },
    );

    // Chain advanced past codex to gemini, which served.
    expect(outcome.status).toBe('served');
    expect(outcome.backend).toBe('gemini');
    // process-fail is retryable with maxRetries=1 -> exactly 2 executes (try 0 + 1 retry).
    expect((codex.execute as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
    // claude is the backstop and was never needed.
    expect((claude.execute as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    // The served deliverable was written via completeTask.
    expect(completed).toEqual([{ taskId: 't1', result: 'gemini result' }]);
    // The terminal event names the serving backend.
    expect(events.some((e) => e.name === 'hermes_task_served' && e.meta.backend === 'gemini')).toBe(true);
    // The codex failover is recorded in both the event stream and the JSONL.
    expect(events.some((e) => e.name === 'hermes_failover' && e.meta.from === 'codex')).toBe(true);
    expect(records.some((r) => r.backend === 'codex' && r.decision === 'failover')).toBe(true);
    // Per-backend chain-of-reasons carries codex's failure.
    expect(outcome.attempts).toEqual(
      expect.arrayContaining([{ backend: 'codex', reason: 'process-fail' }]),
    );
  });

  it('codex unavailable at health() -> execute NEVER called, gemini serves, skip logged', async () => {
    const codex = fakeAdapter('codex', {
      health: { available: false, reason: 'no-binary', latencyMs: 1 },
    });
    const gemini = fakeAdapter('gemini', {
      execute: async () => ({
        ok: true,
        output: 'gemini result',
        retryable: false,
        servedModel: 'gemini-2.5-pro',
      }),
    });
    const claude = fakeAdapter('claude');
    const adapters = (b: BackendId) => ({ codex, gemini, claude })[b];

    const { bus, events } = spyBus();
    const { log } = spyLogger();

    const outcome = await runHermesDispatch(
      { taskId: 't2', prompt: 'p', workdir: '/w', parent: 'planner' },
      { adapters, bus, log, ...fastDeps },
    );

    // Health gates execute: a dead backend's execute() is never reached.
    expect((codex.execute as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(outcome.status).toBe('served');
    expect(outcome.backend).toBe('gemini');
    expect(
      events.some((e) => e.name === 'hermes_backend_skipped' && e.meta.backend === 'codex'),
    ).toBe(true);
  });
});
