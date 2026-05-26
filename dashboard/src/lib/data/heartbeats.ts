// cortextOS Dashboard - Heartbeat data fetcher
// Reads directly from filesystem (heartbeats change frequently; SQLite may lag).

import fs from 'fs/promises';
import path from 'path';
import { CTX_ROOT, getHeartbeatPath } from '@/lib/config';
import type { Heartbeat, HealthStatus, HealthSummary } from '@/lib/types';

// Default staleness thresholds (minutes)
const STALE_THRESHOLD_MIN = 120; // 2 hours: day-mode running agents need actionable recovery before a 4h+ gap
const DOWN_THRESHOLD_MIN = 1440; // 24 hours

/**
 * Get heartbeat for a single agent. Returns null if not found.
 */
export async function getHeartbeat(agentName: string): Promise<Heartbeat | null> {
  const hbPath = getHeartbeatPath(agentName);
  try {
    const raw = await fs.readFile(hbPath, 'utf-8');
    const data = JSON.parse(raw);
    return {
      agent: agentName,
      org: data.org ?? '',
      status: data.status ?? 'unknown',
      current_task: data.current_task ?? undefined,
      mode: data.mode ?? undefined,
      last_heartbeat: data.last_heartbeat ?? data.timestamp ?? undefined,
      loop_interval: data.loop_interval ?? undefined,
      uptime_seconds: data.uptime_seconds ?? undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Get all heartbeats by scanning the state directory.
 */
export async function getAllHeartbeats(): Promise<Heartbeat[]> {
  const stateDir = path.join(CTX_ROOT, 'state');
  const heartbeats: Heartbeat[] = [];

  try {
    const entries = await fs.readdir(stateDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory());

    const results = await Promise.allSettled(
      dirs.map((d) => getHeartbeat(d.name))
    );

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        heartbeats.push(result.value);
      }
    }
  } catch {
    // state dir doesn't exist yet - return empty
  }

  return heartbeats;
}

/**
 * Get heartbeats filtered by org. If no org, returns all.
 */
export async function getHeartbeats(org?: string): Promise<Heartbeat[]> {
  const all = await getAllHeartbeats();
  if (!org) return all;
  // Include agents with matching org OR empty org (agents may not write org to heartbeat)
  return all.filter((hb) => hb.org === org || !hb.org);
}

/**
 * Compute health status from a heartbeat based on staleness.
 */
export function computeHealth(
  heartbeat: Heartbeat,
  thresholdMinutes?: number
): HealthStatus {
  return isAgentHealthy(heartbeat, thresholdMinutes) ? 'healthy' : 'stale';
}

/**
 * Check whether an agent heartbeat is healthy (not stale).
 */
export function isAgentHealthy(
  heartbeat: Heartbeat,
  thresholdMinutes: number = STALE_THRESHOLD_MIN
): boolean {
  if (!heartbeat.last_heartbeat) return false;

  const lastBeat = new Date(heartbeat.last_heartbeat).getTime();
  const now = Date.now();
  const diffMinutes = (now - lastBeat) / (1000 * 60);

  return diffMinutes <= thresholdMinutes;
}

/**
 * Get detailed health status (healthy / stale / down).
 */
export function getHealthStatus(heartbeat: Heartbeat): HealthStatus {
  if (!heartbeat.last_heartbeat) return 'down';

  const lastBeat = new Date(heartbeat.last_heartbeat).getTime();
  const now = Date.now();
  const diffMinutes = (now - lastBeat) / (1000 * 60);

  if (diffMinutes <= STALE_THRESHOLD_MIN) return 'healthy';
  if (diffMinutes <= DOWN_THRESHOLD_MIN) return 'stale';
  return 'down';
}

/**
 * Get agents with stale or down heartbeats.
 */
export async function getStaleAgents(): Promise<Heartbeat[]> {
  const all = await getAllHeartbeats();
  return all.filter((hb) => !isAgentHealthy(hb));
}

/**
 * Get a health summary across all agents (optionally filtered by org).
 */
export async function getHealthSummary(org?: string): Promise<HealthSummary> {
  const heartbeats = await getHeartbeats(org);

  const summary: HealthSummary = {
    healthy: 0,
    stale: 0,
    down: 0,
    agents: [],
  };

  for (const hb of heartbeats) {
    const health = getHealthStatus(hb);

    if (health === 'healthy') summary.healthy++;
    else if (health === 'stale') summary.stale++;
    else summary.down++;

    summary.agents.push({
      agent: hb.agent,
      org: hb.org,
      health,
      lastHeartbeat: hb.last_heartbeat,
      currentTask: hb.current_task,
    });
  }

  return summary;
}
