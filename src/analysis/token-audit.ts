// Token-audit orchestrator. Ties together:
//   ingest (raw → TurnFact) → attribution (already inline) → store (JSONL fact store)
//   → anomaly detection → event emission.
//
// Public API:
//   runAudit(opts)        — one full pass: ingest + detect + persist + emit
//   loadAgents(ctxRoot)   — discover agents to scan (cwd + name pairs)
//   readWindow(opts)      — load TurnFact[] for a window for downstream queries
//
// The audit-run itself is observable: every invocation appends an `audit_runs`
// row and emits `audit_run_started` / `audit_run_completed` events under the
// token-auditor agent's analytics/events directory.

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

import type { BusPaths } from '../types/index.js';
import { logEvent } from '../bus/event.js';

import { ingestAll, type AgentPathHint } from './ingest.js';
import { rollupSessions } from './aggregate.js';
import { detectAll } from './anomalies.js';
import { loadCronCatalog, enrichTriggers } from './trigger-resolution.js';
import { joinCodexTools } from './codex-thread-join.js';
import {
  resolveStorePaths,
  loadSeenTurns,
  persistSeenTurns,
  appendTurns,
  appendAnomalies,
  appendIdleBurn,
  appendAuditRun,
  writeSessions,
  type StorePaths,
} from './store.js';
import type { AuditRun, TurnFact, Anomaly, IdleBurnRow } from './types.js';

export const TOKEN_AUDITOR_AGENT = 'token-auditor';

export interface RunOpts {
  /** ISO 8601 or Date — inclusive lower bound. */
  since: Date;
  /** ISO 8601 or Date — inclusive upper bound (default: now). */
  until?: Date;
  ctxRoot: string;
  /** Org name for analytics path scoping; '' (root) when no org. */
  org: string;
  /** When true, write nothing to disk (used by `--dry-run` callers). */
  dryRun?: boolean;
}

export interface RunResult {
  run_id: string;
  turns_ingested: number;
  turns_new: number;
  // Freshly minted from this invocation — anomaly_id is a new UUID each call.
  // appendAnomalies dedupes by (kind, agent, session_id, evidence_turn_ids),
  // so on re-runs these UUIDs are NOT what's on disk. Read the store via
  // readAnomalies if you need the durable id (e.g. for `explain anomaly:<id>`).
  anomalies: Anomaly[];
  // Same caveat as `anomalies`: re-runs return new in-memory rows; the store
  // is rewritten per (agent, snapshot_date) by appendIdleBurn.
  idle_burn_rows: IdleBurnRow[];
  scanned_files: number;
  duration_ms: number;
  error: string | null;
}

// --- agent discovery -------------------------------------------------------

/**
 * Discover agents to scan. Sources:
 *   1. <ctxRoot>/logs/<agent>/         — any directory with codex-tokens.jsonl or other logs
 *   2. <ctxRoot>/state/<agent>/        — any state dir is a known agent
 *   3. <ctxRoot>/orgs/*\/agents/*       — agents declared in org config
 *   4. ~/.claude/projects/<encoded>    — used to derive cwd back from name (best-effort)
 *
 * The cwd is needed to find the Claude Code transcript path; we recover it
 * from the agent's <agent-dir>/config.json `working_directory` field when
 * present, falling back to a directory walk of the state dir.
 */
export function discoverAgents(ctxRoot: string): AgentPathHint[] {
  const out: AgentPathHint[] = [];
  const seen = new Set<string>();

  // Sweep state/ for canonical agent names.
  const stateDir = join(ctxRoot, 'state');
  if (existsSync(stateDir)) {
    let names: string[] = [];
    try { names = readdirSync(stateDir).filter((d) => !d.startsWith('.')); } catch { /* */ }
    for (const name of names) {
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, cwd: resolveAgentCwd(ctxRoot, name) });
    }
  }

  // Sweep logs/ for codex-only agents (anything not in state/).
  const logsDir = join(ctxRoot, 'logs');
  if (existsSync(logsDir)) {
    let names: string[] = [];
    try { names = readdirSync(logsDir).filter((d) => !d.startsWith('.')); } catch { /* */ }
    for (const name of names) {
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, cwd: resolveAgentCwd(ctxRoot, name) });
    }
  }

  return out;
}

/**
 * Build a BusPaths for an agent, honoring a custom ctxRoot. resolvePaths()
 * rebuilds ctxRoot from homedir() + instanceId, so we can't use it here when
 * the caller has handed us an explicit ctxRoot (e.g. tests, or non-default
 * instance paths).
 */
