// CLI registration for `cortextos bus token-audit <subcommand>`.
//
// All subcommand wiring lives here. bus.ts only imports
// `registerTokenAuditCommands` and calls it — a 2-line touch to the upstream
// file. Phase 2 and Phase 3 add their verbs inside this file too, never
// re-touching bus.ts.

import { Command } from 'commander';
import { resolveEnv } from '../utils/env.js';
import { parseDurationMs } from '../bus/cron-state.js';
import { runAudit, readWindow } from '../analysis/token-audit.js';
import { aggregate, type GroupDimension } from '../analysis/aggregate.js';
import type { Anomaly, AnomalyKind, TurnFact } from '../analysis/types.js';

import { getPhase2Registrar, getPhase3Registrar } from './token-audit-registrars.js';
// Side-effect imports: Phase 2 and Phase 3 modules call setPhase2Registrar /
// setPhase3Registrar (from the registrars module — a separate tiny module so
// that token-audit.ts and the phase modules don't form an import cycle).
// Importing them here keeps the upstream bus.ts edit to exactly 2 lines
// across all phases.
import './token-audit-phase2.js';
import './token-audit-phase3.js';

// Default thresholds — overridable via env.
const DEFAULT_DAILY_USD_LIMIT = 50;
const DEFAULT_HOURLY_USD_LIMIT = 10;

