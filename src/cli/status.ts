// `cortextos status` — single-shot fleet health view.
//
// Lesson-learned-driven: the 2026-05-17 Wave-1 deploy to the Mac mini
// surfaced two real bugs (codex runtime rename incomplete in
// agent-process.ts, hardcoded `/Users/hari/cortextos` fallback in
// scope-plugins.ts) that no per-area command would have caught at a glance.
// This status command bundles every "is something weird?" signal in one
// place so an operator who suspects trouble can paste a single command
// to a chat log and let the answer fall out.
//
// Sections (in order):
//   1. Host         — currentHostId(), hostname, user, CTX_INSTANCE_ID
//   2. Daemon       — PM2 pid + uptime + restart count (parse `pm2 jlist`)
//   3. Agents       — name, role (agents.yaml), pid, status, uptime
//   4. Bus          — inbox depth + .errors count per agent (flag >5 errs / >10 inbox)
//   5. Breaker      — per-agent restart-breaker state (if a file exists)
//   6. HMAC         — bus-signing-key present? sha256 first 16 chars; grace expiry
//   7. Manifest     — agents.yaml count + drift (agents on disk not in manifest)
//   8. Crashes      — last 3 entries from .daemon-crash-history.json
//
// Output: human-readable text by default, `--json` for machine,
// `--instance <id>` to override the default instance.
//
// Why this lives here (not in doctor / list-agents):
//   doctor.ts is a connectivity + dependency probe (PM2 installed? tunnel
//   running?); list-agents.ts is a per-agent introspection table. status
//   is a fleet-wide "everything in one breath" view that NEEDS to work
//   even when the daemon is down — so it falls back to on-disk artifacts
//   (heartbeats, breaker state files, inbox dirs) when IPC is unreachable.

import { Command } from 'commander';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { homedir, hostname, userInfo } from 'os';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { IPCClient } from '../daemon/ipc-server.js';
import { currentHostId } from '../daemon/agent-manager.js';
import { loadAgentsManifest } from '../daemon/agents-yaml.js';
import type { AgentStatus, Heartbeat } from '../types/index.js';

// ---------------------------------------------------------------------------
// Public types — exported so tests can drive `collectStatus` without going
// through commander, and so future callers (dashboard, alert hook) can reuse
// the same schema instead of re-deriving it.
// ---------------------------------------------------------------------------

/** Human + machine-readable shape returned by `collectStatus`. */
export interface StatusReport {
  host: HostInfo;
  daemon: DaemonInfo;
  agents: AgentRow[];
  bus: BusSummary;
  breaker: BreakerRow[];
  hmac: HmacInfo;
  manifest: ManifestInfo;
  crashes: CrashEntry[];
  /** ISO timestamp this report was generated. */
  generatedAt: string;
  /** Top-level alerts surfaced for the operator (e.g. `>5 errors on sam`). */
  alerts: string[];
}

export interface HostInfo {
  hostId: string;       // currentHostId() — e.g. hari@Haris-MacBook-Pro
  hostname: string;
  user: string;
  instance: string;     // CTX_INSTANCE_ID or 'default'
}

export interface DaemonInfo {
  running: boolean;
  pid?: number;
  uptimeSec?: number;
  restartCount?: number;
  /** Free-form note when daemon state was inferred from non-IPC source. */
  note?: string;
}

export interface AgentRow {
  name: string;
  role?: string;             // from agents.yaml
  pid?: number;
  status: string;            // running / spawning / crashed / halted / stopped / unknown
  uptimeSec?: number;
  lastHeartbeat?: string;    // ISO
  /** Whether the agent appears in agents.yaml. */
  inManifest: boolean;
}

export interface BusSummary {
  /** Per-agent inbox + errors counts, sorted by agent name. */
  rows: BusRow[];
}

export interface BusRow {
  agent: string;
  inbox: number;
  errors: number;
  /** When true, this row exceeded a threshold (>5 errors or >10 inbox). */
  flagged: boolean;
}

export interface BreakerRow {
  agent: string;
  cause: string;
  nextRestartAt?: string;
  delayMs?: number;
}

