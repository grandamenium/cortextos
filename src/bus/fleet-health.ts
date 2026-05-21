/**
 * Fleet health check: detects stale agent heartbeats and cron injection gaps.
 * Used by `cortextos bus fleet-health-check` and as a daemon cron check.
 *
 * Stale heartbeat: last_heartbeat > STALE_THRESHOLD_MINUTES ago
 * Cron gap: a cron fired but no matching cron_received event appeared within
 * GAP_THRESHOLD_MINUTES.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import type { BusPaths, Heartbeat } from '../types/index.js';
import { readAllHeartbeats } from './heartbeat.js';

export const STALE_THRESHOLD_MINUTES = 15;
export const CRON_GAP_THRESHOLD_MINUTES = 12;

export interface AgentHealthStatus {
  agentName: string;
  lastHeartbeat: string | null;
  minutesSinceHeartbeat: number | null;
  isStale: boolean;
  status: string;
}

export interface CronGap {
  agentName: string;
  cronName: string;
  firedAt: string;
  minutesSinceFire: number;
}

export interface FleetHealthReport {
  checkedAt: string;
  healthy: boolean;
  staleAgents: AgentHealthStatus[];
  cronGaps: CronGap[];
  allAgents: AgentHealthStatus[];
  summary: string;
}

type HeartbeatWithLegacyName = Heartbeat & { agent_name?: string };

export function checkAgentHeartbeats(paths: BusPaths): AgentHealthStatus[] {
  const heartbeats = readAllHeartbeats(paths);
  const now = Date.now();

  return heartbeats.map((hb: Heartbeat) => {
    const heartbeat = hb as HeartbeatWithLegacyName;
    const lastHb = heartbeat.last_heartbeat ?? null;
    const lastHbMs = lastHb ? new Date(lastHb).getTime() : NaN;
    const minutesSince = Number.isFinite(lastHbMs)
      ? Math.floor((now - lastHbMs) / 60000)
      : null;
    const isStale = minutesSince === null || minutesSince > STALE_THRESHOLD_MINUTES;

    return {
      agentName: heartbeat.agent_name ?? heartbeat.agent ?? 'unknown',
      lastHeartbeat: lastHb,
      minutesSinceHeartbeat: minutesSince,
      isStale,
      status: heartbeat.status ?? 'unknown',
    };
  });
}

function readRecentEventsByAgent(
  analyticsDir: string,
  windowMinutes: number,
): Map<string, Array<Record<string, unknown>>> {
  const cutoff = Date.now() - windowMinutes * 60 * 1000;
  const eventsDir = join(analyticsDir, 'events');
  const result = new Map<string, Array<Record<string, unknown>>>();

  if (!existsSync(eventsDir)) return result;

  const agentDirs = readdirSync(eventsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

  for (const agent of agentDirs) {
    const events: Array<Record<string, unknown>> = [];
    for (const dateStr of [yesterday, today]) {
      const filePath = join(eventsDir, agent, `${dateStr}.jsonl`);
      if (!existsSync(filePath)) continue;
      const lines = readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          const ts = event.timestamp as string | undefined;
          const tsMs = ts ? new Date(ts).getTime() : NaN;
          if (Number.isFinite(tsMs) && tsMs >= cutoff) {
            events.push(event);
          }
        } catch { /* skip malformed */ }
      }
    }
    if (events.length > 0) result.set(agent, events);
  }

  return result;
}

function eventName(event: Record<string, unknown>): string | undefined {
  return (event.event_name ?? event.event) as string | undefined;
}

function eventMetadata(event: Record<string, unknown>): Record<string, unknown> {
  const metadata = event.metadata;
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
}

function cronNameFrom(event: Record<string, unknown>): string | undefined {
  const metadata = eventMetadata(event);
  return (metadata.cron ?? metadata.cron_name ?? metadata.name) as string | undefined;
}

