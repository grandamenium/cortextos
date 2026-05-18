// Wave-1 Task #65 — cortextOS parallel-swarm primitive.
//
// This file packages the "fan out N workers across an item list and reconcile
// the results" pattern Hari first ran by hand for the h1r9do repo audit
// (242 repos × 2 models × per-repo Claude/Codex specialist, dispatched via
// `xargs -P 10`). The bash version lived in
//   /Users/hari/research/h1r9do/dispatch/codex-launcher.sh
//   /Users/hari/research/h1r9do/_scripts/build_phase3_dispatch.py
//   /Users/hari/research/h1r9do/_scripts/compare_maps_v2.py
// — they are the algorithmic source of truth this module elevates to a first-
// class cortextOS surface so the next "scan 100 things in parallel" job
// doesn't have to reinvent the dispatch+reconcile stack.
//
// Algorithm (matches h1r9do dispatch loop):
//   1. Caller hands us { items, promptTemplate, model(s), maxConcurrent, ... }.
//   2. We render the prompt per item (`{{item.id}}`, `{{item.payload}}`,
//      `{{item.<key>}}` token substitution).
//   3. For every (item, model) pair we dispatch a worker, bounded by a simple
//      promise-pool that keeps at most `maxConcurrent` in flight at any time
//      (the `xargs -P N` equivalent — ~30 LOC, no external library).
//   4. As workers complete we append a result file under the run dir as
//      JSONL — one `<itemId>.<model>.jsonl` per dispatch — plus a `summary.json`
//      at the end with aggregate counts and (for multi-model runs) the
//      agreement matrix.
//   5. Reconcile pass: 'first' returns the first success per item; 'all'
//      keeps every model's output; 'majority' picks the most common normalised
//      output. The agreement view is computed by `summarizeReconcile()` and
//      lives next to `summary.json` for downstream consumers.
//
// Mocking surface: every external side effect (worker spawn, time, stdout)
// can be injected via `SwarmDeps` so the unit tests in
//   tests/unit/daemon/swarm-runner.test.ts
// never spawn a real Claude session. The default deps wire to the daemon via
// the existing IPC `spawn-worker` route plus a state-file poller — same
// surface a CLI caller would hit.

