// Wave-1 Task #65 — `cortextos swarm` CLI surface.
//
// Thin commander shell over `src/daemon/swarm-runner.ts`. Subcommands:
//   run        — dispatch the swarm
//   status     — progress + ETA + last-N completed
//   collect    — emit consolidated JSONL of all results to stdout
//   reconcile  — per-item diff/agreement view for multi-model runs
//
// Same style as `scope-plugins`: every action delegates to a pure exported
// function in the runner so the unit tests can mock the runner cleanly without
// reparsing argv. CLI is responsible only for argument validation + output
// formatting.

import { Command, Option } from 'commander';
import { existsSync, readFileSync, statSync } from 'fs';
import { resolve as resolvePath } from 'path';
import {
  runSwarm,
  collectResults,
  computeStatus,
  loadSummary,
  summarizeReconcile,
  resolveSwarmRunDir,
  stableJSONStringify,
  type SwarmConfig,
  type SwarmItem,
  type ReconcileMode,
  type SwarmRunResult,
  type SwarmStatus,
  type SwarmDeps,
} from '../daemon/swarm-runner.js';

const VALID_RECONCILE: ReconcileMode[] = ['first', 'all', 'majority'];

/**
 * Parse a JSONL input file into a SwarmItem[]. Blank lines + `#` comments
 * are skipped — matches the worklist format the h1r9do bash launcher used.
 *
 * Each line MUST contain `{ "id": "..." }` (anything else throws). Optional
 * `payload` + arbitrary keys are forwarded to the prompt template.
 */
export function loadItemsFromFile(filePath: string): SwarmItem[] {
  if (!existsSync(filePath)) {
    throw new Error(`Input file not found: ${filePath}`);
  }
  const raw = readFileSync(filePath, 'utf-8');
  const items: SwarmItem[] = [];
  let lineNo = 0;
  for (const line of raw.split('\n')) {
    lineNo++;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`Input line ${lineNo} is not valid JSON: ${(err as Error).message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Input line ${lineNo} must be a JSON object`);
    }
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.id !== 'string' || !obj.id) {
      throw new Error(`Input line ${lineNo} missing required string field 'id'`);
    }
    items.push(obj as SwarmItem);
  }
  if (items.length === 0) {
    throw new Error(`Input file ${filePath} produced 0 items`);
  }
  return items;
}

/**
 * Resolve the prompt template — if `value` points to a readable file, read
 * it; otherwise treat the string itself as the inline template. Same pattern
 * scope-plugins doesn't need but `codex exec --prompt` uses everywhere.
 */
export function resolvePromptTemplate(value: string): string {
  if (!value) throw new Error('--prompt is required');
  try {
    if (existsSync(value) && statSync(value).isFile()) {
      return readFileSync(value, 'utf-8');
    }
  } catch { /* fall through and treat as inline */ }
  return value;
}

/**
 * Format a Date-or-now ms duration into a compact human string.
 * "1m 23s" / "45s" / "1h 02m" — only needed for the CLI's status output.
 */
