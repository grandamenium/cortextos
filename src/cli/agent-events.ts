// CLI registration for `cortextos bus read-agent-events` and
// `cortextos bus read-cycle-summary`.
//
// Pull-model fleet comms: agents log routine cycle status to JSONL events
// (analytics/events/<agent>/<date>.jsonl) instead of sending bus messages.
// Boss / analyst / operators query on demand via these verbs.
//
// All wiring lives here. bus.ts only imports `registerAgentEventsCommands`
// and calls it — 2-line touch to upstream, same precedent as token-audit.

import { Command } from 'commander';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { resolveEnv } from '../utils/env.js';
import { parseDurationMs } from '../bus/cron-state.js';

interface EventRecord {
  id: string;
  agent: string;
  org?: string;
  timestamp: string;
  category: string;
  event: string;
  severity: string;
  metadata?: Record<string, unknown>;
}

function isFormatJson(opts: { format?: string }): boolean {
  return (opts.format ?? 'text').toLowerCase() === 'json';
}

function parseSince(s: string | undefined, fallback: string): Date {
  const value = s ?? fallback;
  const ms = parseDurationMs(value);
  if (Number.isFinite(ms)) return new Date(Date.now() - ms);
  const d = new Date(value);
  if (!Number.isNaN(d.getTime())) return d;
  return new Date(Date.now() - parseDurationMs(fallback));
}

function eventsDirFor(ctxRoot: string, agent: string): string {
  return join(ctxRoot, 'analytics', 'events', agent);
}

function datesBetween(since: Date, until: Date): string[] {
  const dates: string[] = [];
  const cursor = new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate()));
  const end = new Date(Date.UTC(until.getUTCFullYear(), until.getUTCMonth(), until.getUTCDate()));
  while (cursor.getTime() <= end.getTime()) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function readEvents(ctxRoot: string, agent: string, since: Date, until: Date): EventRecord[] {
  const dir = eventsDirFor(ctxRoot, agent);
  if (!existsSync(dir)) return [];
  const sinceMs = since.getTime();
  const untilMs = until.getTime();
  const out: EventRecord[] = [];
  for (const date of datesBetween(since, until)) {
    const file = join(dir, `${date}.jsonl`);
    if (!existsSync(file)) continue;
    const lines = readFileSync(file, 'utf-8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line) as EventRecord;
        const ts = new Date(ev.timestamp).getTime();
        if (Number.isFinite(ts) && ts >= sinceMs && ts <= untilMs) out.push(ev);
      } catch {
        // skip malformed lines
      }
    }
  }
  return out.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function listAgents(ctxRoot: string): string[] {
  const dir = join(ctxRoot, 'analytics', 'events');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();
}

function fmtMetaPreview(meta: Record<string, unknown> | undefined, maxLen = 80): string {
  if (!meta) return '';
  const s = JSON.stringify(meta);
  return s.length <= maxLen ? s : `${s.slice(0, maxLen - 1)}…`;
}