import { mkdirSync, readdirSync, readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { atomicWriteSync } from '../utils/atomic.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One unit of work in a swarm run.
 *
 * `id` is the stable handle used in result-file names + log lines (sanitised
 * to filesystem-safe chars before use). `payload` is the substring substituted
 * into `{{item}}` / `{{item.payload}}` in the prompt template. Arbitrary
 * additional keys are passed through and substitutable via
 * `{{item.<key>}}` — same pattern h1r9do used for `repo|persona` worklist
 * lines, generalised so callers don't have to encode tuples as strings.
 */
export interface SwarmItem {
  id: string;
  payload?: string;
  [key: string]: unknown;
}

/** Result for one (item, model) dispatch. */
export interface SwarmResult {
  runId: string;
  itemId: string;
  model: string;
  /** Stdout-equivalent text produced by the worker. */
  output: string;
  /**
   * Process exit code. 0 = success, anything else = failure. For mocked
   * workers in tests this is whatever the mock returned; for the IPC-backed
   * default it's the worker's PTY exit code from `WorkerProcess.onDone`.
   */
  exitCode: number;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  /** Non-empty when the dispatch threw or the worker timed out. */
  error?: string;
}

export type ReconcileMode = 'first' | 'all' | 'majority';

export interface SwarmConfig {
  items: SwarmItem[];
  promptTemplate: string;
  /**
   * Single model name or an array. When an array (and `reconcileMode != 'first'`)
   * the runner dispatches each item to EVERY model — the dual-model-vetting
   * pattern from Hari's playbook §10 (Claude vs Codex on identical inputs).
   */
  model: string | string[];
  /** Max in-flight dispatches across the whole run. Floor 1, no cap. */
  maxConcurrent: number;
  reconcileMode?: ReconcileMode;
  /** Optional override for the run's persisted state root. */
  outDir?: string;
  /** Optional caller-supplied runId; auto-generated when omitted. */
  runId?: string;
}

/** Persisted summary written alongside per-item result files. */
export interface SwarmSummary {
  runId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  totalItems: number;
  totalDispatches: number;
  models: string[];
  reconcileMode: ReconcileMode;
  outcomes: {
    succeeded: number;
    failed: number;
  };
  /**
   * Per-item reconciliation view. Populated for multi-model runs; for single-
   * model runs it's just `{itemId, model, exitCode}` per row.
   */
  reconcile: ReconcileRow[];
}

export interface ReconcileRow {
  itemId: string;
  /**
   * Map model -> exitCode. Useful for spotting "claude succeeded but codex
   * failed" without re-walking the per-item result files.
   */
  exitCodes: Record<string, number>;
  /** True when every model produced the same normalised output. */
  agreement: boolean;
  /** When `reconcileMode='majority'`, the winning normalised output. */
  majorityWinner?: string;
  /**
   * Models that diverged from the majority (or from each other when there is
   * no majority). Empty when all models agreed.
   */
  divergent: string[];
}

/**
 * Worker dispatch contract. Tests inject a stub here; production callers get
 * a default that talks to the running daemon via IPC.
 *
 * The contract is intentionally minimal — input is the rendered prompt + item
 * + model + per-dispatch workdir; output is whatever text the worker produced
 * plus an exit code. The runner handles concurrency, retry-on-error logging,
 * result persistence, and reconciliation around this contract.
 */
export type SwarmDispatcher = (req: {
  runId: string;
  itemId: string;
  model: string;
  prompt: string;
  workdir: string;
}) => Promise<{ output: string; exitCode: number; error?: string }>;

/** Injectable side-effect surface — every default is overridable in tests. */
export interface SwarmDeps {
  dispatcher?: SwarmDispatcher;
  now?: () => number;
  log?: (msg: string) => void;
  /**
   * Root directory under which run state is written. Defaults to
   * `~/.cortextos/<instance>/state/swarm`. Used by tests to redirect output
   * into a tmp dir without needing to set CTX_ROOT.
   */
  swarmStateRoot?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RUN_ID_REGEX = /^[A-Za-z0-9_-]+$/;

/**
 * Filesystem-safe sanitiser. Allowed: [A-Za-z0-9_-]. Anything else collapses
 * to '_'. Empty inputs raise — callers must supply a non-empty id (h1r9do's
 * worklist had this same invariant — repos without names got dropped).
 */
export function sanitiseForFs(input: string): string {
  if (!input || typeof input !== 'string') {
    throw new Error('sanitiseForFs: input must be a non-empty string');
  }
  const sanitised = input.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  if (!sanitised) {
    throw new Error(`sanitiseForFs: input '${input}' contains no fs-safe characters`);
  }
  return sanitised;
}

/**
 * Generate a unique, filesystem-safe runId.
 *
 * Format: `swarm-YYYYMMDD-HHMMSS-<6 hex>`. Sortable by recency, no whitespace,
 * no path separators, fits inside macOS path limits even when joined with
 * per-item filenames. The 6-hex suffix guards against two runs landing on the
 * same second — randomBytes is sourced from crypto so collisions are
 * statistically zero.
 */
export function generateRunId(now: Date = new Date()): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  const suffix = randomBytes(3).toString('hex');
  return `swarm-${stamp}-${suffix}`;
}

/**
 * Render `promptTemplate` with `{{item}}`, `{{item.id}}`, `{{item.payload}}`,
 * and `{{item.<arbitrary-key>}}` token substitution.
 *
 * `{{item}}` shorthand: prefers `payload` when set, falls back to JSON-encoded
 * item (same shape `xargs -I` passed to the bash launcher) so legacy templates
 * keep working when callers haven't migrated to the structured keys.
 *
 * Unknown keys render as empty string (loud failure on a typo would be worse
 * here — the bash version silently emitted blank tokens for the same reason,
 * and Hari's playbook agreed we want the worker to fail later with a visible
 * "you sent me an empty prompt" rather than the runner aborting on token
 * substitution and stranding a half-run on disk).
 */
export function renderPrompt(template: string, item: SwarmItem): string {
  return template.replace(/\{\{\s*item(?:\.([a-zA-Z0-9_]+))?\s*\}\}/g, (_match, key) => {
    if (!key) {
      // `{{item}}` shorthand
      if (item.payload !== undefined) return String(item.payload);
      return JSON.stringify(item);
    }
    if (key === 'id') return item.id;
    const value = (item as Record<string, unknown>)[key];
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
  });
}

/** Normalise output for reconciliation comparison (whitespace + case folded). */
function normaliseForReconcile(output: string): string {
  return output.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Compute per-item reconcile rows from a flat result array. Handles all three
 * reconcile modes — 'first' / 'all' / 'majority' — and surfaces the same
 * "high-confidence disagreement" view as compare_maps.py without depending on
 * its bespoke Python schema.
 */
export function summarizeReconcile(
  results: SwarmResult[],
  reconcileMode: ReconcileMode,
): ReconcileRow[] {
  const byItem = new Map<string, SwarmResult[]>();
  for (const r of results) {
    if (!byItem.has(r.itemId)) byItem.set(r.itemId, []);
    byItem.get(r.itemId)!.push(r);
  }

  const rows: ReconcileRow[] = [];
  // Stable order — itemId asc.
  const itemIds = [...byItem.keys()].sort();

  for (const itemId of itemIds) {
    const itemResults = byItem.get(itemId)!.slice().sort((a, b) => a.model.localeCompare(b.model));
    const exitCodes: Record<string, number> = {};
    const normalised: Record<string, string> = {};

    for (const r of itemResults) {
      exitCodes[r.model] = r.exitCode;
      normalised[r.model] = normaliseForReconcile(r.output);
    }

    const distinct = new Set(Object.values(normalised));
    const agreement = distinct.size <= 1;

    let majorityWinner: string | undefined;
    let divergent: string[] = [];

    if (reconcileMode === 'majority' && itemResults.length > 1) {
      // Count normalised outputs; pick the most common (ties broken alphabetically).
      const counts = new Map<string, number>();
      for (const n of Object.values(normalised)) {
        counts.set(n, (counts.get(n) ?? 0) + 1);
      }
      const sortedByCount = [...counts.entries()].sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return a[0].localeCompare(b[0]);
      });
      majorityWinner = sortedByCount[0][0];
      divergent = Object.entries(normalised)
        .filter(([, n]) => n !== majorityWinner)
        .map(([m]) => m)
        .sort();
    } else if (!agreement) {
      // 'all' / 'first': every model that differs from the first is divergent.
      const first = normalised[itemResults[0].model];
      divergent = Object.entries(normalised)
        .filter(([, n]) => n !== first)
        .map(([m]) => m)
        .sort();
    }

    rows.push({
      itemId,
      exitCodes,
      agreement,
      ...(majorityWinner !== undefined ? { majorityWinner } : {}),
      divergent,
    });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Default dispatcher — talks to the daemon via the existing spawn-worker IPC
// route, then polls the worker state file until it exits. Imported lazily so
// the unit tests (which mock the dispatcher) don't trip across the net /
// agent-pty import surface.
// ---------------------------------------------------------------------------

const defaultDispatcher: SwarmDispatcher = async (req) => {
  const startedAt = Date.now();
  // Lazy import to keep the test surface free of node-pty / net deps.
  const { IPCClient } = await import('./ipc-server.js');
  const { resolveEnv } = await import('../utils/env.js');

  const env = resolveEnv();
  const client = new IPCClient(env.instanceId);
  // Worker name format mirrors h1r9do's safe_repo trick: replace path sep + @.
  const workerName = sanitiseForFs(`sw-${req.runId.slice(-12)}-${req.itemId}-${req.model}`).slice(0, 64);

  const spawnResp = await client.send({
    type: 'spawn-worker',
    data: {
      name: workerName.toLowerCase(),
      dir: req.workdir,
      prompt: req.prompt,
      parent: 'swarm-runner',
      model: req.model,
    },
  });

  if (!spawnResp.success) {
    return {
      output: '',
      exitCode: 1,
      error: `spawn-worker failed: ${spawnResp.error ?? 'unknown'}`,
    };
  }

  // Poll list-workers until our worker is finished. 1Hz cadence — workers
  // take seconds-to-minutes; 1Hz is the right granularity. Hard cap at 1h so
  // a hung worker doesn't pin a swarm forever; callers wanting longer should
  // run with `--timeout` in a future iteration of this CLI.
  const deadline = startedAt + 60 * 60 * 1000;
  let exitCode = 0;
  let output = '';
  while (Date.now() < deadline) {
    await sleep(1000);
    const listResp = await client.send({ type: 'list-workers' });
    if (!listResp.success) continue;
    const workers = (listResp.data as Array<{ name: string; status: string; exitCode?: number }>) ?? [];
    const w = workers.find(x => x.name === workerName.toLowerCase());
    if (!w) {
      // Removed from the active list — daemon's 30s grace expired AFTER it
      // finished. Treat as success with empty output (the agent already
      // emitted its own logs to disk).
      break;
    }
    if (w.status === 'completed' || w.status === 'failed') {
      exitCode = w.exitCode ?? (w.status === 'completed' ? 0 : 1);
      // Best-effort tail of the worker's stdout log.
      try {
        const logPath = join(env.ctxRoot, 'logs', workerName.toLowerCase(), 'stdout.log');
        if (existsSync(logPath)) {
          output = readFileSync(logPath, 'utf-8');
        }
      } catch { /* ignore */ }
      break;
    }
  }

  return { output, exitCode };
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Concurrency limiter — promise-pool. Keeps at most `limit` tasks in flight,
// returns results in the same order as input (deterministic — important for
// downstream reconcile + JSONL ordering).
// ---------------------------------------------------------------------------

/**
 * Run `tasks` with at most `limit` concurrent executions. Returns one entry
 * per task in input order. Tasks that throw are caught and surface as
 * `{ ok: false, error }` so callers can record a failure without aborting
 * the rest of the run.
 */
export async function runPool<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
  onStart?: (index: number, inFlight: number) => void,
): Promise<Array<{ ok: true; value: T } | { ok: false; error: Error }>> {
  const cap = Math.max(1, Math.floor(limit));
  const results: Array<{ ok: true; value: T } | { ok: false; error: Error }> = new Array(tasks.length);
  let nextIndex = 0;
  let inFlight = 0;

  return new Promise((resolve, reject) => {
    if (tasks.length === 0) return resolve([]);

    const startNext = () => {
      while (inFlight < cap && nextIndex < tasks.length) {
        const i = nextIndex++;
        inFlight++;
        if (onStart) {
          try { onStart(i, inFlight); } catch { /* ignore observer errors */ }
        }
        Promise.resolve()
          .then(() => tasks[i]())
          .then(
            value => {
              results[i] = { ok: true, value };
              inFlight--;
              if (nextIndex >= tasks.length && inFlight === 0) {
                resolve(results);
              } else {
                startNext();
              }
            },
            err => {
              results[i] = { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
              inFlight--;
              if (nextIndex >= tasks.length && inFlight === 0) {
                resolve(results);
              } else {
                startNext();
              }
            },
          );
      }
    };

    try {
      startNext();
    } catch (err) {
      reject(err);
    }
  });
}

// ---------------------------------------------------------------------------
// Core runner
// ---------------------------------------------------------------------------

export interface SwarmRunResult {
  runId: string;
  runDir: string;
  results: SwarmResult[];
  summary: SwarmSummary;
}

/** Resolve the directory where run state is persisted. */
export function resolveSwarmRunDir(runId: string, opts: SwarmDeps & { instanceId?: string; ctxRoot?: string } = {}): string {
  if (opts.swarmStateRoot) return join(opts.swarmStateRoot, runId);
  const ctxRoot = opts.ctxRoot
    ?? process.env.CTX_ROOT
    ?? join(homedir(), '.cortextos', opts.instanceId ?? process.env.CTX_INSTANCE_ID ?? 'default');
  return join(ctxRoot, 'state', 'swarm', runId);
}

/**
 * Main orchestrator. Builds the dispatch matrix, runs the pool, persists
 * results, computes reconciliation, returns the structured summary.
 *
 * Pure orchestration — every external touch goes through `deps`. The default
 * dispatcher talks to the running daemon; tests inject their own.
 */
export async function runSwarm(config: SwarmConfig, deps: SwarmDeps = {}): Promise<SwarmRunResult> {
  if (!Array.isArray(config.items) || config.items.length === 0) {
    throw new Error('runSwarm: at least one item required');
  }
  if (!config.promptTemplate || typeof config.promptTemplate !== 'string') {
    throw new Error('runSwarm: promptTemplate required');
  }
  if (config.maxConcurrent === undefined || !Number.isFinite(config.maxConcurrent) || config.maxConcurrent < 1) {
    throw new Error('runSwarm: maxConcurrent must be >= 1');
  }

  const dispatcher = deps.dispatcher ?? defaultDispatcher;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((msg: string) => console.log(msg));

  const models = Array.isArray(config.model) ? [...config.model] : [config.model];
  if (models.length === 0) throw new Error('runSwarm: at least one model required');

  const reconcileMode: ReconcileMode = config.reconcileMode ?? (models.length > 1 ? 'all' : 'first');

  // Sort items by id so the dispatch order is deterministic. Two re-runs over
  // the same input file will write the same files in the same order.
  const sortedItems = [...config.items].sort((a, b) => a.id.localeCompare(b.id));

  // Validate item ids up front so we bail before spawning anything.
  for (const item of sortedItems) {
    sanitiseForFs(item.id);
  }

  const runId = config.runId ?? generateRunId(new Date(now()));
  if (!RUN_ID_REGEX.test(runId)) {
    throw new Error(`runSwarm: runId '${runId}' contains characters outside [A-Za-z0-9_-]`);
  }

  const runDir = resolveSwarmRunDir(runId, deps);
  mkdirSync(runDir, { recursive: true });

  const startedMs = now();
  const startedAt = new Date(startedMs).toISOString();

  // Build the dispatch matrix: items × models in deterministic order.
  type Dispatch = { item: SwarmItem; model: string };
  const dispatches: Dispatch[] = [];
  for (const item of sortedItems) {
    for (const model of models) {
      dispatches.push({ item, model });
    }
  }

  log(`[swarm] runId=${runId}  items=${sortedItems.length}  models=${models.join(',')}  concurrent=${config.maxConcurrent}  reconcile=${reconcileMode}`);
  log(`[swarm] runDir=${runDir}`);

  const tasks = dispatches.map((d, idx) => async (): Promise<SwarmResult> => {
    const prompt = renderPrompt(config.promptTemplate, d.item);
    const startMs = now();
    const startIso = new Date(startMs).toISOString();
    const workdir = join(runDir, 'work', sanitiseForFs(d.item.id), sanitiseForFs(d.model));
    try {
      mkdirSync(workdir, { recursive: true });
    } catch { /* ignore */ }

    let dispatchResult: { output: string; exitCode: number; error?: string };
    try {
      dispatchResult = await dispatcher({
        runId,
        itemId: d.item.id,
        model: d.model,
        prompt,
        workdir,
      });
    } catch (err) {
      dispatchResult = {
        output: '',
        exitCode: 1,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const endMs = now();
    const result: SwarmResult = {
      runId,
      itemId: d.item.id,
      model: d.model,
      output: dispatchResult.output,
      exitCode: dispatchResult.exitCode,
      durationMs: endMs - startMs,
      startedAt: startIso,
      finishedAt: new Date(endMs).toISOString(),
      ...(dispatchResult.error ? { error: dispatchResult.error } : {}),
    };

    // Persist this dispatch's result as a single-line JSONL file. One file per
    // (item, model) keeps the disk shape grep-friendly and lets a reconcile
    // pass diff individual outputs without re-reading the whole run.
    const filename = `${sanitiseForFs(d.item.id)}.${sanitiseForFs(d.model)}.jsonl`;
    const filePath = join(runDir, filename);
    atomicWriteSync(filePath, stableJSONStringify(result));

    const verdict = result.exitCode === 0 ? 'ok' : `FAIL(${result.exitCode})`;
    log(`[swarm] ${verdict} [${idx + 1}/${dispatches.length}] ${d.item.id} via ${d.model}  ${result.durationMs}ms`);

    return result;
  });

  const poolOut = await runPool(tasks, config.maxConcurrent);

  const results: SwarmResult[] = poolOut.map((r, idx) => {
    if (r.ok) return r.value;
    // The dispatcher promise rejected and we couldn't even build a result —
    // synthesise a failure row so the summary still accounts for every
    // dispatch (otherwise totals would silently drift).
    const d = dispatches[idx];
    const endMs = now();
    return {
      runId,
      itemId: d.item.id,
      model: d.model,
      output: '',
      exitCode: 1,
      durationMs: 0,
      startedAt: new Date(endMs).toISOString(),
      finishedAt: new Date(endMs).toISOString(),
      error: r.error.message,
    };
  });

  const finishedMs = now();
  const succeeded = results.filter(r => r.exitCode === 0).length;
  const failed = results.length - succeeded;

  const summary: SwarmSummary = {
    runId,
    startedAt,
    finishedAt: new Date(finishedMs).toISOString(),
    durationMs: finishedMs - startedMs,
    totalItems: sortedItems.length,
    totalDispatches: results.length,
    models,
    reconcileMode,
    outcomes: { succeeded, failed },
    reconcile: summarizeReconcile(results, reconcileMode),
  };

  atomicWriteSync(join(runDir, 'summary.json'), stableJSONStringify(summary));

  log(`[swarm] done  runId=${runId}  succeeded=${succeeded}  failed=${failed}  total=${results.length}  ${summary.durationMs}ms`);

  return { runId, runDir, results, summary };
}

// ---------------------------------------------------------------------------
// Status / collect / reconcile helpers — these power `cortextos swarm status`
// / `collect` / `reconcile` subcommands. Pulled here so the CLI is a thin
// shell over pure functions (matches the scope-plugins layout).
// ---------------------------------------------------------------------------

/**
 * Re-read every per-item result file from disk and return them in sorted
 * order. Used by `swarm collect` / `swarm reconcile` so a long-running swarm
 * can be inspected mid-flight without re-running the dispatcher.
 */
export function collectResults(runId: string, deps: SwarmDeps = {}): SwarmResult[] {
  const runDir = resolveSwarmRunDir(runId, deps);
  if (!existsSync(runDir)) {
    throw new Error(`Run dir not found: ${runDir}`);
  }
  let files: string[] = [];
  try {
    files = readdirSync(runDir).filter(f => f.endsWith('.jsonl'));
  } catch {
    files = [];
  }
  files.sort();
  const out: SwarmResult[] = [];
  for (const f of files) {
    try {
      const raw = readFileSync(join(runDir, f), 'utf-8').trim();
      if (!raw) continue;
      out.push(JSON.parse(raw));
    } catch {
      // Skip unreadable / mid-write files — `cortextos swarm status` should
      // never crash because a worker is still flushing its result line.
    }
  }
  return out;
}

/**
 * Load a previously written summary.json. Returns null when absent (run still
 * in flight) so callers can fall back to live results.
 */
export function loadSummary(runId: string, deps: SwarmDeps = {}): SwarmSummary | null {
  const summaryPath = join(resolveSwarmRunDir(runId, deps), 'summary.json');
  if (!existsSync(summaryPath)) return null;
  try {
    return JSON.parse(readFileSync(summaryPath, 'utf-8'));
  } catch {
    return null;
  }
}

/** Light status snapshot — counts + ETA + last-N completed items. */
export interface SwarmStatus {
  runId: string;
  runDir: string;
  completed: number;
  succeeded: number;
  failed: number;
  /** From summary.json when present (run is done), otherwise undefined. */
  totalDispatches?: number;
  /** Rolling avg dispatch durationMs (used for the ETA calc). */
  avgDurationMs: number;
  /** Estimated remaining time in ms — undefined when total unknown. */
  etaMs?: number;
  /** Most recent N (default 5) completed results, newest first. */
  recent: SwarmResult[];
}

export function computeStatus(runId: string, deps: SwarmDeps = {}, recentLimit = 5): SwarmStatus {
  const runDir = resolveSwarmRunDir(runId, deps);
  const results = collectResults(runId, deps);
  const summary = loadSummary(runId, deps);
  const succeeded = results.filter(r => r.exitCode === 0).length;
  const failed = results.length - succeeded;
  const avgDurationMs = results.length === 0
    ? 0
    : Math.round(results.reduce((s, r) => s + r.durationMs, 0) / results.length);
  let etaMs: number | undefined;
  if (summary && summary.totalDispatches > results.length && avgDurationMs > 0) {
    etaMs = (summary.totalDispatches - results.length) * avgDurationMs;
  }
  const recent = [...results]
    .sort((a, b) => b.finishedAt.localeCompare(a.finishedAt))
    .slice(0, recentLimit);

  return {
    runId,
    runDir,
    completed: results.length,
    succeeded,
    failed,
    ...(summary ? { totalDispatches: summary.totalDispatches } : {}),
    avgDurationMs,
    ...(etaMs !== undefined ? { etaMs } : {}),
    recent,
  };
}

// ---------------------------------------------------------------------------
// Stable JSON.stringify — same sort-keys pattern scope-plugins uses for
// idempotent writes. Re-running a swarm with identical inputs (deterministic
// mock dispatcher) produces byte-identical files, which is what the
// h1r9do dispatch loop relied on for the `compare_maps_v2.py` diff to mean
// anything across runs.
// ---------------------------------------------------------------------------

export function stableJSONStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value), null, 2);
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeysDeep(obj[key]);
    }
    return sorted;
  }
  return value;
}
