import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { BusPaths } from '../types/index.js';
import { logEvent } from './event.js';
import { parseDurationMs, cronExpressionMinIntervalMs, readCronState } from './cron-state.js';
import { readCrons } from './crons.js';

export interface HeartbeatHealthAgent {
  agent: string;
  org: string;
  running: boolean;
  lastHeartbeat: string | null;
  ageMinutes: number | null;
  thresholdMinutes: number;
  stale: boolean;
}

export interface HeartbeatHealthReport {
  generatedAt: string;
  thresholdMinutes: number;
  agents: HeartbeatHealthAgent[];
  staleRunningAgents: HeartbeatHealthAgent[];
  reportPath?: string;
}

function readEnabledAgents(ctxRoot: string): Record<string, { org: string; enabled: boolean }> {
  const enabledFile = join(ctxRoot, 'config', 'enabled-agents.json');
  if (!existsSync(enabledFile)) return {};
  try {
    const data = JSON.parse(readFileSync(enabledFile, 'utf-8')) as Record<string, { org?: string; enabled?: boolean }>;
    return Object.fromEntries(Object.entries(data).map(([name, cfg]) => [
      name,
      { org: cfg.org || '', enabled: cfg.enabled !== false },
    ]));
  } catch {
    return {};
  }
}

function discoverAgents(projectRoot: string, org: string, enabled: Record<string, { org: string; enabled: boolean }>): Record<string, { org: string; enabled: boolean }> {
  const agents = { ...enabled };
  const agentsDir = join(projectRoot, 'orgs', org, 'agents');
  if (!existsSync(agentsDir)) return agents;
  for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!agents[entry.name]) agents[entry.name] = { org, enabled: true };
  }
  return agents;
}

function heartbeatAgeMinutes(ctxRoot: string, agent: string, nowMs: number): { lastHeartbeat: string | null; ageMinutes: number | null } {
  const hbPath = join(ctxRoot, 'state', agent, 'heartbeat.json');
  if (!existsSync(hbPath)) return { lastHeartbeat: null, ageMinutes: null };
  try {
    const hb = JSON.parse(readFileSync(hbPath, 'utf-8')) as { last_heartbeat?: string; timestamp?: string };
    const lastHeartbeat = hb.last_heartbeat || hb.timestamp || null;
    if (!lastHeartbeat) return { lastHeartbeat: null, ageMinutes: null };
    const parsed = Date.parse(lastHeartbeat);
    if (!Number.isFinite(parsed)) return { lastHeartbeat, ageMinutes: null };
    return { lastHeartbeat, ageMinutes: Math.max(0, (nowMs - parsed) / 60_000) };
  } catch {
    return { lastHeartbeat: null, ageMinutes: null };
  }
}

function intervalMinutes(schedule: string | undefined): number | null {
  if (!schedule) return null;
  const trimmed = schedule.trim();
  if (!trimmed) return null;
  const durationMs = parseDurationMs(trimmed);
  const intervalMs = Number.isFinite(durationMs)
    ? durationMs
    : trimmed.split(/\s+/).length === 5
      ? cronExpressionMinIntervalMs(trimmed)
      : NaN;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return null;
  return intervalMs / 60_000;
}

function heartbeatCronIntervalMinutes(
  ctxRoot: string,
  projectRoot: string,
  org: string,
  agent: string,
): number | null {
  const persistentHeartbeat = readCrons(agent).find(cron => cron.name === 'heartbeat' && cron.enabled !== false);
  const persistentMinutes = intervalMinutes(persistentHeartbeat?.schedule);
  if (persistentMinutes !== null) return persistentMinutes;

  const legacyConfigPath = join(projectRoot, 'orgs', org, 'agents', agent, 'config.json');
  if (existsSync(legacyConfigPath)) {
    try {
      const config = JSON.parse(readFileSync(legacyConfigPath, 'utf-8')) as {
        crons?: Array<{ name?: string; interval?: string; schedule?: string; enabled?: boolean }>;
      };
      const legacyHeartbeat = config.crons?.find(cron => cron.name === 'heartbeat' && cron.enabled !== false);
      const legacyMinutes = intervalMinutes(legacyHeartbeat?.schedule ?? legacyHeartbeat?.interval);
      if (legacyMinutes !== null) return legacyMinutes;
    } catch {
      // Fall through to cron-state fallback.
    }
  }

  const stateHeartbeat = readCronState(join(ctxRoot, 'state', agent)).crons.find(cron => cron.name === 'heartbeat');
  return intervalMinutes(stateHeartbeat?.interval);
}

function staleThresholdMinutes(
  ctxRoot: string,
  projectRoot: string,
  org: string,
  agent: string,
  fallbackThresholdMinutes: number,
): number {
  const heartbeatMinutes = heartbeatCronIntervalMinutes(ctxRoot, projectRoot, org, agent);
  if (heartbeatMinutes === null) return fallbackThresholdMinutes;
  return Math.max(1, Math.min(fallbackThresholdMinutes, Math.ceil(heartbeatMinutes * 1.5)));
}