function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return 'unknown';
  if (ms < 1000) return `${ms}ms`;
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${String(mins).padStart(2, '0')}m`;
}

// ---------------------------------------------------------------------------
// Run subcommand
// ---------------------------------------------------------------------------

export interface RunOptions {
  input: string;
  prompt: string;
  model: string[];
  concurrent?: string;
  reconcile?: string;
  outDir?: string;
  runId?: string;
}

/**
 * Pure wrapper around `runSwarm` — exported so the CLI test can drive the
 * action without re-parsing commander argv. Returns the SwarmRunResult so
 * callers can assert on it.
 */
export async function executeRun(
  options: RunOptions,
  deps: SwarmDeps = {},
  runner: typeof runSwarm = runSwarm,
): Promise<SwarmRunResult> {
  const items = loadItemsFromFile(resolvePath(options.input));
  const promptTemplate = resolvePromptTemplate(options.prompt);
  const models = options.model.filter(m => m && m.trim()).map(m => m.trim());
  if (models.length === 0) {
    throw new Error('At least one --model required');
  }
  const concurrent = options.concurrent ? parseInt(options.concurrent, 10) : 8;
  if (!Number.isFinite(concurrent) || concurrent < 1) {
    throw new Error(`--concurrent must be a positive integer (got ${options.concurrent})`);
  }
  const reconcile = options.reconcile;
  let reconcileMode: ReconcileMode | undefined;
  if (reconcile !== undefined) {
    if (!VALID_RECONCILE.includes(reconcile as ReconcileMode)) {
      throw new Error(`--reconcile must be one of ${VALID_RECONCILE.join('|')} (got ${reconcile})`);
    }
    reconcileMode = reconcile as ReconcileMode;
  }

  const config: SwarmConfig = {
    items,
    promptTemplate,
    model: models.length === 1 ? models[0] : models,
    maxConcurrent: concurrent,
    ...(reconcileMode ? { reconcileMode } : {}),
    ...(options.outDir ? { outDir: options.outDir } : {}),
    ...(options.runId ? { runId: options.runId } : {}),
  };

  const mergedDeps: SwarmDeps = {
    ...deps,
    ...(options.outDir ? { swarmStateRoot: resolvePath(options.outDir) } : deps.swarmStateRoot ? { swarmStateRoot: deps.swarmStateRoot } : {}),
  };

  return runner(config, mergedDeps);
}

const runSubcommand = new Command('run')
  .description('Dispatch a swarm: fan items out across worker(s), persist results, reconcile.')
  .requiredOption('--input <file>', 'JSONL file: one SwarmItem ({id, payload?, ...}) per line')
  .requiredOption('--prompt <template>', 'Prompt template (inline string OR path to a prompt file)')
  .addOption(new Option('--model <name>', 'Worker model name — repeat for multi-model runs')
    .default([] as string[])
    .argParser((value: string, prev: string[] = []) => [...prev, value]))
  .option('--concurrent <n>', 'Max in-flight dispatches (default 8)')
  .addOption(new Option('--reconcile <mode>', 'Reconcile mode for multi-model runs').choices(VALID_RECONCILE as unknown as string[]))
  .option('--out-dir <path>', 'Override run state root (default ~/.cortextos/<instance>/state/swarm)')
  .option('--run-id <id>', 'Override the generated runId (e.g. for deterministic re-runs)')
  .action(async (raw: Record<string, unknown>) => {
    const options: RunOptions = {
      input: raw.input as string,
      prompt: raw.prompt as string,
      model: (raw.model as string[]) ?? [],
      concurrent: raw.concurrent as string | undefined,
      reconcile: raw.reconcile as string | undefined,
      outDir: raw.outDir as string | undefined,
      runId: raw.runId as string | undefined,
    };
    try {
      const out = await executeRun(options);
      console.log(`\n[swarm] runId: ${out.runId}`);
      console.log(`[swarm] runDir: ${out.runDir}`);
      console.log(`[swarm] succeeded=${out.summary.outcomes.succeeded}  failed=${out.summary.outcomes.failed}`);
    } catch (err) {
      console.error(`swarm run: ${(err as Error).message}`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// Status subcommand
// ---------------------------------------------------------------------------

export function formatStatus(status: SwarmStatus): string {
  const lines: string[] = [];
  lines.push(`runId: ${status.runId}`);
  lines.push(`runDir: ${status.runDir}`);
  const totalView = status.totalDispatches !== undefined
    ? `${status.completed}/${status.totalDispatches}`
    : `${status.completed} (run still scheduling)`;
  lines.push(`progress: ${totalView}  ok=${status.succeeded}  fail=${status.failed}`);
  if (status.avgDurationMs > 0) {
    lines.push(`avg dispatch: ${formatDuration(status.avgDurationMs)}`);
  }
  if (status.etaMs !== undefined) {
    lines.push(`eta: ${formatDuration(status.etaMs)}`);
  }
  if (status.recent.length > 0) {
    lines.push(`\nrecent:`);
    for (const r of status.recent) {
      const verdict = r.exitCode === 0 ? 'ok' : `FAIL(${r.exitCode})`;
      lines.push(`  ${verdict.padEnd(10)} ${r.itemId} via ${r.model}  ${formatDuration(r.durationMs)}`);
    }
  }
  return lines.join('\n');
}

const statusSubcommand = new Command('status')
  .description('Show progress, ETA, and last-N completed items for a swarm run.')
  .argument('<runId>', 'Run id (printed by `cortextos swarm run`)')
  .option('--out-dir <path>', 'Override run state root (used by tests)')
  .option('--limit <n>', 'How many recent results to show (default 5)', '5')
  .action((runId: string, opts: { outDir?: string; limit?: string }) => {
    try {
      const deps: SwarmDeps = opts.outDir ? { swarmStateRoot: resolvePath(opts.outDir) } : {};
      const limit = parseInt(opts.limit ?? '5', 10);
      const status = computeStatus(runId, deps, Number.isFinite(limit) ? limit : 5);
      console.log(formatStatus(status));
    } catch (err) {
      console.error(`swarm status: ${(err as Error).message}`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// Collect subcommand
// ---------------------------------------------------------------------------

const collectSubcommand = new Command('collect')
  .description('Emit consolidated JSONL of every result for a swarm run to stdout.')
  .argument('<runId>', 'Run id')
  .option('--out-dir <path>', 'Override run state root (used by tests)')
  .action((runId: string, opts: { outDir?: string }) => {
    try {
      const deps: SwarmDeps = opts.outDir ? { swarmStateRoot: resolvePath(opts.outDir) } : {};
      const results = collectResults(runId, deps);
      for (const r of results) {
        process.stdout.write(JSON.stringify(r) + '\n');
      }
    } catch (err) {
      console.error(`swarm collect: ${(err as Error).message}`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// Reconcile subcommand
// ---------------------------------------------------------------------------

const reconcileSubcommand = new Command('reconcile')
  .description('Emit per-item agreement/divergence report for a multi-model swarm run.')
  .argument('<runId>', 'Run id')
  .option('--out-dir <path>', 'Override run state root (used by tests)')
  .option('--mode <mode>', 'Reconcile mode override (defaults to summary.json value)')
  .option('--json', 'Emit JSON instead of human-readable text')
  .action((runId: string, opts: { outDir?: string; mode?: string; json?: boolean }) => {
    try {
      const deps: SwarmDeps = opts.outDir ? { swarmStateRoot: resolvePath(opts.outDir) } : {};
      const results = collectResults(runId, deps);
      if (results.length === 0) {
        console.error(`swarm reconcile: no results found for ${runId} (dir=${resolveSwarmRunDir(runId, deps)})`);
        process.exit(1);
        return;
      }
      const summary = loadSummary(runId, deps);
      const modeRaw = opts.mode ?? summary?.reconcileMode ?? 'all';
      if (!VALID_RECONCILE.includes(modeRaw as ReconcileMode)) {
        throw new Error(`--mode must be one of ${VALID_RECONCILE.join('|')} (got ${modeRaw})`);
      }
      const mode = modeRaw as ReconcileMode;
      const rows = summarizeReconcile(results, mode);
      if (opts.json) {
        console.log(stableJSONStringify({ runId, mode, rows }));
        return;
      }
      // Human-readable form — close cousin of compare_maps.py's markdown table.
      const total = rows.length;
      const agreed = rows.filter(r => r.agreement).length;
      const disagreed = total - agreed;
      console.log(`runId: ${runId}  mode: ${mode}  items: ${total}  agreement: ${agreed}/${total}  divergent: ${disagreed}`);
      if (disagreed > 0) {
        console.log(`\ndivergent items:`);
        for (const row of rows) {
          if (row.agreement) continue;
          const codes = Object.entries(row.exitCodes)
            .map(([m, c]) => `${m}=${c}`)
            .join(' ');
          const winner = row.majorityWinner ? `  majority="${row.majorityWinner.slice(0, 60)}..."` : '';
          console.log(`  ${row.itemId}  exitCodes(${codes})  divergent=[${row.divergent.join(',')}]${winner}`);
        }
      }
    } catch (err) {
      console.error(`swarm reconcile: ${(err as Error).message}`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// Top-level `swarm` command — registered in src/cli/index.ts
// ---------------------------------------------------------------------------

export const swarmCommand = new Command('swarm')
  .description('Parallel-swarm primitive: fan an item list across worker(s), persist + reconcile results.')
  .addCommand(runSubcommand)
  .addCommand(statusSubcommand)
  .addCommand(collectSubcommand)
  .addCommand(reconcileSubcommand);