function firedAtFrom(event: Record<string, unknown>): string | undefined {
  const metadata = eventMetadata(event);
  return (metadata.fired_at ?? metadata.ts ?? event.timestamp) as string | undefined;
}

function receivedKey(cronName: string, firedAt: string): string {
  return `${cronName}\0${firedAt}`;
}

export function checkCronGaps(analyticsDir: string): CronGap[] {
  const windowMinutes = CRON_GAP_THRESHOLD_MINUTES * 3;
  const eventsByAgent = readRecentEventsByAgent(analyticsDir, windowMinutes);
  const gaps: CronGap[] = [];
  const now = Date.now();

  for (const [agent, events] of eventsByAgent) {
    const received = new Set<string>();

    for (const event of events) {
      if (eventName(event) !== 'cron_received') continue;

      const cronName = cronNameFrom(event);
      const firedAt = firedAtFrom(event);
      if (cronName && firedAt) {
        received.add(receivedKey(cronName, firedAt));
      }
    }

    for (const event of events) {
      if (eventName(event) !== 'cron_fired') continue;

      const cronName = cronNameFrom(event);
      const firedAt = firedAtFrom(event);
      if (!cronName || !firedAt) continue;

      const firedAtMs = new Date(firedAt).getTime();
      if (!Number.isFinite(firedAtMs)) continue;

      const minutesSince = Math.floor((now - firedAtMs) / 60000);
      const isPastGapThreshold = minutesSince > CRON_GAP_THRESHOLD_MINUTES;
      const hasMatchingReceived = received.has(receivedKey(cronName, firedAt));

      if (isPastGapThreshold && !hasMatchingReceived) {
        gaps.push({
          agentName: agent,
          cronName,
          firedAt: new Date(firedAtMs).toISOString(),
          minutesSinceFire: minutesSince,
        });
      }
    }
  }

  return gaps;
}

export function runFleetHealthCheck(paths: BusPaths, analyticsDir: string): FleetHealthReport {
  const checkedAt = new Date().toISOString();
  const allAgents = checkAgentHeartbeats(paths);
  const staleAgents = allAgents.filter(a => a.isStale);
  const cronGaps = checkCronGaps(analyticsDir);

  const healthy = staleAgents.length === 0 && cronGaps.length === 0;

  let summary: string;
  if (healthy) {
    summary = `All ${allAgents.length} agents healthy. No cron gaps detected.`;
  } else {
    const parts: string[] = [];
    if (staleAgents.length > 0) {
      parts.push(`${staleAgents.length} stale agent(s): ${staleAgents.map(a => a.agentName).join(', ')}`);
    }
    if (cronGaps.length > 0) {
      parts.push(`${cronGaps.length} cron gap(s): ${cronGaps.map(g => `${g.agentName}/${g.cronName}`).join(', ')}`);
    }
    summary = parts.join(' | ');
  }

  return { checkedAt, healthy, staleAgents, cronGaps, allAgents, summary };
}

export function formatSlackAlert(report: FleetHealthReport): string {
  if (report.healthy) {
    return `Fleet health OK (${report.allAgents.length} agents, checked ${report.checkedAt})`;
  }

  const lines: string[] = [`*Fleet Health Alert* - ${report.checkedAt}`];

  if (report.staleAgents.length > 0) {
    lines.push('*Stale agents (no heartbeat >15 min):*');
    for (const agent of report.staleAgents) {
      const age = agent.minutesSinceHeartbeat !== null ? `${agent.minutesSinceHeartbeat}m ago` : 'never';
      lines.push(`  - ${agent.agentName}: last heartbeat ${age} (status: ${agent.status})`);
    }
  }

  if (report.cronGaps.length > 0) {
    lines.push('*Cron gaps (no cron_received in expected window):*');
    for (const gap of report.cronGaps) {
      lines.push(`  - ${gap.agentName}/${gap.cronName}: last received ${gap.minutesSinceFire}m ago`);
    }
  }

  return lines.join('\n');
}