function renderReport(report: HeartbeatHealthReport): string {
  const lines = [
    '# Heartbeat Health Watch',
    '',
    `Generated: ${report.generatedAt}`,
    `Fallback threshold: ${report.thresholdMinutes} minutes`,
    `Running stale agents: ${report.staleRunningAgents.length}`,
    '',
    '| Agent | Running | Last heartbeat | Age min | Threshold min | Stale |',
    '| --- | --- | --- | ---: | ---: | --- |',
  ];

  for (const agent of report.agents) {
    lines.push(`| ${agent.agent} | ${agent.running ? 'yes' : 'no'} | ${agent.lastHeartbeat || '-'} | ${agent.ageMinutes === null ? '-' : agent.ageMinutes.toFixed(1)} | ${agent.thresholdMinutes} | ${agent.stale ? 'yes' : 'no'} |`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * File-based fallback for when the daemon IPC is unresponsive.
 * Infers which agents are running by reading heartbeat.json files directly.
 * An agent is considered running if its status is "online" and its last_heartbeat
 * is within staleMinutes of now.
 */
export function inferRunningFromHeartbeats(ctxRoot: string, staleMinutes = 30): Set<string> {
  const running = new Set<string>();
  const stateDir = join(ctxRoot, 'state');
  if (!existsSync(stateDir)) return running;
  const nowMs = Date.now();
  for (const entry of readdirSync(stateDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const hbPath = join(stateDir, entry.name, 'heartbeat.json');
    if (!existsSync(hbPath)) continue;
    try {
      const hb = JSON.parse(readFileSync(hbPath, 'utf-8')) as { status?: string; last_heartbeat?: string };
      if (hb.status === 'online' && hb.last_heartbeat) {
        const ageMs = nowMs - Date.parse(hb.last_heartbeat);
        if (Number.isFinite(ageMs) && ageMs < staleMinutes * 60_000) {
          running.add(entry.name);
        }
      }
    } catch {
      // Ignore unreadable heartbeat files
    }
  }
  return running;
}

export interface HeartbeatSuppressFile {
  agents: string[];
  expires_at?: string;
}

function readSuppressFile(ctxRoot: string): Set<string> {
  const suppressPath = join(ctxRoot, 'state', 'heartbeat-suppress.json');
  if (!existsSync(suppressPath)) return new Set();
  try {
    const data = JSON.parse(readFileSync(suppressPath, 'utf-8')) as HeartbeatSuppressFile;
    if (data.expires_at && Date.now() > Date.parse(data.expires_at)) return new Set();
    return new Set(Array.isArray(data.agents) ? data.agents : []);
  } catch {
    return new Set();
  }
}

export function runHeartbeatHealthWatch(
  paths: BusPaths,
  agentName: string,
  org: string,
  projectRoot: string,
  runningAgents: Set<string>,
  options: { thresholdMinutes?: number; outputDir?: string; skipAgents?: string[] } = {},
): HeartbeatHealthReport {
  const generatedAt = new Date().toISOString();
  const nowMs = Date.now();
  const fallbackThresholdMinutes = options.thresholdMinutes ?? 90;
  const skipSet = new Set([
    ...(options.skipAgents ?? []),
    ...readSuppressFile(paths.ctxRoot),
  ]);
  const agentsByName = discoverAgents(projectRoot, org, readEnabledAgents(paths.ctxRoot));
  const agents: HeartbeatHealthAgent[] = [];

  for (const [name, info] of Object.entries(agentsByName)) {
    if (!info.enabled) continue;
    if (info.org && info.org !== org) continue;
    if (skipSet.has(name)) continue;
    const heartbeat = heartbeatAgeMinutes(paths.ctxRoot, name, nowMs);
    const running = runningAgents.has(name);
    const thresholdMinutes = staleThresholdMinutes(paths.ctxRoot, projectRoot, org, name, fallbackThresholdMinutes);
    const stale = running && (heartbeat.ageMinutes === null || heartbeat.ageMinutes > thresholdMinutes);
    agents.push({
      agent: name,
      org: info.org || org,
      running,
      lastHeartbeat: heartbeat.lastHeartbeat,
      ageMinutes: heartbeat.ageMinutes,
      thresholdMinutes,
      stale,
    });
  }

  agents.sort((a, b) => a.agent.localeCompare(b.agent));
  const staleRunningAgents = agents.filter(agent => agent.stale);
  const report: HeartbeatHealthReport = {
    generatedAt,
    thresholdMinutes: fallbackThresholdMinutes,
    agents,
    staleRunningAgents,
  };

  if (options.outputDir) {
    mkdirSync(options.outputDir, { recursive: true });
    const reportPath = join(options.outputDir, `${generatedAt.slice(0, 10)}-heartbeat-health-watch.md`);
    report.reportPath = reportPath;
    writeFileSync(reportPath, renderReport(report), 'utf-8');
  }

  logEvent(paths, agentName, org, 'action', 'heartbeat_health_watch_completed', 'info', {
    agents_checked: agents.length,
    stale_running_agents: staleRunningAgents.map(agent => agent.agent),
    report_path: report.reportPath || null,
  });

  return report;
}
