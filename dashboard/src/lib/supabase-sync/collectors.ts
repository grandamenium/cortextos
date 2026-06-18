// Fleet box-side supabase-sync — collectors. Read the agent-written files on the box and shape
// them into rows. Mirrors the read paths of the existing dashboard sync (config.ts), just emitting
// schema-aligned rows instead of writing SQLite. Best-effort + tolerant: a missing/unreadable
// source yields fewer rows, never a throw.
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { CTX_ROOT, CTX_FRAMEWORK_ROOT, getOrgs, getOrgContextPath } from '../config';
import type { OrgRow, AgentRow, HeartbeatRow, CrashRow, CronHealthRow, CronHealthState } from './types';

const readJson = <T>(p: string): T | null => {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')) as T; } catch { return null; }
};
const stateDir = () => path.join(CTX_ROOT, 'state');
const logsDir = () => path.join(CTX_ROOT, 'logs');

// Canonical agents source = `cortextos bus list-agents --org <org> --format json` (enriched
// AgentInfo: name/role/enabled/running/...). Runs on the box where the CLI exists.
function listAgents(org: string): Array<Record<string, unknown>> {
  try {
    const out = execFileSync('cortextos', ['bus', 'list-agents', '--org', org, '--format', 'json'], { encoding: 'utf-8', timeout: 15000 });
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Org dirs are the customer orgs; one row each from its context.json. */
export function collectOrgs(): OrgRow[] {
  const out: OrgRow[] = [];
  for (const slug of getOrgs()) {
    const ctx = readJson<Record<string, string>>(getOrgContextPath(slug)) ?? {};
    out.push({
      slug,
      name: ctx.name ?? slug,
      description: ctx.description ?? null,
      industry: ctx.industry ?? null,
      timezone: ctx.timezone ?? null,
      orchestrator: ctx.orchestrator ?? null,
    });
  }
  return out;
}

/** Agents per org from `list-agents` (canonical: name/role/enabled), enriched with the
 *  framework-dir config.json (runtime/model/timezone) + heartbeat display_name. */
export function collectAgents(): AgentRow[] {
  const out: AgentRow[] = [];
  for (const org of getOrgs()) {
    for (const a of listAgents(org)) {
      const name = String(a.name ?? '');
      if (!name) continue;
      const cfgPath = path.join(CTX_FRAMEWORK_ROOT, 'orgs', org, 'agents', name, 'config.json');
      // HIGH-3: distinguish parse-failure (null) from absent-key ({}).
      // readJson returns null when the file is missing OR malformed; we surface
      // malformed-config as a distinct sentinel so the monitor can flag it.
      const cfgRaw = readJson<Record<string, unknown>>(cfgPath);
      const cfgMalformed = cfgRaw === null && fs.existsSync(cfgPath);
      const cfg = (cfgRaw ?? {}) as Record<string, unknown>;
      const hb = readJson<Record<string, string>>(path.join(stateDir(), name, 'heartbeat.json'));
      // HIGH-2: cfg.runtime ?? null collapses explicit runtime:null → "unset".
      // Daemon REJECTS explicit null (guard: undefined passes, everything else is
      // checked against VALID_RUNTIMES). Preserve the distinction: absent key → null
      // (safe default); key present but null/invalid → emit as-is so monitor flags it.
      const runtimeRaw = cfg.runtime;
      const runtime: string | null = cfgMalformed
        ? '__malformed_config__'
        : !Object.prototype.hasOwnProperty.call(cfg, 'runtime')
          ? null // key absent → unset, defaults to claude-code (valid)
          : runtimeRaw == null
            ? '__explicit_null__' // explicit runtime:null → invalid; daemon rejects this
            : String(runtimeRaw);
      out.push({
        org_slug: org,
        name,
        display_name: (a.display_name as string) ?? hb?.display_name ?? name,
        role: (a.role as string) ?? null,
        enabled: a.enabled !== false,
        runtime,
        model: cfg.model != null ? String(cfg.model) : null,
        timezone: cfg.timezone != null ? String(cfg.timezone) : null,
      });
    }
  }
  return out;
}

/** Largest active .jsonl in a directory, in MB. Returns null if none found. */
function largestJsonlMb(dir: string): number | null {
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    if (!files.length) return null;
    const sizes = files.map((f) => { try { return fs.statSync(path.join(dir, f)).size; } catch { return 0; } });
    const maxBytes = Math.max(...sizes);
    return maxBytes > 0 ? Math.round((maxBytes / (1024 * 1024)) * 100) / 100 : null;
  } catch {
    return null;
  }
}

/** Claude Code session .jsonl dir for an agent: ~/.claude/projects/<encoded-agentDir>/.
 *  Encoding: leading slash stripped, remaining slashes replaced with dashes. */
function claudeSessionDir(agentDir: string): string {
  const encoded = agentDir.replace(/^\//, '').replace(/\//g, '-');
  return path.join(require('os').homedir(), '.claude', 'projects', encoded);
}

/** Largest active Claude Code session .jsonl for a given agent dir, in MB. */
function sessionMbForAgent(agentDir: string): number | null {
  return largestJsonlMb(claudeSessionDir(agentDir));
}

/** True if the daemon's pidfile cwd for this agent matches the registered agent dir. */
function launchPathCanonical(agentName: string, org: string): boolean | null {
  // Pidfile written by the daemon at state/<name>/pid; the process's /proc/<pid>/cwd (or lsof
  // equivalent on macOS) tells us the actual launch dir. We use the simpler heuristic:
  // compare the symlink target of /proc/<pid>/cwd (Linux) against the expected agent dir.
  // On macOS /proc doesn't exist; we skip and return null (unknown).
  // HIGH-1: daemon writes state/<name>/agent.pid (agent-process.ts:427), not 'pid'.
  const pidPath = path.join(stateDir(), agentName, 'agent.pid');
  let pid: number | null = null;
  try {
    pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
    if (isNaN(pid) || pid <= 0) pid = null;
  } catch { /* no pidfile = unknown */ }
  if (!pid) return null;
  // Linux only: /proc/<pid>/cwd is a symlink to the process's working dir
  const procCwd = `/proc/${pid}/cwd`;
  let actualCwd: string | null = null;
  try { actualCwd = fs.realpathSync(procCwd); } catch { return null; }
  const expectedDir = path.join(CTX_FRAMEWORK_ROOT, 'orgs', org, 'agents', agentName);
  return actualCwd === expectedDir;
}

/** One heartbeat row per agent that has a state/<agent>/heartbeat.json. */
export function collectHeartbeats(): HeartbeatRow[] {
  const out: HeartbeatRow[] = [];
  if (!fs.existsSync(stateDir())) return out;
  for (const d of fs.readdirSync(stateDir(), { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const hb = readJson<Record<string, string>>(path.join(stateDir(), d.name, 'heartbeat.json'));
    if (!hb || !hb.org) continue;
    const org = hb.org as string;
    const agentDir = path.join(CTX_FRAMEWORK_ROOT, 'orgs', org, 'agents', d.name);
    out.push({
      org_slug: org,
      agent_name: hb.agent ?? d.name,
      status: hb.status ?? null,
      current_task: hb.current_task ?? null,
      mode: hb.mode ?? null,
      last_heartbeat: hb.last_heartbeat ?? hb.timestamp ?? null,
      loop_interval: hb.loop_interval ?? null,
      launch_path_canonical: launchPathCanonical(d.name, org),
      session_mb: sessionMbForAgent(agentDir),
    });
  }
  return out;
}

// logs/<agent>/crashes.log line: "<ISO> type=X reason=<...> session=<id> last_task=<...>"
const CRASH_RE = /^(\S+)\s+type=(.*?)\s+reason=(.*?)\s+session=(\S+)\s+last_task=(.*)$/;

/** Recent crash/restart rows. `limitPerAgent` caps how many tail lines we ship per agent. */
export function collectCrashLog(orgBySlug: Map<string, string>, limitPerAgent = 50): CrashRow[] {
  const out: CrashRow[] = [];
  if (!fs.existsSync(logsDir())) return out;
  for (const d of fs.readdirSync(logsDir(), { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const org = orgBySlug.get(d.name);
    if (!org) continue; // not a known agent (e.g. oauth/usage dirs)
    const file = path.join(logsDir(), d.name, 'crashes.log');
    let lines: string[];
    try { lines = fs.readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim()); } catch { continue; }
    for (const line of lines.slice(-limitPerAgent)) {
      const m = CRASH_RE.exec(line);
      if (!m) continue;
      out.push({ org_slug: org, agent_name: d.name, ts: m[1], type: m[2] || null, reason: m[3] || null, session_id: m[4] || null, last_task: m[5] || null });
    }
  }
  return out;
}

// state/<agent>/crons.json: { crons: [{name, schedule, last_fired_at?, next_fire_at?, ...}] } (shape
// tolerant). Live health (gap/success-rate) comes from the fleet-health IPC in a later pass; for M1
// we derive a best-effort state from last/next fire so cron_health is populated.
export function collectCronHealth(agentNames: string[], orgBySlug: Map<string, string>): CronHealthRow[] {
  const out: CronHealthRow[] = [];
  for (const agent of agentNames) {
    const org = orgBySlug.get(agent);
    if (!org) continue;
    const data = readJson<{ crons?: Array<Record<string, unknown>> }>(path.join(stateDir(), agent, 'crons.json'));
    const crons = Array.isArray(data?.crons) ? data!.crons : [];
    for (const c of crons) {
      const name = String((c.name as string) ?? (c.cron_name as string) ?? 'cron');
      const lastFired = (c.last_fired_at as string) ?? (c.last_run as string) ?? null;
      const nextFire = (c.next_fire_at as string) ?? (c.next_run as string) ?? null;
      const state: CronHealthState = lastFired ? 'healthy' : 'never_fired';
      out.push({ org_slug: org, agent_name: agent, cron_name: name, health_state: state, last_fired_at: lastFired, next_fire_at: nextFire, gap_ms: null, success_rate_24h: null });
    }
  }
  return out;
}