export interface HmacInfo {
  /** Whether bus-signing-key file exists. */
  keyPresent: boolean;
  /** First 16 hex chars of sha256(keyContents). Useful for cross-host comparison. */
  keyFingerprint?: string;
  /** Grace expiry timestamp (from CTX_BUS_AUTH_GRACE_UNTIL), if set. */
  graceUntil?: string;
  /** True if the grace window is currently active (now < graceUntil). */
  graceActive: boolean;
}

export interface ManifestInfo {
  loaded: boolean;
  agentCount: number;
  /** Agent directory names found on disk that are NOT in agents.yaml. */
  driftOnDisk: string[];
}

export interface CrashEntry {
  ts: string;
  agent?: string;
  cause?: string;
  message?: string;
}

export interface CollectStatusOptions {
  instance?: string;
  /** Override for tests; defaults to `~/.cortextos/<instance>`. */
  ctxRoot?: string;
  /** Override for tests; defaults to CTX_FRAMEWORK_ROOT env var or `~/cortextos`. */
  frameworkRoot?: string;
  /** Override for tests; defaults to live IPC probe. */
  ipcProbe?: () => Promise<AgentStatus[] | null>;
  /** Override for tests; defaults to `pm2 jlist`. Returns parsed JSON or null on failure. */
  pm2Probe?: () => Pm2Process | null;
  /** Override for tests; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/** Subset of `pm2 jlist` row we read. */
export interface Pm2Process {
  pid?: number;
  pm2_env?: {
    pm_uptime?: number;
    restart_time?: number;
    status?: string;
  };
}

// ---------------------------------------------------------------------------
// Core collection function — pure-ish (driven by injectable probes) so the
// commander wrapper and the test suite can both drive it.
// ---------------------------------------------------------------------------

/**
 * Build a complete `StatusReport` from the live system. Each section is
 * collected independently and never throws — a failed section reports
 * "best-effort empty" instead of taking down the whole report, because the
 * point of `status` is to keep working even when half the fleet is on fire.
 */
export async function collectStatus(opts: CollectStatusOptions = {}): Promise<StatusReport> {
  const env = opts.env ?? process.env;
  const instance = opts.instance ?? env.CTX_INSTANCE_ID ?? 'default';
  const ctxRoot = opts.ctxRoot ?? join(homedir(), '.cortextos', instance);
  const frameworkRoot = opts.frameworkRoot ?? env.CTX_FRAMEWORK_ROOT ?? join(homedir(), 'cortextos');

  const host = collectHost(instance, env);
  const daemon = collectDaemon(opts.pm2Probe);
  const manifest = collectManifest(frameworkRoot);
  const agents = await collectAgents(ctxRoot, frameworkRoot, opts.ipcProbe);
  const bus = collectBus(ctxRoot);
  const breaker = collectBreaker(ctxRoot);
  const hmac = collectHmac(ctxRoot, env);
  const crashes = collectCrashes(ctxRoot);

  // Cross-section alerts the operator should see in any output format.
  const alerts: string[] = [];
  for (const row of bus.rows) {
    if (row.errors > 5) alerts.push(`agent ${row.agent}: ${row.errors} bus errors`);
    if (row.inbox > 10) alerts.push(`agent ${row.agent}: ${row.inbox} unread inbox items`);
  }
  for (const row of breaker) {
    alerts.push(`agent ${row.agent}: breaker cooldown (${row.cause})`);
  }
  if (!hmac.keyPresent) {
    alerts.push('bus-signing-key missing — bus messages will be rejected post-grace');
  }
  if (manifest.driftOnDisk.length > 0) {
    alerts.push(`agents on disk not in agents.yaml: ${manifest.driftOnDisk.join(', ')}`);
  }

  return {
    host,
    daemon,
    agents,
    bus,
    breaker,
    hmac,
    manifest,
    crashes,
    generatedAt: new Date().toISOString(),
    alerts,
  };
}

// ---------------------------------------------------------------------------
// Section collectors. Each one swallows its own errors and returns a
// "best-effort empty" shape on failure — never propagate up.
// ---------------------------------------------------------------------------

function collectHost(instance: string, env: NodeJS.ProcessEnv): HostInfo {
  let user = '';
  try {
    user = userInfo().username;
  } catch {
    user = env.USER || env.LOGNAME || 'unknown';
  }
  return {
    hostId: currentHostId(),
    hostname: hostname(),
    user,
    instance,
  };
}

function collectDaemon(probe?: () => Pm2Process | null): DaemonInfo {
  const proc = probe ? probe() : defaultPm2Probe();
  if (!proc) {
    return { running: false, note: 'pm2 unavailable or cortextos-daemon not in pm2 list' };
  }
  const status = proc.pm2_env?.status;
  const running = status === 'online';
  const result: DaemonInfo = { running };
  if (proc.pid !== undefined) result.pid = proc.pid;
  if (proc.pm2_env?.pm_uptime) {
    const uptimeSec = Math.floor((Date.now() - proc.pm2_env.pm_uptime) / 1000);
    if (uptimeSec >= 0) result.uptimeSec = uptimeSec;
  }
  if (proc.pm2_env?.restart_time !== undefined) {
    result.restartCount = proc.pm2_env.restart_time;
  }
  if (!running && status) result.note = `pm2 status: ${status}`;
  return result;
}

/**
 * Default PM2 probe: shell out to `pm2 jlist` and pick the
 * `cortextos-daemon` row. Swallows every error (pm2 missing, jlist
 * non-JSON, etc.) and returns null — the caller renders "not running".
 */
function defaultPm2Probe(): Pm2Process | null {
  try {
    const r = spawnSync('pm2', ['jlist'], { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
    if (r.status !== 0 || !r.stdout) return null;
    const procs = JSON.parse(r.stdout) as Array<Pm2Process & { name?: string }>;
    return procs.find(p => p.name === 'cortextos-daemon') ?? null;
  } catch {
    return null;
  }
}

function collectManifest(frameworkRoot: string): ManifestInfo {
  const manifest = loadAgentsManifest(frameworkRoot);
  if (!manifest) {
    return { loaded: false, agentCount: 0, driftOnDisk: [] };
  }
  const manifestNames = new Set(Object.keys(manifest.agents));

  // Scan orgs/* on disk for agent dirs not in the manifest.
  const driftOnDisk: string[] = [];
  const orgsBase = join(frameworkRoot, 'orgs');
  if (existsSync(orgsBase)) {
    try {
      const orgs = readdirSync(orgsBase, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
      for (const org of orgs) {
        const agentsDir = join(orgsBase, org, 'agents');
        if (!existsSync(agentsDir)) continue;
        try {
          const agentDirs = readdirSync(agentsDir, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name);
          for (const name of agentDirs) {
            if (!manifestNames.has(name)) driftOnDisk.push(name);
          }
        } catch { /* ignore unreadable org */ }
      }
    } catch { /* ignore unreadable orgs base */ }
  }

  return {
    loaded: true,
    agentCount: manifestNames.size,
    driftOnDisk: driftOnDisk.sort(),
  };
}

/**
 * Build the agent rows. Prefers live IPC data (knows true pid + uptime +
 * status); falls back to per-agent heartbeat.json files when the daemon is
 * down (sparse data but still useful).
 */
async function collectAgents(
  ctxRoot: string,
  frameworkRoot: string,
  ipcProbe?: () => Promise<AgentStatus[] | null>,
): Promise<AgentRow[]> {
  const manifest = loadAgentsManifest(frameworkRoot);
  const manifestEntries = manifest?.agents ?? {};

  const live = await safeIpcProbe(ipcProbe, ctxRoot);
  if (live) {
    return live.map(s => {
      const entry = manifestEntries[s.name];
      const row: AgentRow = {
        name: s.name,
        status: s.status,
        inManifest: entry !== undefined,
      };
      if (entry?.role) row.role = entry.role;
      if (s.pid !== undefined) row.pid = s.pid;
      if (s.uptime !== undefined) row.uptimeSec = s.uptime;
      if (s.lastHeartbeat) row.lastHeartbeat = s.lastHeartbeat;
      return row;
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  // No IPC — read on-disk heartbeats. Best-effort and likely stale, but
  // better than reporting "0 agents" when 11 are spawning.
  const stateDir = join(ctxRoot, 'state');
  if (!existsSync(stateDir)) return [];
  let agentDirs: string[] = [];
  try {
    agentDirs = readdirSync(stateDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return [];
  }
  const rows: AgentRow[] = [];
  for (const name of agentDirs) {
    const entry = manifestEntries[name];
    const hbPath = join(stateDir, name, 'heartbeat.json');
    let status = 'unknown';
    let lastHeartbeat: string | undefined;
    try {
      const hb = JSON.parse(readFileSync(hbPath, 'utf-8')) as Heartbeat;
      status = hb.status || 'unknown';
      lastHeartbeat = hb.last_heartbeat ?? hb.timestamp;
    } catch { /* heartbeat unreadable — keep status=unknown */ }
    const row: AgentRow = { name, status, inManifest: entry !== undefined };
    if (entry?.role) row.role = entry.role;
    if (lastHeartbeat) row.lastHeartbeat = lastHeartbeat;
    rows.push(row);
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Run the IPC probe, defaulting to a real IPCClient.send('status'). Returns
 * null when the daemon isn't reachable so callers can fall back to
 * on-disk heartbeats.
 */
async function safeIpcProbe(
  custom: CollectStatusOptions['ipcProbe'],
  ctxRoot: string,
): Promise<AgentStatus[] | null> {
  if (custom) {
    try {
      return await custom();
    } catch {
      return null;
    }
  }
  const instance = ctxRoot.split('/').pop() ?? 'default';
  const ipc = new IPCClient(instance);
  try {
    if (!await ipc.isDaemonRunning()) return null;
    const r = await ipc.send({ type: 'status', source: 'cortextos status' });
    if (!r.success) return null;
    return r.data as AgentStatus[];
  } catch {
    return null;
  }
}

/**
 * Count *.json files per agent inbox and per-agent .errors dir. Mirrors the
 * layout used by src/bus/message.ts: `<ctxRoot>/inbox/<agent>/*.json` and
 * `<ctxRoot>/inbox/<agent>/.errors/*.json`. Falls back to zero when dirs
 * are absent.
 */
function collectBus(ctxRoot: string): BusSummary {
  const inboxBase = join(ctxRoot, 'inbox');
  if (!existsSync(inboxBase)) return { rows: [] };

  let agentDirs: string[] = [];
  try {
    agentDirs = readdirSync(inboxBase, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .filter(n => !n.startsWith('.')); // skip stray hidden dirs
  } catch {
    return { rows: [] };
  }

  const rows: BusRow[] = [];
  for (const agent of agentDirs) {
    const agentInbox = join(inboxBase, agent);
    const errorsDir = join(agentInbox, '.errors');
    const inboxCount = countJsonFiles(agentInbox);
    const errorsCount = countJsonFiles(errorsDir);
    rows.push({
      agent,
      inbox: inboxCount,
      errors: errorsCount,
      flagged: errorsCount > 5 || inboxCount > 10,
    });
  }
  return { rows: rows.sort((a, b) => a.agent.localeCompare(b.agent)) };
}

function countJsonFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir).filter(f => f.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

/**
 * Walk state/<agent>/restart-breaker.json files. The schema isn't fully
 * pinned by the daemon yet (the in-memory breaker holds it, persistence
 * across restarts is a future task). We tolerate any shape with a `cause`
 * field; everything else is optional.
 */
function collectBreaker(ctxRoot: string): BreakerRow[] {
  const stateDir = join(ctxRoot, 'state');
  if (!existsSync(stateDir)) return [];
  let dirs: string[] = [];
  try {
    dirs = readdirSync(stateDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return [];
  }
  const rows: BreakerRow[] = [];
  for (const agent of dirs) {
    const file = join(stateDir, agent, 'restart-breaker.json');
    if (!existsSync(file)) continue;
    try {
      const obj = JSON.parse(readFileSync(file, 'utf-8')) as {
        cause?: string;
        nextRestartAt?: string;
        delayMs?: number;
      };
      const row: BreakerRow = { agent, cause: obj.cause ?? 'unknown' };
      if (obj.nextRestartAt) row.nextRestartAt = obj.nextRestartAt;
      if (typeof obj.delayMs === 'number') row.delayMs = obj.delayMs;
      rows.push(row);
    } catch { /* ignore corrupt file */ }
  }
  return rows.sort((a, b) => a.agent.localeCompare(b.agent));
}

function collectHmac(ctxRoot: string, env: NodeJS.ProcessEnv): HmacInfo {
  const keyPath = join(ctxRoot, 'config', 'bus-signing-key');
  const out: HmacInfo = { keyPresent: false, graceActive: false };
  if (existsSync(keyPath)) {
    out.keyPresent = true;
    try {
      const raw = readFileSync(keyPath, 'utf-8').trim();
      out.keyFingerprint = createHash('sha256').update(raw).digest('hex').slice(0, 16);
    } catch { /* leave fingerprint unset */ }
  }
  const grace = env.CTX_BUS_AUTH_GRACE_UNTIL;
  if (grace) {
    out.graceUntil = grace;
    try {
      const expiresAt = new Date(grace);
      if (!isNaN(expiresAt.getTime())) {
        out.graceActive = new Date() < expiresAt;
      }
    } catch { /* invalid timestamp — leave graceActive=false */ }
  }
  return out;
}

/**
 * Read the daemon's crash-history file (best-effort — file may not exist
 * on a fresh install). Returns the last 3 entries newest-first.
 */
function collectCrashes(ctxRoot: string): CrashEntry[] {
  const file = join(ctxRoot, 'state', '.daemon-crash-history.json');
  if (!existsSync(file)) return [];
  try {
    const obj = JSON.parse(readFileSync(file, 'utf-8')) as unknown;
    if (!Array.isArray(obj)) return [];
    return (obj as CrashEntry[])
      .slice()
      .sort((a, b) => (b.ts ?? '').localeCompare(a.ts ?? ''))
      .slice(0, 3);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Rendering — text + json. Text rendering exported so dashboard / hooks can
// reuse it instead of re-implementing layout.
// ---------------------------------------------------------------------------

/** Format a `StatusReport` as a human-readable text block. */
export function renderStatusText(r: StatusReport): string {
  const lines: string[] = [];
  lines.push(`cortextos status — ${r.generatedAt}`);
  lines.push('');

  lines.push('Host:');
  lines.push(`  hostId:   ${r.host.hostId}`);
  lines.push(`  hostname: ${r.host.hostname}`);
  lines.push(`  user:     ${r.host.user}`);
  lines.push(`  instance: ${r.host.instance}`);
  lines.push('');

  lines.push('Daemon:');
  if (r.daemon.running) {
    lines.push(`  status:   online`);
    if (r.daemon.pid !== undefined) lines.push(`  pid:      ${r.daemon.pid}`);
    if (r.daemon.uptimeSec !== undefined) lines.push(`  uptime:   ${formatUptime(r.daemon.uptimeSec)}`);
    if (r.daemon.restartCount !== undefined) lines.push(`  restarts: ${r.daemon.restartCount}`);
  } else {
    lines.push(`  status:   offline`);
    if (r.daemon.note) lines.push(`  note:     ${r.daemon.note}`);
  }
  lines.push('');

  lines.push(`Agents (${r.agents.length}):`);
  if (r.agents.length === 0) {
    lines.push('  (none)');
  } else {
    lines.push('  Name              Status      PID       Uptime    Role');
    lines.push('  ' + '-'.repeat(70));
    for (const a of r.agents) {
      const name = a.name.padEnd(18);
      const status = (a.status || '-').padEnd(12);
      const pid = (a.pid?.toString() ?? '-').padEnd(10);
      const uptime = (a.uptimeSec !== undefined ? formatUptime(a.uptimeSec) : '-').padEnd(10);
      const role = a.role ?? (a.inManifest ? '-' : '(not in manifest)');
      lines.push(`  ${name}${status}${pid}${uptime}${role}`);
    }
  }
  lines.push('');

  lines.push(`Bus (${r.bus.rows.length} agents):`);
  if (r.bus.rows.length === 0) {
    lines.push('  (no inbox dirs)');
  } else {
    lines.push('  Agent             Inbox     Errors    Flag');
    lines.push('  ' + '-'.repeat(50));
    for (const b of r.bus.rows) {
      const flag = b.flagged ? '! THRESHOLD' : '';
      lines.push(`  ${b.agent.padEnd(18)}${String(b.inbox).padEnd(10)}${String(b.errors).padEnd(10)}${flag}`);
    }
  }
  lines.push('');

  lines.push(`Circuit breaker (${r.breaker.length} in cooldown):`);
  if (r.breaker.length === 0) {
    lines.push('  (none)');
  } else {
    for (const b of r.breaker) {
      const next = b.nextRestartAt ? ` next=${b.nextRestartAt}` : '';
      const delay = b.delayMs !== undefined ? ` delayMs=${b.delayMs}` : '';
      lines.push(`  ${b.agent}: cause=${b.cause}${next}${delay}`);
    }
  }
  lines.push('');

  lines.push('HMAC:');
  lines.push(`  bus-signing-key: ${r.hmac.keyPresent ? 'present' : 'MISSING'}`);
  if (r.hmac.keyFingerprint) lines.push(`  fingerprint:     ${r.hmac.keyFingerprint} (sha256/16)`);
  if (r.hmac.graceUntil) {
    lines.push(`  grace until:     ${r.hmac.graceUntil} (${r.hmac.graceActive ? 'active' : 'expired'})`);
  } else {
    lines.push(`  grace until:     (not set)`);
  }
  lines.push('');

  lines.push('Manifest:');
  if (r.manifest.loaded) {
    lines.push(`  agents.yaml:     loaded (${r.manifest.agentCount} entries)`);
    if (r.manifest.driftOnDisk.length > 0) {
      lines.push(`  drift on disk:   ${r.manifest.driftOnDisk.join(', ')}`);
    } else {
      lines.push(`  drift on disk:   (none)`);
    }
  } else {
    lines.push(`  agents.yaml:     NOT FOUND`);
  }
  lines.push('');

  lines.push(`Recent crashes (${r.crashes.length}):`);
  if (r.crashes.length === 0) {
    lines.push('  (none)');
  } else {
    for (const c of r.crashes) {
      const who = c.agent ? ` agent=${c.agent}` : '';
      const cause = c.cause ? ` cause=${c.cause}` : '';
      const msg = c.message ? ` — ${c.message}` : '';
      lines.push(`  ${c.ts}${who}${cause}${msg}`);
    }
  }
  lines.push('');

  if (r.alerts.length > 0) {
    lines.push('Alerts:');
    for (const a of r.alerts) lines.push(`  ! ${a}`);
    lines.push('');
  }

  return lines.join('\n');
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d${Math.floor((seconds % 86400) / 3600)}h`;
}

// ---------------------------------------------------------------------------
// Commander wrapper. Kept thin — every real decision lives in collectStatus
// so the tests can drive it without simulating argv.
// ---------------------------------------------------------------------------

export const statusCommand = new Command('status')
  .description('One-shot fleet health view: daemon, agents, bus, breaker, HMAC, manifest, crashes')
  .option('--instance <id>', 'Instance ID (default: $CTX_INSTANCE_ID or "default")')
  .option('--json', 'Emit JSON instead of human-readable text')
  .action(async (options: { instance?: string; json?: boolean }) => {
    const report = await collectStatus({ instance: options.instance });
    if (options.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else {
      process.stdout.write(renderStatusText(report) + '\n');
    }
    // Exit code 0 even on alerts — operators want to pipe this through grep
    // without `|| true`. Real failures (`--json` parse?) still throw.
  });
