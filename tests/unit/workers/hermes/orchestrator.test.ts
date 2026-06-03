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
 * SECONDARY L3 unit coverage for the orchestrator contract (spec §6.2).
 * Mirrors fallback.test.ts's DI-fake pattern (fakeAdapter / spyBus / spyLogger /
 * fastDeps) and pins the load-bearing invariants: health gates execute, served
 * path writes completeTask + records servedModel, exhausted path is never silent,
 * the default model pin, and preferred-hoist routing.
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

describe('hermes orchestrator — contract (spec §6.2)', () => {
  it('health gates execute: an !available backend\'s execute is NEVER called; chain falls through', async () => {
    const codex = fakeAdapter('codex', {
      health: { available: false, reason: 'no-auth', latencyMs: 1 },
    });
    const gemini = fakeAdapter('gemini'); // healthy default serves
    const claude = fakeAdapter('claude');
    const adapters = (b: BackendId) => ({ codex, gemini, claude })[b];

    const { bus } = spyBus();
    const { log } = spyLogger();

    const outcome = await runHermesDispatch(
      { taskId: 't1', prompt: 'p', workdir: '/w', parent: 'planner' },
      { adapters, bus, log, ...fastDeps },
    );

    // The unhealthy codex never executes; the chain fell through to gemini.
    expect((codex.execute as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(outcome.status).toBe('served');
    expect(outcome.backend).toBe('gemini');
  });

  it('served path writes completeTask with served result + records servedModel + emits served event', async () => {
    const codex = fakeAdapter('codex', {
      execute: async () => ({
        ok: true,
        output: 'codex deliverable',
        retryable: false,
        servedModel: 'gpt-5.5',
      }),
    });
    const gemini = fakeAdapter('gemini');
    const claude = fakeAdapter('claude');
    const adapters = (b: BackendId) => ({ codex, gemini, claude })[b];

    const { bus, events, completed, messages } = spyBus();
    const { log } = spyLogger();

    const outcome = await runHermesDispatch(
      { taskId: 't2', prompt: 'p', workdir: '/w', parent: 'planner' },
      { adapters, bus, log, ...fastDeps },
    );

    expect(completed).toEqual([{ taskId: 't2', result: 'codex deliverable' }]);
    expect(outcome.servedModel).toBe('gpt-5.5');
    expect(
      events.some((e) => e.name === 'hermes_task_served' && e.meta.servedModel === 'gpt-5.5'),
    ).toBe(true);
    // RECIPIENT assertion (regression guard): the served reply must go to the
    // delegator passed as req.parent — NOT the serving backend or the worker.
    // (The omission of this check is what let the assigned_to-vs-created_by
    // recipient bug ship initially.)
    expect(messages.length).toBe(1);
    expect(messages[0].to).toBe('planner');
  });

  it('exhausted path is never silent: completeTask EXHAUSTED + high-pri parent ping + exhausted event, completeTask exactly once', async () => {
    const down: HealthResult = { available: false, reason: 'no-auth', latencyMs: 1 };
    const codex = fakeAdapter('codex', { health: down });
    const gemini = fakeAdapter('gemini', { health: down });
    const claude = fakeAdapter('claude', { health: down });
    const adapters = (b: BackendId) => ({ codex, gemini, claude })[b];

    const { bus, events, completed, messages } = spyBus();
    const { log } = spyLogger();

    const outcome = await runHermesDispatch(
      { taskId: 't3', prompt: 'p', workdir: '/w', parent: 'planner' },
      { adapters, bus, log, ...fastDeps },
    );

    expect(outcome.status).toBe('exhausted');
    // NEVER SILENT — completeTask called exactly once with the explicit marker.
    expect(completed.length).toBe(1);
    expect(completed[0]).toEqual({ taskId: 't3', result: 'HERMES_EXHAUSTED' });
    // High-priority parent ping emitted.
    expect(messages.some((m) => m.to === 'planner' && m.pri === 'high')).toBe(true);
    // Exhausted event emitted.
    expect(events.some((e) => e.name === 'hermes_task_exhausted')).toBe(true);
  });

  it('default model pin: when req.model omitted, each invoked adapter\'s execute receives safeModels()[0]', async () => {
    const codex = fakeAdapter('codex', {
      safeModels: ['SENTINEL-MODEL'],
      execute: async () => ({
        ok: true,
        output: 'served',
        retryable: false,
        servedModel: 'SENTINEL-MODEL',
      }),
    });
    const gemini = fakeAdapter('gemini');
    const claude = fakeAdapter('claude');
    const adapters = (b: BackendId) => ({ codex, gemini, claude })[b];

    const { bus } = spyBus();
    const { log } = spyLogger();

    await runHermesDispatch(
      // No model in the request — orchestrator must pin adapter.safeModels()[0].
      { taskId: 't4', prompt: 'p', workdir: '/w', parent: 'planner' },
      { adapters, bus, log, ...fastDeps },
    );

    expect((codex.execute as ReturnType<typeof vi.fn>).mock.calls[0][0].model).toBe('SENTINEL-MODEL');
  });

  it('preferred hoist routes first: preferred gemini -> gemini serves, codex execute never called', async () => {
    const codex = fakeAdapter('codex');
    const gemini = fakeAdapter('gemini', {
      execute: async () => ({
        ok: true,
        output: 'gemini served',
        retryable: false,
        servedModel: 'gemini-2.5-pro',
      }),
    });
    const claude = fakeAdapter('claude');
    const adapters = (b: BackendId) => ({ codex, gemini, claude })[b];

    const { bus } = spyBus();
    const { log } = spyLogger();

    const outcome = await runHermesDispatch(
      { taskId: 't5', prompt: 'p', workdir: '/w', parent: 'planner', preferred: 'gemini' },
      { adapters, bus, log, ...fastDeps },
    );

    expect(outcome.backend).toBe('gemini');
    // gemini was hoisted to first, served, so codex (default head) never ran.
    expect((codex.execute as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((gemini.health as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    expect((gemini.execute as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });
});
