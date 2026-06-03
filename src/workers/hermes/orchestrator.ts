import type {
  AdapterContext,
  BackendId,
  Unavailability,
  WorkerAdapter,
} from './base.js';
import type { BusPaths, EventCategory, EventSeverity, Priority } from '../../types/index.js';
import type { HermesLogger } from './logger.js';
import { DEFAULT_MAX_TOTAL_MS, backoffMs, maxRetries, order } from './policy.js';
import { loadWorkerAdapter } from './loadWorkerAdapter.js';
import { completeTask } from '../../bus/task.js';
import { sendMessage } from '../../bus/message.js';
import { logEvent } from '../../bus/event.js';

/**
 * Hermes dispatch state machine (spec §4.2): INTAKE → SELECT → EXECUTE LOOP →
 * REPORT. All external effects are dependency-injected so L3 can drive the loop
 * deterministically (spec §6.2): mock adapters, a fake bus, a no-op sleep and a
 * controllable clock.
 *
 * Three hard invariants the L3 tests assert (kept structural here):
 *   1. NEVER SILENT — every code path ends in exactly one REPORT (served or
 *      exhausted), each of which writes a completeTask result and pings parent.
 *   2. HEALTH GATES EXECUTE — an !available backend's execute() is NEVER called.
 *   3. CONFIG-ERROR = 0 RETRIES — a non-retryable failure runs execute() exactly
 *      once on that backend, then fails over.
 */

export interface HermesDispatchRequest {
  taskId: string;
  prompt: string;
  workdir: string;
  preferred?: BackendId;
  model?: string;
  /** Total wall-clock budget across the whole chain. Default DEFAULT_MAX_TOTAL_MS. */
  maxTotalMs?: number;
  /** Parent agent to reply to (send-message target). */
  parent: string;
  /** Original message id to reply to (auto-ACK on the parent's inbox). */
  replyTo?: string;
}

/** All external effects injected so L3 can mock them (spec §6.2). */
export interface HermesBus {
  completeTask(taskId: string, result: string): void;
  sendMessage(to: string, priority: 'normal' | 'high', text: string, replyTo?: string): void;
  logEvent(category: string, name: string, severity: string, meta: Record<string, unknown>): void;
}

export interface HermesDeps {
  /** Adapter source — default loadWorkerAdapter. Injectable for fake adapters. */
  adapters?: (id: BackendId) => WorkerAdapter;
  /** Shared context passed to execute(). */
  ctx: AdapterContext;
  bus: HermesBus;
  log: HermesLogger;
  /** Clock for budget + backoff timing. Default Date.now. */
  now?: () => number;
  /** Sleep for backoff. Default real setTimeout; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
}

export interface DispatchOutcome {
  status: 'served' | 'exhausted';
  backend?: BackendId;
  servedModel?: string;
  /** Per-backend chain-of-reasons (one entry per backend that did not serve). */
  attempts: Array<{ backend: BackendId; reason?: Unavailability }>;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run one task through the health-gated fallback chain. Returns the terminal
 * outcome. Guaranteed to REPORT (served or exhausted) on every path.
 */
export async function runHermesDispatch(
  req: HermesDispatchRequest,
  deps: HermesDeps,
): Promise<DispatchOutcome> {
  const adapters = deps.adapters ?? loadWorkerAdapter;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? realSleep;
  const { ctx, bus, log } = deps;
  const maxTotalMs = req.maxTotalMs ?? DEFAULT_MAX_TOTAL_MS;

  const start = now();
  const attempts: Array<{ backend: BackendId; reason?: Unavailability }> = [];

  // ---- INTAKE ----
  bus.logEvent('action', 'hermes_task_received', 'info', {
    taskId: req.taskId,
    preferred: req.preferred ?? null,
  });

  // ---- SELECT ----
  const chain = order(req.preferred);

  const remainingBudget = (): number => maxTotalMs - (now() - start);
  const overBudget = (): boolean => now() - start > maxTotalMs;

  // ---- EXECUTE LOOP ----
  for (let i = 0; i < chain.length; i++) {
    const backend = chain[i];
    const nextBackend: BackendId | null = i + 1 < chain.length ? chain[i + 1] : null;
    const adapter = adapters(backend);
    // Per-backend pinned model: explicit request override, else adapter default.
    const model = req.model ?? adapter.safeModels()[0];

    // Budget guard at the backend boundary.
    if (overBudget()) {
      return reportExhausted(req, bus, attempts);
    }

    // 1. HEALTH GATE — execute() is NEVER reached when !available.
    const h = await adapter.health(model);
    log.record({
      taskId: req.taskId,
      backend,
      phase: 'health',
      available: h.available,
      reason: h.reason,
      requestedModel: model,
      stderrExcerpt: h.detail,
    });
    if (!h.available) {
      bus.logEvent('action', 'hermes_backend_skipped', 'info', {
        backend,
        reason: h.reason ?? null,
      });
      attempts.push({ backend, reason: h.reason });
      continue; // SKIP — never execute a dead/unentitled backend.
    }

    // 2. RETRY LOOP on this (healthy) backend.
    let attempt = 0;
    let lastFailure: Unavailability | undefined;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Budget guard FIRST at the retry boundary.
      if (overBudget()) {
        return reportExhausted(req, bus, attempts);
      }

      // Cap each execute's wall-clock by the remaining budget so a single hung
      // backend cannot blow the whole chain past maxTotalMs.
      const timeoutMs = Math.max(0, Math.min(maxTotalMs, remainingBudget()));

      const r = await adapter.execute(
        { prompt: req.prompt, workdir: req.workdir, model, timeoutMs },
        ctx,
      );

      // Decide the action for THIS attempt up front so the JSONL record carries
      // the real decision (spec §4.3 observability schema + §6.4 assertion 5,
      // which asserts the failover record's decision:'failover'). A non-retryable
      // failure (config-error / no-auth) or an exhausted retry cap ⇒ failover;
      // a retryable failure under the cap ⇒ retry.
      let decision: 'served' | 'failover' | 'retry';
      if (r.ok) {
        decision = 'served';
      } else if (!r.retryable || attempt >= maxRetries(r.failure)) {
        decision = 'failover';
      } else {
        decision = 'retry';
      }

      log.record({
        taskId: req.taskId,
        backend,
        phase: 'execute',
        try: attempt,
        ok: r.ok,
        failure: r.failure,
        retryable: r.retryable,
        requestedModel: model,
        servedModel: r.servedModel ?? null,
        exitCode: r.exitCode,
        stderrExcerpt: r.stderrExcerpt,
        decision,
        nextBackend:
          decision === 'failover' ? nextBackend : decision === 'retry' ? backend : null,
      });

      if (r.ok) {
        return reportServed(req, bus, backend, r, attempts);
      }

      lastFailure = r.failure;

      // Failover (config-error/no-auth = 0 retries; or retry cap exhausted).
      if (decision === 'failover') {
        bus.logEvent('action', 'hermes_failover', 'info', {
          from: backend,
          reason: r.failure ?? null,
          to: nextBackend,
        });
        attempts.push({ backend, reason: r.failure });
        break;
      }

      // Retry: back off, then re-attempt the SAME backend.
      await sleep(backoffMs(attempt));
      attempt++;
    }

    // Record the last failure on this backend was captured in attempts above.
    void lastFailure;
    // Fall through to the next backend in the chain.
  }