export function registerAgentEventsCommands(bus: Command): void {
  // ---------------------------------------------------------------------------
  // read-agent-events — generic event reader
  // ---------------------------------------------------------------------------
  bus
    .command('read-agent-events <agent>')
    .description('Read events from analytics/events/<agent>/*.jsonl (pull-model status reader)')
    .option('--since <window>', 'Time window (e.g. 1h, 24h, 7d) or ISO timestamp', '24h')
    .option('--until <ts>', 'Upper bound ISO timestamp (default: now)')
    .option('--event <name>', 'Filter by event name (e.g. heartbeat_cycle_complete)')
    .option('--category <cat>', 'Filter by category (action, message, metric, ...)')
    .option('--severity <sev>', 'Filter by severity (info, warn, error)')
    .option('--format <fmt>', 'Output format: text | json', 'text')
    .option('--limit <n>', 'Max rows to return', '200')
    .action((agent: string, opts: { since: string; until?: string; event?: string; category?: string; severity?: string; format?: string; limit?: string }) => {
      const env = resolveEnv();
      const since = parseSince(opts.since, '24h');
      const until = opts.until ? new Date(opts.until) : new Date();
      const limit = Math.max(1, parseInt(opts.limit ?? '200', 10) || 200);
      let events = readEvents(env.ctxRoot, agent, since, until);
      if (opts.event) events = events.filter(e => e.event === opts.event);
      if (opts.category) events = events.filter(e => e.category === opts.category);
      if (opts.severity) events = events.filter(e => e.severity === opts.severity);
      events = events.slice(-limit);
      if (isFormatJson(opts)) {
        console.log(JSON.stringify(events, null, 2));
        return;
      }
      if (events.length === 0) {
        console.log(`No events for ${agent} in window ${since.toISOString()} → ${until.toISOString()}`);
        return;
      }
      console.log(`Events for ${agent} (${events.length}, window ${since.toISOString()} → ${until.toISOString()})`);
      console.log('');
      console.log('  Timestamp             Sev    Category   Event                        Meta');
      console.log('  ' + '-'.repeat(110));
      for (const e of events) {
        const ts = e.timestamp.replace('T', ' ').replace(/\..*Z$/, '').replace(/Z$/, '');
        const sev = e.severity.padEnd(6);
        const cat = e.category.padEnd(10);
        const evt = e.event.padEnd(28);
        console.log(`  ${ts}  ${sev} ${cat} ${evt} ${fmtMetaPreview(e.metadata)}`);
      }
    });

  // ---------------------------------------------------------------------------
  // read-cycle-summary — opinionated reader for *_cycle_complete events
  // ---------------------------------------------------------------------------
  bus
    .command('read-cycle-summary [agent]')
    .description('Compact per-cycle status from *_cycle_complete events (pull-model dashboard for boss)')
    .option('--since <window>', 'Time window (e.g. 4h, 24h, 7d)', '24h')
    .option('--cycle <name>', 'Filter cycle type: heartbeat | audit | ingest | standby (default: all)')
    .option('--format <fmt>', 'Output format: text | json', 'text')
    .action((agent: string | undefined, opts: { since: string; cycle?: string; format?: string }) => {
      const env = resolveEnv();
      const since = parseSince(opts.since, '24h');
      const until = new Date();
      const agents = agent ? [agent] : listAgents(env.ctxRoot);
      const wantCycle = opts.cycle;
      const rows: Array<{ agent: string; timestamp: string; cycle: string; state_delta: boolean | null; summary: string; meta: Record<string, unknown> }> = [];
      for (const a of agents) {
        const events = readEvents(env.ctxRoot, a, since, until)
          .filter(e => e.event.endsWith('_cycle_complete'))
          .filter(e => {
            if (!wantCycle) return true;
            return e.event.startsWith(`${wantCycle}_`);
          });
        for (const e of events) {
          const meta = (e.metadata ?? {}) as Record<string, unknown>;
          const cycle = e.event.replace(/_cycle_complete$/, '');
          rows.push({
            agent: a,
            timestamp: e.timestamp,
            cycle,
            state_delta: typeof meta.state_delta === 'boolean' ? meta.state_delta : null,
            summary: typeof meta.summary === 'string' ? meta.summary : '',
            meta,
          });
        }
      }
      rows.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      if (isFormatJson(opts)) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      if (rows.length === 0) {
        const scope = agent ? agent : 'fleet';
        console.log(`No cycle events for ${scope} in last ${opts.since}`);
        return;
      }
      console.log(`Cycle summary (${rows.length} cycle${rows.length === 1 ? '' : 's'}, last ${opts.since})`);
      console.log('');
      console.log('  Timestamp             Agent           Cycle       Δ  Summary');
      console.log('  ' + '-'.repeat(110));
      for (const r of rows) {
        const ts = r.timestamp.replace('T', ' ').replace(/\..*Z$/, '').replace(/Z$/, '');
        const ag = r.agent.padEnd(14);
        const cy = r.cycle.padEnd(10);
        const delta = r.state_delta === true ? '✓' : r.state_delta === false ? ' ' : '?';
        console.log(`  ${ts}  ${ag} ${cy}  ${delta}  ${r.summary || fmtMetaPreview(r.meta, 60)}`);
      }
    });
}
