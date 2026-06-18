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
    // MED-D: pass resolved CTX_ROOT + CTX_FRAMEWORK_ROOT so the subprocess uses the same
    // paths as the sync process regardless of its cwd (dashboard/ vs project root).
    const out = execFileSync('cortextos', ['bus', 'list-agents', '--org', org, '--format', 'json'], {
      encoding: 'utf-8',
      timeout: 15000,
      env: { ...process.env, CTX_ROOT, CTX_FRAMEWORK_ROOT },
    });
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
    const fromCli = listAgents(org);
    const fromCliNames = new Set(fromCli.map((a) => String(a.name ?? '')).filter(Boolean));
    // Filesystem safety net: scan the agents dir for dirs that list-agents missed.
    // Agents with malformed configs (or no org registration) may be silently omitted by
    // list-agents → their runtime sentinels would never reach Supabase → escape-both.
    // LOW: wrap per-org readdirSync so a perm/race on one org doesn't abort the whole sync.
    const agentsDir = path.join(CTX_FRAMEWORK_ROOT, 'orgs', org, 'agents');
    let fromFs: Array<Record<string, unknown>> = [];
    try {
      if (fs.existsSync(agentsDir)) {
        fromFs = fs.readdirSync(agentsDir, { withFileTypes: true })
          .filter((d) => d.isDirectory() && !fromCliNames.has(d.name))
          .map((d) => ({ name: d.name, enabled: true }));
      }
    } catch { /* best-effort — CLI output is the primary source; skip on error */ }
    for (const a of [...fromCli, ...fromFs]) {
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
      // HIGH-2 + HIGH-B: cfg.runtime ?? null collapses explicit runtime:null → "unset"
      // (null → monitor skips). Daemon REJECTS explicit null and non-string values.
      // Preserve every distinction:
      //   absent key         → null           (unset; defaults to claude-code — valid)
      //   explicit null      → '__explicit_null__'       (invalid; daemon rejects)
      //   non-string value   → '__nonstring_runtime__'   (invalid; daemon rejects)
      //   string value       → the value itself (valid or invalid, monitor checks)
      const runtimeRaw = cfg.runtime;
      const runtime: string | null = cfgMalformed
        ? '__malformed_config__'
        : !Object.prototype.hasOwnProperty.call(cfg, 'runtime')
          ? null
          : runtimeRaw == null
            ? '__explicit_null__'
            : typeof runtimeRaw !== 'string'
              ? '__nonstring_runtime__'
              : runtimeRaw;
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

/** Claude Code session .jsonl dir for an agent.
 *  Encoding matches the daemon (agent-process.ts:820):
 *    launchDir.split(sep).join('-')
 *  Leading path separator becomes a leading dash (e.g. /home/... → -home-...).
 *  Pass the EFFECTIVE launch dir (config.working_directory || agentDir). */
function claudeSessionDir(launchDir: string): string {
  const encoded = launchDir.split(path.sep).join('-');
  return path.join(require('os').homedir(), '.claude', 'projects', encoded);
}

/** Largest active Claude Code session .jsonl for a given EFFECTIVE launch dir, in MB.
 *  Pass config.working_directory || agentDir to match the daemon's PTY cwd. */
function sessionMbForAgent(effectiveLaunchDir: string): number | null {
  return largestJsonlMb(claudeSessionDir(effectiveLaunchDir));
}

/** Resolve the cwd of a running process — cross-platform.
 *  Linux: /proc/<pid>/cwd symlink. macOS: lsof -a -p <pid> -d cwd -Fn (n-prefixed line). */
function getProcessCwd(pid: number): string | null {
  if (process.platform === 'linux') {
    try { return fs.realpathSync(`/proc/${pid}/cwd`); } catch { return null; }
  }
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
        encoding: 'utf-8',
        timeout: 3000,
      });
      const nLine = out.split('\n').find((l) => l.startsWith('n'));
      return nLine ? nLine.slice(1).trim() : null;
    } catch { return null; }
  }
  return null; // unsupported platform
}

/** True if the daemon's pidfile cwd for this agent matches the EFFECTIVE launch dir.
 *  expectedDir = config.working_directory || agentDir (matches PTY cwd in agent-pty.ts:63).
 *  Pass runtime so codex-app-server agents are skipped (app-server cwd ≠ agent dir). */
function launchPathCanonical(agentName: string, expectedDir: string, runtime?: string | null): boolean | null {
  // MED-C: codex-app-server spawns an app-server process whose cwd is NOT the agent dir.
  // Comparing would always false-flag healthy codex agents as stranded.
  if (runtime === 'codex-app-server') return null;
  // HIGH-1: daemon writes state/<name>/agent.pid (agent-process.ts:427).
  const pidPath = path.join(stateDir(), agentName, 'agent.pid');
  let pid: number | null = null;
  try {
    pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
    if (isNaN(pid) || pid <= 0) pid = null;
  } catch { /* no pidfile = unknown */ }
  if (!pid) return null;
  // HIGH-A: /proc/<pid>/cwd is Linux-only; use cross-platform helper.
  const actualCwd = getProcessCwd(pid);
  if (!actualCwd) return null;
  // MED: canonicalize both paths before comparing — on macOS /tmp is a symlink to
  // /private/tmp, so actualCwd (lsof returns resolved path) would never match a raw
  // /tmp-prefixed expectedDir. Try/catch: expectedDir may not exist for a stopped agent.
  try {
    return fs.realpathSync(actualCwd) === fs.realpathSync(expectedDir);
  } catch {
    return null;
  }
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
    // Read runtime + working_directory from config.json.
    // MED: PTY uses config.working_directory || agentDir (agent-pty.ts:63 + agent-process.ts:820).
    // Both launchPathCanonical and sessionMbForAgent must use the same effective dir.
    const agentCfg = readJson<Record<string, unknown>>(path.join(agentDir, 'config.json')) ?? {};
    const agentRuntime = typeof agentCfg.runtime === 'string' ? agentCfg.runtime : null;
    const effectiveDir = (typeof agentCfg.working_directory === 'string' && agentCfg.working_directory)
      ? agentCfg.working_directory
      : agentDir;
    out.push({
      org_slug: org,
      agent_name: hb.agent ?? d.name,
      status: hb.status ?? null,
      current_task: hb.current_task ?? null,
      mode: hb.mode ?? null,
      last_heartbeat: hb.last_heartbeat ?? hb.timestamp ?? null,
      loop_interval: hb.loop_interval ?? null,
      launch_path_canonical: launchPathCanonical(d.name, effectiveDir, agentRuntime),
      // LOW: codex-app-server + hermes have no claude-code session jsonl; returning null
      // avoids false-bloat alerts from stale claude jsonl in the same dir.
      session_mb: (agentRuntime === 'codex-app-server' || agentRuntime === 'hermes')
        ? null
        : sessionMbForAgent(effectiveDir),
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
