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
 * REQUIRED capstone (spec §6.4): the tonight regression. Locks the motivating
 * fix end-to-end at the orchestrator level — a Codex config-error (the
 * gpt-5.3-codex entitlement failure) must cost EXACTLY ONE execute (0 retries),
 * fail over immediately, and end SERVED (never exhausted, never silent). The
 * classifier side is already pinned by the codex-classifier unit suite; this
 * pins the orchestrator's handling of it.
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
const fastDeps = { ctx, now: () => 0, sleep: async () => {} };

describe('hermes tonight-regression — codex config-error -> auto-failover (spec §6.4)', () => {
  it('config-error costs exactly ONE execute, fails over immediately, ends SERVED', async () => {
    const codex = fakeAdapter('codex', {
      // Simulates the gpt-5.3-codex entitlement gate: non-retryable config-error.
      execute: async () => ({
        ok: false,
        failure: 'config-error',
        retryable: false,
        servedModel: 'gpt-5.3-codex',
        exitCode: 1,
        stderrExcerpt: 'model gpt-5.3-codex is not available',
      }),
    });
    const gemini = fakeAdapter('gemini', {
      execute: async () => ({
        ok: true,
        output: 'gemini served it',
        retryable: false,
        servedModel: 'gemini-2.5-pro',
      }),
    });
    const claude = fakeAdapter('claude');
    const adapters = (b: BackendId) => ({ codex, gemini, claude })[b];

    const { bus, events, completed } = spyBus();
    const { log, records } = spyLogger();

    const outcome = await runHermesDispatch(
      { taskId: 'tonight', prompt: 'p', workdir: '/w', parent: 'planner', model: 'gpt-5.3-codex' },
      { adapters, bus, log, ...fastDeps },
    );

    // 1. ZERO retries on codex — the burned-3x-spawn-retry bug must not return.
    expect((codex.execute as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    // 2. Immediate failover -> ends SERVED (by gemini), never exhausted.
    expect(outcome.status).toBe('served');
    expect(outcome.backend).toBe('gemini');
    expect(completed).toEqual([{ taskId: 'tonight', result: 'gemini served it' }]);
    // 3. Observability (assertion 5): the codex execute JSONL record proves it
    //    never-silently-failed — requestedModel + config-error + decision:failover.
    const codexRec = records.find((r) => r.backend === 'codex' && r.phase === 'execute');
    expect(codexRec).toBeDefined();
    expect(codexRec?.requestedModel).toBe('gpt-5.3-codex');
    expect(codexRec?.failure).toBe('config-error');
    expect(codexRec?.decision).toBe('failover');
    expect(codexRec?.stderrExcerpt).toBeTruthy();
    // 4. The failover transition is on the event stream too.
    expect(events.some((e) => e.name === 'hermes_failover' && e.meta.from === 'codex')).toBe(true);
  });

  it('full chain exhausted -> HERMES_EXHAUSTED, high-pri reason table, never silent', async () => {
    const down = (id: BackendId, reason: 'no-binary' | 'no-auth') =>
      fakeAdapter(id, { health: { available: false, reason, latencyMs: 1 } });
    const codex = down('codex', 'no-binary');
    const gemini = down('gemini', 'no-auth');
    const claude = down('claude', 'no-auth');
    const adapters = (b: BackendId) => ({ codex, gemini, claude })[b];

    const { bus, events, completed, messages } = spyBus();
    const { log } = spyLogger();

    const outcome = await runHermesDispatch(
      { taskId: 'dead', prompt: 'p', workdir: '/w', parent: 'planner' },
      { adapters, bus, log, ...fastDeps },
    );

    // No backend ran; the chain still terminates explicitly — never silent.
    expect(outcome.status).toBe('exhausted');
    expect((codex.execute as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((gemini.execute as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((claude.execute as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    // Explicit completeTask result, not a bare return.
    expect(completed).toEqual([{ taskId: 'dead', result: 'HERMES_EXHAUSTED' }]);
    // High-priority parent message carrying the full per-backend reason table.
    const high = messages.find((m) => m.pri === 'high');
    expect(high).toBeDefined();
    expect(high?.text).toContain('codex');
    expect(high?.text).toContain('gemini');
    expect(high?.text).toContain('claude');
    expect(events.some((e) => e.name === 'hermes_task_exhausted')).toBe(true);
  });
});