function buildPaths(ctxRoot: string, agentName: string, org: string): BusPaths {
  const orgBase = org ? join(ctxRoot, 'orgs', org) : ctxRoot;
  return {
    ctxRoot,
    inbox: join(ctxRoot, 'inbox', agentName),
    inflight: join(ctxRoot, 'inflight', agentName),
    processed: join(ctxRoot, 'processed', agentName),
    logDir: join(ctxRoot, 'logs', agentName),
    stateDir: join(ctxRoot, 'state', agentName),
    taskDir: join(orgBase, 'tasks'),
    approvalDir: join(orgBase, 'approvals'),
    analyticsDir: join(orgBase, 'analytics'),
    deliverablesDir: join(orgBase, 'deliverables'),
  };
}

function resolveAgentCwd(ctxRoot: string, agentName: string): string {
  // Look for orgs/*/agents/<agentName>/config.json or .../{agentName}/ dir.
  const orgsDir = join(ctxRoot, 'orgs');
  if (existsSync(orgsDir)) {
    let orgs: string[] = [];
    try { orgs = readdirSync(orgsDir).filter((d) => !d.startsWith('.')); } catch { /* */ }
    for (const org of orgs) {
      const cfg = join(orgsDir, org, 'agents', agentName, 'config.json');
      if (existsSync(cfg)) {
        try {
          const parsed = JSON.parse(readFileSync(cfg, 'utf-8'));
          if (typeof parsed.working_directory === 'string' && parsed.working_directory) {
            return parsed.working_directory;
          }
        } catch { /* */ }
        // Fall back to the agent dir itself.
        return join(orgsDir, org, 'agents', agentName);
      }
    }
  }
  // Last resort: the state dir; transcripts probably won't be found here
  // but ingest tolerates a missing claude projects path.
  return join(ctxRoot, 'state', agentName);
}

// --- completed-task tally for idle-burn detector ---------------------------

