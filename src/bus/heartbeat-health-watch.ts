import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { BusPaths } from '../types/index.js';
import { logEvent } from './event.js';

export interface HeartbeatHealthAgent {
  agent: string;
  org: string;
  running: boolean;
  lastHeartbeat: string | null;
  ageMinutes: number | null;
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

function renderReport(report: HeartbeatHealthReport): string {
  const lines = [
    '# Heartbeat Health Watch',
    '',
    `Generated: ${report.generatedAt}`,
    `Threshold: ${report.thresholdMinutes} minutes`,
    `Running stale agents: ${report.staleRunningAgents.length}`,
    '',
    '| Agent | Running | Last heartbeat | Age min | Stale |',
    '| --- | --- | --- | ---: | --- |',
  ];

  for (const agent of report.agents) {
    lines.push(`| ${agent.agent} | ${agent.running ? 'yes' : 'no'} | ${agent.lastHeartbeat || '-'} | ${agent.ageMinutes === null ? '-' : agent.ageMinutes.toFixed(1)} | ${agent.stale ? 'yes' : 'no'} |`);
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

export function runHeartbeatHealthWatch(
  paths: BusPaths,
  agentName: string,
  org: string,
  projectRoot: string,
  runningAgents: Set<string>,
  options: { thresholdMinutes?: number; outputDir?: string } = {},
): HeartbeatHealthReport {
  const generatedAt = new Date().toISOString();
  const nowMs = Date.now();
  const thresholdMinutes = options.thresholdMinutes ?? 90;
  const agentsByName = discoverAgents(projectRoot, org, readEnabledAgents(paths.ctxRoot));
  const agents: HeartbeatHealthAgent[] = [];

  for (const [name, info] of Object.entries(agentsByName)) {
    if (!info.enabled) continue;
    if (info.org && info.org !== org) continue;
    const heartbeat = heartbeatAgeMinutes(paths.ctxRoot, name, nowMs);
    const running = runningAgents.has(name);
    const stale = running && (heartbeat.ageMinutes === null || heartbeat.ageMinutes > thresholdMinutes);
    agents.push({
      agent: name,
      org: info.org || org,
      running,
      lastHeartbeat: heartbeat.lastHeartbeat,
      ageMinutes: heartbeat.ageMinutes,
      stale,
    });
  }

  agents.sort((a, b) => a.agent.localeCompare(b.agent));
  const staleRunningAgents = agents.filter(agent => agent.stale);
  const report: HeartbeatHealthReport = {
    generatedAt,
    thresholdMinutes,
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
