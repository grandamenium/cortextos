// Phase 2 CLI verbs: explain, history, ab-compare.
//
// Side-effect: importing this file registers Phase 2 commands. It's imported
// by src/cli/token-audit.ts so the wiring happens automatically.

import { Command } from 'commander';
import { resolveEnv } from '../utils/env.js';
import { parseDurationMs } from '../bus/cron-state.js';
import { readWindow, getStorePaths } from '../analysis/token-audit.js';
import { explain, parseTarget } from '../analysis/explain.js';
import { history as historyRollup, type Bucket } from '../analysis/history.js';
import { abCompare } from '../analysis/ab-compare.js';
import { setPhase2Registrar } from './token-audit-registrars.js';
import { readAnomalies } from '../analysis/store.js';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

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

function countTasksByAgent(ctxRoot: string, org: string, agents: string[], since: Date, until: Date): Map<string, number> {
  const out = new Map<string, number>();
  const sinceMs = since.getTime();
  const untilMs = until.getTime();
  const orgBase = org ? join(ctxRoot, 'orgs', org) : ctxRoot;
  for (const agent of agents) {
    out.set(agent, 0);
    const eventsDir = join(orgBase, 'analytics', 'events', agent);
    if (!existsSync(eventsDir)) continue;
    let files: string[] = [];
    try { files = readdirSync(eventsDir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const file of files) {
      let content: string;
      try { content = readFileSync(join(eventsDir, file), 'utf-8'); } catch { continue; }
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line) as { event?: string; timestamp?: string };
          if (ev.event !== 'task_completed') continue;
          const ts = ev.timestamp ? new Date(ev.timestamp).getTime() : NaN;
          if (!Number.isFinite(ts) || ts < sinceMs || ts > untilMs) continue;
          out.set(agent, (out.get(agent) ?? 0) + 1);
        } catch { /* */ }
      }
    }
  }
  return out;
}

setPhase2Registrar((ta: Command) => {
  // -------------------------------------------------------------------------
  // explain — drill-back
  // -------------------------------------------------------------------------
  ta
    .command('explain')
    .description('Drill-back: agent:X | session:X | anomaly:X | recommendation:X | file:X')
    .argument('<target>', 'Target in kind:value form')
    .option('--since <window>', 'Time window (default 7d)', '7d')
    .option('--format <fmt>', 'text | json', 'text')
    .action((targetStr: string, opts: { since: string; format: string }) => {
      let target;
      try { target = parseTarget(targetStr); } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        process.exit(2);
      }
      const env = resolveEnv();
      const since = parseSince(opts.since, '7d');
      const until = new Date();
      const turns = readWindow({ ctxRoot: env.ctxRoot, org: env.org || '', since, until });
      const store = getStorePaths(env.ctxRoot, env.org || '');
      const result = explain({ target, turns, anomaliesDir: store.anomaliesDir });

      if (isFormatJson(opts)) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(result.summary);
      console.log(`\nevidence (${result.evidence_ids.length} item(s)):`);
      for (const id of result.evidence_ids.slice(0, 20)) console.log(`  ${id}`);
      if (result.evidence_ids.length > 20) console.log(`  ...and ${result.evidence_ids.length - 20} more`);
      if (result.rows.length > 0) {
        console.log(`\nrows (showing first 10 of ${result.rows.length}):`);
        for (const r of result.rows.slice(0, 10)) console.log(`  ${JSON.stringify(r)}`);
      }
    });

  // -------------------------------------------------------------------------
  // history — per-agent timeseries
  // -------------------------------------------------------------------------
  ta
    .command('history')
    .description('Per-agent timeseries rollup')
    .option('--agent <name>', 'Filter to one agent (omit for fleet-wide)')
    .option('--bucket <bucket>', 'day | week | month', 'day')
    .option('--since <window>', 'Time window (default 90d)', '90d')
    .option('--format <fmt>', 'text | json', 'text')
    .action((opts: { agent?: string; bucket: string; since: string; format: string }) => {
      const env = resolveEnv();
      const since = parseSince(opts.since, '90d');
      const until = new Date();
      const turns = readWindow({ ctxRoot: env.ctxRoot, org: env.org || '', since, until });
      const bucket = (['day', 'week', 'month'].includes(opts.bucket) ? opts.bucket : 'day') as Bucket;
      const rows = historyRollup(turns, { agent: opts.agent, bucket });

      if (isFormatJson(opts)) {
        console.log(JSON.stringify({
          since: since.toISOString(),
          until: until.toISOString(),
          agent: opts.agent ?? null,
          bucket,
          rows,
        }, null, 2));
        return;
      }
      console.log(`History — ${opts.agent ?? 'fleet'} — bucket=${bucket} — ${rows.length} bucket(s)`);
      if (rows.length === 0) {
        console.log('(no data)');
        return;
      }
      console.log(`${'bucket'.padEnd(14)}  usd_total  turns`);
      for (const r of rows) {
        console.log(`${r.bucket.padEnd(14).slice(0, 14)}  $${r.usd_total.toFixed(2).padStart(8)}  ${String(r.turn_count).padStart(5)}`);
      }
    });

  // -------------------------------------------------------------------------
  // ab-compare — head-to-head verdict
  // -------------------------------------------------------------------------
  ta
    .command('ab-compare')
    .description('Head-to-head USD/task verdict for a pair')
    .requiredOption('--pair <a:b>', 'Pair in form agentA:agentB')
    .option('--since <window>', 'Time window (default 7d)', '7d')
    .option('--format <fmt>', 'text | json', 'text')
    .action((opts: { pair: string; since: string; format: string }) => {
      const [agentA, agentB] = opts.pair.split(':');
      if (!agentA || !agentB) {
        console.error('--pair must be in form agentA:agentB');
        process.exit(2);
      }
      const env = resolveEnv();
      const since = parseSince(opts.since, '7d');
      const until = new Date();
      const turns = readWindow({ ctxRoot: env.ctxRoot, org: env.org || '', since, until });
      const store = getStorePaths(env.ctxRoot, env.org || '');
      const anomalies = readAnomalies(store, since, until);
      const tasks = countTasksByAgent(env.ctxRoot, env.org || '', [agentA, agentB], since, until);
      const result = abCompare({ agentA, agentB, turns, anomalies, tasksByAgent: tasks, since, until });

      if (isFormatJson(opts)) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`A/B — ${agentA} vs ${agentB} — ${since.toISOString()} → ${until.toISOString()}`);
      for (const row of result.rows) {
        console.log(
          `  ${row.agent.padEnd(14)}  ` +
          `usd=$${row.usd_total.toFixed(2).padStart(8)}  ` +
          `turns=${String(row.turn_count).padStart(4)}  ` +
          `tasks=${String(row.tasks_completed).padStart(3)}  ` +
          `usd/task=$${row.usd_per_task.toFixed(4).padStart(8)}  ` +
          `anomalies=${row.anomaly_count}`,
        );
      }
      console.log(`\nVerdict: ${result.verdict}`);
    });
});
