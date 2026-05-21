#!/usr/bin/env node
/**
 * external-health-monitor.ts
 *
 * Standalone watchdog process that runs OUTSIDE the cortextOS daemon.
 * Key design constraint: this process must survive daemon crashes and be
 * able to restart the daemon itself.  It intentionally uses only direct
 * filesystem reads (no IPC socket to the daemon).
 *
 * Responsibilities:
 *   1. Poll every 60 s for stale agent heartbeats (>45 min).
 *   2. Poll health-probe.json files written by daemon-side probes; trigger
 *      recovery when status = "degraded" for > 5 min.
 *   3. Check the daemon PID file; restart via pm2 when dead.
 *   4. Debounce recoveries: no agent recovered more than once per 10 min.
 *   5. Log everything with [external-health-monitor] prefix to stdout AND
 *      a persistent recovery log.
 *
 * Usage:
 *   node dist/scripts/external-health-monitor.js
 *
 * Environment variables:
 *   CTX_ROOT          — overrides default ~/.cortextos/<CTX_INSTANCE_ID|default>
 *   CTX_INSTANCE_ID   — used when CTX_ROOT is absent
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, appendFileSync } from 'fs';
import { execSync } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS        = 60_000;   // 1 minute
const HEARTBEAT_STALE_MS      = 45 * 60_000; // 45 minutes
const DEGRADED_STALE_MS       = 5  * 60_000; // 5 minutes
const RECOVERY_DEBOUNCE_MS    = 10 * 60_000; // 10 minutes

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function resolveCtxRoot(): string {
  if (process.env.CTX_ROOT) return process.env.CTX_ROOT;
  const instanceId = process.env.CTX_INSTANCE_ID || 'default';
  return join(homedir(), '.cortextos', instanceId);
}

const CTX_ROOT       = resolveCtxRoot();
const STATE_DIR      = join(CTX_ROOT, 'state');
const CONFIG_DIR     = join(CTX_ROOT, 'config');
const DAEMON_PID_FILE = join(CTX_ROOT, 'daemon.pid');
const MONITOR_LOG_DIR = join(CTX_ROOT, 'logs', 'external-health-monitor');
const RECOVERY_LOG    = join(MONITOR_LOG_DIR, 'recovery.log');

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function ensureLogDir(): void {
  try {
    mkdirSync(MONITOR_LOG_DIR, { recursive: true });
  } catch {
    // ignore — worst case logs go only to stdout
  }
}

function log(level: 'INFO' | 'WARN' | 'ERROR', agentName: string | null, message: string): void {
  const ts = new Date().toISOString();
  const agent = agentName ? ` agent=${agentName}` : '';
  const line = `[external-health-monitor] ${ts} ${level}${agent} ${message}`;
  console.log(line);
  try {
    appendFileSync(RECOVERY_LOG, line + '\n');
  } catch {
    // continue without file logging
  }
}

// ---------------------------------------------------------------------------
// State dedup — track last recovery per agent
// ---------------------------------------------------------------------------

const lastRecoveryAt = new Map<string, number>();

function canRecover(agentName: string): boolean {
  const last = lastRecoveryAt.get(agentName) ?? 0;
  return Date.now() - last > RECOVERY_DEBOUNCE_MS;
}

function markRecovered(agentName: string): void {
  lastRecoveryAt.set(agentName, Date.now());
}

// ---------------------------------------------------------------------------
// Recovery actions
// ---------------------------------------------------------------------------

function recoverAgent(agentName: string, reason: string): void {
  if (!canRecover(agentName)) {
    log('INFO', agentName, `recovery debounced (< ${RECOVERY_DEBOUNCE_MS / 60_000} min since last attempt)`);
    return;
  }
  markRecovered(agentName);
  log('WARN', agentName, `triggering recovery: ${reason}`);
  try {
    execSync(`cortextos start ${agentName}`, { encoding: 'utf-8', timeout: 30_000 });
    log('INFO', agentName, 'cortextos start completed successfully');
  } catch (err) {
    // Expected when the agent is already running — log but continue
    log('ERROR', agentName, `cortextos start failed (may be already running): ${err instanceof Error ? err.message : String(err)}`);
  }
}

function recoverDaemon(): void {
  const key = '__daemon__';
  if (!canRecover(key)) {
    log('INFO', null, 'daemon recovery debounced');
    return;
  }
  markRecovered(key);
  log('WARN', null, 'daemon PID is dead — running pm2 restart cortextos-daemon');
  try {
    execSync('pm2 restart cortextos-daemon', { encoding: 'utf-8', timeout: 30_000 });
    log('INFO', null, 'pm2 restart cortextos-daemon completed successfully');
  } catch (err) {
    log('ERROR', null, `pm2 restart failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Daemon health check
// ---------------------------------------------------------------------------

function checkDaemonHealth(): void {
  if (!existsSync(DAEMON_PID_FILE)) {
    // No PID file means daemon was never started or already cleaned up —
    // don't restart, just note it so we don't spam recovery.
    return;
  }
  let pid: number;
  try {
    pid = parseInt(readFileSync(DAEMON_PID_FILE, 'utf-8').trim(), 10);
    if (!Number.isFinite(pid) || pid <= 0) return;
  } catch {
    return;
  }
  try {
    process.kill(pid, 0); // Signal 0 — just checks if the process exists
    // Process is alive — nothing to do.
  } catch {
    log('WARN', null, `daemon PID ${pid} is not alive`);
    recoverDaemon();
  }
}

// ---------------------------------------------------------------------------
// Enabled-agent list
// ---------------------------------------------------------------------------

interface EnabledAgentEntry {
  enabled?: boolean;
  org?: string;
}

function readEnabledAgents(): Set<string> {
  const enabledFile = join(CONFIG_DIR, 'enabled-agents.json');
  if (!existsSync(enabledFile)) return new Set();
  try {
    const data: Record<string, EnabledAgentEntry> = JSON.parse(readFileSync(enabledFile, 'utf-8'));
    const enabled = new Set<string>();
    for (const [name, cfg] of Object.entries(data)) {
      if (cfg.enabled !== false) enabled.add(name);
    }
    return enabled;
  } catch {
    return new Set();
  }
}

// ---------------------------------------------------------------------------
// Heartbeat check
// ---------------------------------------------------------------------------

interface HeartbeatFile {
  last_heartbeat?: string;
  agent?: string;
  status?: string;
}

function checkAgentHeartbeats(enabledAgents: Set<string>): void {
  if (!existsSync(STATE_DIR)) return;

  let agentDirs: string[];
  try {
    agentDirs = readdirSync(STATE_DIR);
  } catch {
    return;
  }

  const now = Date.now();

  for (const agentName of agentDirs) {
    // Only check agents that are in the enabled set (if that list is available)
    if (enabledAgents.size > 0 && !enabledAgents.has(agentName)) continue;

    const hbFile = join(STATE_DIR, agentName, 'heartbeat.json');
    if (!existsSync(hbFile)) continue;

    let hb: HeartbeatFile;
    try {
      hb = JSON.parse(readFileSync(hbFile, 'utf-8'));
    } catch {
      continue;
    }

    if (!hb.last_heartbeat) continue;

    const lastHb = new Date(hb.last_heartbeat).getTime();
    if (isNaN(lastHb)) continue;

    const ageMs = now - lastHb;
    if (ageMs > HEARTBEAT_STALE_MS) {
      const ageMins = Math.round(ageMs / 60_000);
      recoverAgent(agentName, `heartbeat stale by ${ageMins} min (threshold: ${HEARTBEAT_STALE_MS / 60_000} min)`);
    }
  }
}

// ---------------------------------------------------------------------------
// Health-probe check (written by PR-E daemon-side probes)
// ---------------------------------------------------------------------------

interface HealthProbeFile {
  status?: 'ok' | 'degraded' | string;
  timestamp?: string;
  degraded_since?: string;
  reason?: string;
}

function checkHealthProbes(enabledAgents: Set<string>): void {
  if (!existsSync(STATE_DIR)) return;

  let agentDirs: string[];
  try {
    agentDirs = readdirSync(STATE_DIR);
  } catch {
    return;
  }

  const now = Date.now();

  for (const agentName of agentDirs) {
    if (enabledAgents.size > 0 && !enabledAgents.has(agentName)) continue;

    const probeFile = join(STATE_DIR, agentName, 'health-probe.json');
    if (!existsSync(probeFile)) continue;

    let probe: HealthProbeFile;
    try {
      probe = JSON.parse(readFileSync(probeFile, 'utf-8'));
    } catch {
      continue;
    }

    if (probe.status !== 'degraded') continue;

    // Use degraded_since if available; fall back to the probe timestamp.
    const degradedSinceStr = probe.degraded_since || probe.timestamp;
    if (!degradedSinceStr) continue;

    const degradedSince = new Date(degradedSinceStr).getTime();
    if (isNaN(degradedSince)) continue;

    const degradedForMs = now - degradedSince;
    if (degradedForMs > DEGRADED_STALE_MS) {
      const degradedMins = Math.round(degradedForMs / 60_000);
      const reason = probe.reason ? ` (${probe.reason})` : '';
      recoverAgent(agentName, `health-probe degraded for ${degradedMins} min${reason}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main poll loop
// ---------------------------------------------------------------------------

function poll(): void {
  log('INFO', null, 'poll cycle start');

  try {
    checkDaemonHealth();
  } catch (err) {
    log('ERROR', null, `daemon health check threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  const enabledAgents = readEnabledAgents();

  try {
    checkAgentHeartbeats(enabledAgents);
  } catch (err) {
    log('ERROR', null, `heartbeat check threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    checkHealthProbes(enabledAgents);
  } catch (err) {
    log('ERROR', null, `health-probe check threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  log('INFO', null, 'poll cycle complete');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

ensureLogDir();
log('INFO', null, `starting — CTX_ROOT=${CTX_ROOT} poll_interval=${POLL_INTERVAL_MS / 1000}s`);

// Run immediately on start then on schedule
poll();
const timer = setInterval(poll, POLL_INTERVAL_MS);

// Graceful shutdown
process.on('SIGTERM', () => {
  log('INFO', null, 'received SIGTERM — shutting down gracefully');
  clearInterval(timer);
  log('INFO', null, 'shutdown complete');
  process.exit(0);
});

process.on('SIGINT', () => {
  log('INFO', null, 'received SIGINT — shutting down gracefully');
  clearInterval(timer);
  log('INFO', null, 'shutdown complete');
  process.exit(0);
});