  // ---- REPORT (chain exhausted) ----
  return reportExhausted(req, bus, attempts);
}

/** SERVED terminal report — writes result, pings parent, emits the served event. */
function reportServed(
  req: HermesDispatchRequest,
  bus: HermesBus,
  backend: BackendId,
  r: { output?: string; servedModel?: string; usage?: unknown },
  attempts: Array<{ backend: BackendId; reason?: Unavailability }>,
): DispatchOutcome {
  const servedModel = r.servedModel;
  bus.completeTask(req.taskId, r.output ?? '');

  const fallbackNote =
    attempts.length === 0
      ? 'no fallback needed'
      : `after ${attempts.map((a) => `${a.backend}(${a.reason ?? 'failed'})`).join(', ')}`;
  bus.sendMessage(
    req.parent,
    'normal',
    `SERVED by ${backend}/${servedModel ?? 'unknown'}. ${fallbackNote}.`,
    req.replyTo,
  );

  bus.logEvent('action', 'hermes_task_served', 'info', {
    taskId: req.taskId,
    backend,
    servedModel: servedModel ?? null,
    attempts,
    usage: r.usage ?? null,
  });

  return { status: 'served', backend, servedModel, attempts };
}

/** EXHAUSTED terminal report — explicit result, high-priority parent table, event. */
function reportExhausted(
  req: HermesDispatchRequest,
  bus: HermesBus,
  attempts: Array<{ backend: BackendId; reason?: Unavailability }>,
): DispatchOutcome {
  bus.completeTask(req.taskId, 'HERMES_EXHAUSTED');

  const table =
    attempts.length === 0
      ? '(no backends attempted — budget exhausted before first backend)'
      : attempts.map((a) => `  - ${a.backend}: ${a.reason ?? 'unknown failure'}`).join('\n');
  bus.sendMessage(
    req.parent,
    'high',
    `HERMES EXHAUSTED for task ${req.taskId}. No backend could serve.\nChain:\n${table}`,
    req.replyTo,
  );

  bus.logEvent('action', 'hermes_task_exhausted', 'error', {
    taskId: req.taskId,
    chain: attempts,
  });

  return { status: 'exhausted', attempts };
}

/**
 * Production binder — closes over the real bus functions with paths/from/org
 * pre-bound, so the L2-glue / CLI can wire a real HermesBus without
 * re-implementing the effect surface. `from` for sendMessage = agentName.
 */
export function makeBusBinding(
  paths: BusPaths,
  agentName: string,
  org: string,
): HermesBus {
  return {
    completeTask(taskId: string, result: string): void {
      completeTask(paths, taskId, result);
    },
    sendMessage(to: string, priority: 'normal' | 'high', text: string, replyTo?: string): void {
      sendMessage(paths, agentName, to, priority as Priority, text, replyTo);
    },
    logEvent(category: string, name: string, severity: string, meta: Record<string, unknown>): void {
      logEvent(
        paths,
        agentName,
        org,
        category as EventCategory,
        name,
        severity as EventSeverity,
        meta,
      );
    },
  };
}