function countCompletedTasksByAgent(
  ctxRoot: string,
  org: string,
  agents: string[],
  since: Date,
  until: Date,
): Map<string, number> {
  const out = new Map<string, number>();
  const sinceMs = since.getTime();
  const untilMs = until.getTime();
  for (const agent of agents) {
    out.set(agent, 0);
    const paths = buildPaths(ctxRoot, agent, org);
    const eventsDir = join(paths.analyticsDir, 'events', agent);
    if (!existsSync(eventsDir)) continue;
    let files: string[] = [];
    try {
      files = readdirSync(eventsDir).filter((f) => f.endsWith('.jsonl'));
    } catch { continue; }
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

// --- the run --------------------------------------------------------------

export function runAudit(opts: RunOpts): RunResult {
  const startedAt = new Date();
  const until = opts.until ?? new Date();
  const run_id = randomUUID();
  const auditorPaths = buildPaths(opts.ctxRoot, TOKEN_AUDITOR_AGENT, opts.org || '');
  const store = resolveStorePaths(auditorPaths.analyticsDir);

  // Emit start event (non-fatal if it fails).
  safeEmit(auditorPaths, opts.org, 'audit_run_started', {
    run_id,
    since: opts.since.toISOString(),
    until: until.toISOString(),
  });

  let scanned_files = 0;
  let turns_ingested = 0;
  let turns_new = 0;
  let anomalies: Anomaly[] = [];
  let idleBurnRows: IdleBurnRow[] = [];
  let error: string | null = null;

  try {
    const agents = discoverAgents(opts.ctxRoot);
    const { turns: rawTurns, openers } = ingestAll({
      since: opts.since,
      until,
      ctxRoot: opts.ctxRoot,
      agents,
      auditRunId: run_id,
    });

    // Enrich provenance: trigger resolution + codex tool/file join.
    const catalog = loadCronCatalog(opts.ctxRoot);
    const enriched = enrichTriggers(rawTurns, openers, catalog);
    const turns = joinCodexTools(enriched, opts.ctxRoot);

    turns_ingested = turns.length;
    scanned_files = agents.length;

    // Dedupe against seen-turns index.
    const seen = opts.dryRun ? new Set<string>() : loadSeenTurns(store);
    const fresh: TurnFact[] = [];
    for (const t of turns) {
      if (seen.has(t.turn_id)) continue;
      seen.add(t.turn_id);
      fresh.push(t);
    }
    turns_new = fresh.length;

    // Persist turns + seen-index + sessions BEFORE running anomaly detection.
    // Detection's evidence_turn_ids must already exist in the store so that
    // `explain anomaly:<id>` and downstream drill-backs find them; persisting
    // first removes the in-memory-only window that produced phantom IDs.
    if (!opts.dryRun) {
      if (fresh.length > 0) appendTurns(store, fresh);
      persistSeenTurns(store, seen);
      // Sessions: re-roll up the full window (deterministic; previous rows
      // from the same days are replaced). Group by day-of-start_at.
      const sessions = rollupSessions(turns);
      const byDay = new Map<string, typeof sessions>();
      for (const s of sessions) {
        const day = s.started_at.slice(0, 10);
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day)!.push(s);
      }
      for (const [day, list] of byDay) writeSessions(store, day, list);
    }

    // Detect over the full window (not just fresh turns) so re-runs surface
    // anomalies that depend on cross-turn comparison (e.g. session outliers).
    const completed = countCompletedTasksByAgent(
      opts.ctxRoot,
      opts.org,
      agents.map((a) => a.name),
      opts.since,
      until,
    );
    const windowHours = Math.max(1, (until.getTime() - opts.since.getTime()) / 3_600_000);
    const det = detectAll(turns, { auditRunId: run_id, completedTasksByAgent: completed }, windowHours);
    anomalies = det.anomalies;
    idleBurnRows = det.idleBurnRows;

    if (!opts.dryRun) {
      appendAnomalies(store, anomalies);
      appendIdleBurn(store, idleBurnRows);
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const completedAt = new Date();
  const duration_ms = completedAt.getTime() - startedAt.getTime();
  const run: AuditRun = {
    run_id,
    started_at: startedAt.toISOString(),
    completed_at: completedAt.toISOString(),
    since: opts.since.toISOString(),
    until: until.toISOString(),
    scanned_files,
    turns_ingested,
    anomalies_detected: anomalies.length,
    error,
  };
  if (!opts.dryRun) appendAuditRun(store, run);

  // Emit completion + anomaly events.
  if (error) {
    safeEmit(auditorPaths, opts.org, 'audit_run_failed', { run_id, error, duration_ms });
  } else {
    safeEmit(auditorPaths, opts.org, 'audit_run_completed', {
      run_id,
      duration_ms,
      turns_ingested,
      turns_new,
      anomalies_detected: anomalies.length,
    });
    for (const a of anomalies) {
      safeEmit(auditorPaths, opts.org, 'anomaly_detected', {
        run_id,
        anomaly_id: a.anomaly_id,
        kind: a.kind,
        agent: a.agent,
        usd_impact: a.usd_impact,
      });
    }
  }

  return { run_id, turns_ingested, turns_new, anomalies, idle_burn_rows: idleBurnRows, scanned_files, duration_ms, error };
}

function safeEmit(
  paths: BusPaths,
  org: string,
  eventName: string,
  meta: Record<string, unknown>,
): void {
  try {
    // Audit events are 'metric' category — fits the validated EventCategory enum
    // and matches existing analytics-channel usage in src/bus/metrics.ts.
    logEvent(paths, TOKEN_AUDITOR_AGENT, org, 'metric', eventName, 'info', meta);
  } catch {
    // best-effort
  }
}

// --- public query helper for CLI verbs -------------------------------------

export function readWindow(opts: { ctxRoot: string; org: string; since: Date; until: Date }): TurnFact[] {
  const auditorPaths = buildPaths(opts.ctxRoot, TOKEN_AUDITOR_AGENT, opts.org || '');
  const store: StorePaths = resolveStorePaths(auditorPaths.analyticsDir);
  if (!existsSync(store.turnsDir)) return [];
  // Read all daily files in window.
  const sinceMs = opts.since.getTime();
  const untilMs = opts.until.getTime();
  const sinceDay = opts.since.toISOString().slice(0, 10);
  const untilDay = opts.until.toISOString().slice(0, 10);
  const out: TurnFact[] = [];
  let files: string[];
  try {
    files = readdirSync(store.turnsDir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  for (const file of files) {
    const day = file.replace('.jsonl', '');
    if (day < sinceDay || day > untilDay) continue;
    const content = readFileSync(join(store.turnsDir, file), 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const t = JSON.parse(line) as TurnFact;
        const tMs = new Date(t.ts).getTime();
        if (!Number.isFinite(tMs) || tMs < sinceMs || tMs > untilMs) continue;
        out.push(t);
      } catch {
        // skip
      }
    }
  }
  return out;
}

export function getStorePaths(ctxRoot: string, org: string): StorePaths {
  const p = buildPaths(ctxRoot, TOKEN_AUDITOR_AGENT, org || '');
  return resolveStorePaths(p.analyticsDir);
}