function envFloat(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function parseSince(s: string | undefined, fallback: string): Date {
  const value = s ?? fallback;
  const ms = parseDurationMs(value);
  if (Number.isFinite(ms)) return new Date(Date.now() - ms);
  const d = new Date(value);
  if (!Number.isNaN(d.getTime())) return d;
  return new Date(Date.now() - parseDurationMs(fallback));
}

function isFormatJson(opts: { format?: string }): boolean {
  return (opts.format ?? 'text').toLowerCase() === 'json';
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(n < 0.01 && n !== 0 ? 4 : 2)}`;
}

function fmtRange(since: Date, until: Date): string {
  return `${since.toISOString()} → ${until.toISOString()}`;
}

export function registerTokenAuditCommands(bus: Command): void {
  const ta = new Command('token-audit').description('Token observability + anomaly detection');

  // -------------------------------------------------------------------------
  // run — orchestrator: ingest + detect + persist
  // -------------------------------------------------------------------------
  ta
    .command('run')
    .description('Ingest token logs, detect anomalies, persist to fact store')
    .option('--since <window>', 'Time window (e.g. 1h, 24h, 7d)', '24h')
    .option('--dry-run', 'Detect + report without writing fact store')
    .action((opts: { since: string; dryRun?: boolean }) => {
      const env = resolveEnv();
      const since = parseSince(opts.since, '24h');
      const result = runAudit({
        since,
        ctxRoot: env.ctxRoot,
        org: env.org || '',
        dryRun: opts.dryRun,
      });
      console.log(JSON.stringify({
        run_id: result.run_id,
        turns_ingested: result.turns_ingested,
        turns_new: result.turns_new,
        anomalies_detected: result.anomalies.length,
        duration_ms: result.duration_ms,
        error: result.error,
      }, null, 2));
      if (result.error) process.exit(2);
    });

  // -------------------------------------------------------------------------
  // summary — top-line spend by agent | model | day
  // -------------------------------------------------------------------------
  ta
    .command('summary')
    .description('Top-line token spend rollup')
    .option('--since <window>', 'Time window (default 24h)', '24h')
    .option('--by <dim>', 'agent | model | day', 'agent')
    .option('--format <fmt>', 'text | json', 'text')
    .action((opts: { since: string; by: string; format: string }) => {
      const env = resolveEnv();
      const since = parseSince(opts.since, '24h');
      const until = new Date();
      const turns = readWindow({ ctxRoot: env.ctxRoot, org: env.org || '', since, until });
      const dim = (['agent', 'model', 'day'].includes(opts.by) ? opts.by : 'agent') as GroupDimension;
      const result = aggregate(turns, dim);

      if (isFormatJson(opts)) {
        console.log(JSON.stringify({
          since: since.toISOString(),
          until: until.toISOString(),
          by: dim,
          rows: result.rows,
          totals: { ...result.totals, evidence_ids: undefined },
        }, null, 2));
        return;
      }

      console.log(`Token spend — by ${dim} — ${fmtRange(since, until)}`);
      console.log(`Total: ${fmtUsd(result.totals.usd_total)} over ${result.totals.turn_count} turns\n`);
      if (result.rows.length === 0) {
        console.log('(no data)');
        return;
      }
      console.log(`${dim.padEnd(20)}  usd_total  turns`);
      for (const r of result.rows.slice(0, 20)) {
        console.log(`${r.key.padEnd(20).slice(0, 20)}  ${fmtUsd(r.usd_total).padStart(9)}  ${String(r.turn_count).padStart(5)}`);
      }
    });

  // -------------------------------------------------------------------------
  // attribution — slice spend by attribution dimension
  // -------------------------------------------------------------------------
  ta
    .command('attribution')
    .description('Attribution rollup by tool, file, subagent, bash-verb, or trigger')
    .option('--by <dim>', 'tool | file | subagent | bash-verb | trigger | agent-x-trigger', 'tool')
    .option('--since <window>', 'Time window (default 24h)', '24h')
    .option('--top <n>', 'Top N rows', '20')
    .option('--format <fmt>', 'text | json', 'text')
    .action((opts: { by: string; since: string; top: string; format: string }) => {
      const env = resolveEnv();
      const since = parseSince(opts.since, '24h');
      const until = new Date();
      const turns = readWindow({ ctxRoot: env.ctxRoot, org: env.org || '', since, until });
      const validDims: GroupDimension[] = ['tool', 'file', 'subagent', 'bash-verb', 'trigger', 'agent-x-trigger'];
      const dim = (validDims.includes(opts.by as GroupDimension) ? opts.by : 'tool') as GroupDimension;
      const result = aggregate(turns, dim);
      const top = parseInt(opts.top, 10) || 20;
      const rows = result.rows.slice(0, top);

      if (isFormatJson(opts)) {
        console.log(JSON.stringify({
          since: since.toISOString(),
          until: until.toISOString(),
          by: dim,
          rows,
          totals: { ...result.totals, evidence_ids: undefined },
        }, null, 2));
        return;
      }

      console.log(`Attribution — by ${dim} — ${fmtRange(since, until)}`);
      console.log(`Total: ${fmtUsd(result.totals.usd_total)} over ${result.totals.turn_count} turns\n`);
      if (rows.length === 0) {
        console.log('(no data)');
        return;
      }
      const w = 40;
      console.log(`${dim.padEnd(w)}  usd_total  turns`);
      for (const r of rows) {
        console.log(`${r.key.padEnd(w).slice(0, w)}  ${fmtUsd(r.usd_total).padStart(9)}  ${String(r.turn_count).padStart(5)}`);
      }
    });

  // -------------------------------------------------------------------------
  // anomalies — list anomalies (since window)
  // -------------------------------------------------------------------------
  ta
    .command('anomalies')
    .description('List detected anomalies in the window')
    .option('--since <window>', 'Time window (default 24h)', '24h')
    .option('--kind <kind>', 'outlier_session | cache_runaway | compact_candidate | idle_burn | trigger_addiction | model_mismatch')
    .option('--format <fmt>', 'text | json', 'text')
    .action((opts: { since: string; kind?: string; format: string }) => {
      const env = resolveEnv();
      const since = parseSince(opts.since, '24h');
      const until = new Date();
      const result = runAudit({
        since,
        until,
        ctxRoot: env.ctxRoot,
        org: env.org || '',
        dryRun: true,
      });
      let anomalies: Anomaly[] = result.anomalies;
      if (opts.kind) {
        const kinds: AnomalyKind[] = ['outlier_session', 'cache_runaway', 'compact_candidate', 'idle_burn', 'trigger_addiction', 'model_mismatch'];
        if (kinds.includes(opts.kind as AnomalyKind)) {
          anomalies = anomalies.filter((a) => a.kind === opts.kind);
        }
      }
      if (isFormatJson(opts)) {
        console.log(JSON.stringify({
          since: since.toISOString(),
          until: until.toISOString(),
          anomalies,
        }, null, 2));
        return;
      }

      console.log(`Anomalies — ${fmtRange(since, until)} — ${anomalies.length} detected`);
      if (anomalies.length === 0) {
        console.log('(none)');
        return;
      }
      for (const a of anomalies) {
        console.log(`\n[${a.severity.toUpperCase()}] ${a.kind} — ${a.agent} — impact ${fmtUsd(a.usd_impact)}`);
        console.log(`  ${a.why_text}`);
        console.log(`  evidence: ${a.evidence_turn_ids.length} turn(s) — id=${a.anomaly_id}`);
      }
    });

  // -------------------------------------------------------------------------
  // idle-burn — per-agent usd-vs-tasks table
  // -------------------------------------------------------------------------
  ta
    .command('idle-burn')
    .description('Per-agent throughput-vs-spend table')
    .option('--since <window>', 'Time window (default 24h)', '24h')
    .option('--format <fmt>', 'text | json', 'text')
    .action((opts: { since: string; format: string }) => {
      const env = resolveEnv();
      const since = parseSince(opts.since, '24h');
      const until = new Date();
      const result = runAudit({
        since,
        until,
        ctxRoot: env.ctxRoot,
        org: env.org || '',
        dryRun: true,
      });
      if (isFormatJson(opts)) {
        console.log(JSON.stringify({
          since: since.toISOString(),
          until: until.toISOString(),
          rows: result.idle_burn_rows,
        }, null, 2));
        return;
      }
      console.log(`Idle-burn — ${fmtRange(since, until)}`);
      if (result.idle_burn_rows.length === 0) {
        console.log('(no data)');
        return;
      }
      console.log(`${'agent'.padEnd(20)}  usd_spent  tasks  usd/task   verdict`);
      for (const r of result.idle_burn_rows) {
        console.log(
          `${r.agent.padEnd(20).slice(0, 20)}  ` +
          `${fmtUsd(r.usd_spent).padStart(9)}  ` +
          `${String(r.tasks_completed).padStart(5)}  ` +
          `${fmtUsd(r.usd_per_task).padStart(8)}   ` +
          `${r.verdict}`,
        );
      }
    });

  // -------------------------------------------------------------------------
  // alert-check — exit 1 + JSON if window USD breaches thresholds
  // -------------------------------------------------------------------------
  ta
    .command('alert-check')
    .description('Threshold breach check; exits 1 on breach')
    .option('--threshold-daily-usd <n>', 'Daily USD limit (default env TOKEN_AUDIT_DAILY_USD_LIMIT or 50)')
    .option('--threshold-hourly-usd <n>', 'Hourly USD limit (default env TOKEN_AUDIT_HOURLY_USD_LIMIT or 10)')
    .action((opts: { thresholdDailyUsd?: string; thresholdHourlyUsd?: string }) => {
      const env = resolveEnv();
      const dailyLimit = opts.thresholdDailyUsd
        ? parseFloat(opts.thresholdDailyUsd)
        : envFloat('TOKEN_AUDIT_DAILY_USD_LIMIT', DEFAULT_DAILY_USD_LIMIT);
      const hourlyLimit = opts.thresholdHourlyUsd
        ? parseFloat(opts.thresholdHourlyUsd)
        : envFloat('TOKEN_AUDIT_HOURLY_USD_LIMIT', DEFAULT_HOURLY_USD_LIMIT);

      const now = new Date();
      const dayAgo = new Date(now.getTime() - 86_400_000);
      const hourAgo = new Date(now.getTime() - 3_600_000);

      const turnsDay: TurnFact[] = readWindow({ ctxRoot: env.ctxRoot, org: env.org || '', since: dayAgo, until: now });
      const turnsHour = turnsDay.filter((t) => new Date(t.ts).getTime() >= hourAgo.getTime());

      const dailyUsd = turnsDay.reduce((s, t) => s + t.usd_total, 0);
      const hourlyUsd = turnsHour.reduce((s, t) => s + t.usd_total, 0);

      const breaches: string[] = [];
      if (dailyUsd > dailyLimit) breaches.push(`daily ${fmtUsd(dailyUsd)} > ${fmtUsd(dailyLimit)}`);
      if (hourlyUsd > hourlyLimit) breaches.push(`hourly ${fmtUsd(hourlyUsd)} > ${fmtUsd(hourlyLimit)}`);

      const result = {
        checked_at: now.toISOString(),
        daily_usd: dailyUsd,
        hourly_usd: hourlyUsd,
        daily_limit: dailyLimit,
        hourly_limit: hourlyLimit,
        breached: breaches.length > 0,
        breaches,
      };
      console.log(JSON.stringify(result, null, 2));
      if (result.breached) process.exit(1);
    });

  // Phase 2 + 3 commands plug in here so bus.ts never re-edits.
  const p2 = getPhase2Registrar(); if (p2) p2(ta);
  const p3 = getPhase3Registrar(); if (p3) p3(ta);

  bus.addCommand(ta);
}
