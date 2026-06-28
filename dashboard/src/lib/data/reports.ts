import fs from 'fs';
import path from 'path';
import os from 'os';

// Resolve CTX_ROOT without importing from config (avoids turbopack chunk issues)
const CTX_INSTANCE_ID = process.env.CTX_INSTANCE_ID ?? 'default';
const CTX_ROOT = process.env.CTX_ROOT ?? path.join(os.homedir(), '.cortextos', CTX_INSTANCE_ID);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FleetHealthAgent {
  name: string;
  heartbeatAgeMin: number;
  isStale: boolean;
  events: number;
  realErrors: number;
  crashes: number;
  heartbeats: number;
  stability: number; // (heartbeats - crashes) / heartbeats * 100
}

export interface AgentMessageCount {
  name: string;
  sent: number;
  received: number;
}

export interface FleetHealth {
  agents: FleetHealthAgent[];
  messageBus: { totalToday: number; pending: number; perAgent: AgentMessageCount[] };
  fleetStability: number;
  staleCount: number;
  errorCount: number;
}

export interface AgentCostData {
  agent: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  models: Record<string, number>;
}

export interface CostIntelligence {
  fleetTokensToday: number;
  fleetCostToday: number;
  perAgent: AgentCostData[];
}

export interface LatestSnapshot {
  date: string;
  generatedAt: string;
  health: Record<string, unknown>;
  productivity: Record<string, unknown>;
  cost: Record<string, unknown>;
  alignment: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Core reader
// ---------------------------------------------------------------------------

function getReportsDir(org: string): string {
  return path.join(CTX_ROOT, 'orgs', org, 'analytics', 'reports');
}

export function getLatestSnapshot(org: string): LatestSnapshot | null {
  const file = path.join(getReportsDir(org), 'latest.json');
  if (!fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const data = JSON.parse(raw);
    return {
      date: data.date ?? '',
      generatedAt: data.generated_at ?? '',
      health: data.health ?? {},
      productivity: data.productivity ?? {},
      cost: data.cost ?? {},
      alignment: data.alignment ?? {},
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fleet Health (Phase 1)
// ---------------------------------------------------------------------------

export function getFleetHealth(org: string): FleetHealth | null {
  const snapshot = getLatestSnapshot(org);
  if (!snapshot?.health) {
    // Fallback: build fleet health from live heartbeat files
    return getFleetHealthFromHeartbeats(org);
  }

  const healthData = snapshot.health as {
    agents?: Record<string, {
      agent: string;
      heartbeat_age_min: number;
      is_stale: boolean;
      events: number;
      real_errors: number;
      crashes: number;
      heartbeats: number;
    }>;
    message_bus?: { inbox: number; inflight: number; processed: number };
  };

  const agents: FleetHealthAgent[] = [];
  let totalStability = 0;
  let staleCount = 0;
  let errorCount = 0;

  if (healthData.agents) {
    for (const [name, data] of Object.entries(healthData.agents)) {
      const hb = data.heartbeats || 1;
      // Stability based on real errors, not total restarts (which include planned restarts)
      const stability = Math.round(((hb - data.real_errors) / hb) * 100);
      if (data.is_stale) staleCount++;
      errorCount += data.real_errors;
      totalStability += stability;

      // Read live heartbeat for real-time Last Seen
      let liveAgeMin = data.heartbeat_age_min;
      const hbFile = path.join(CTX_ROOT, 'state', name, 'heartbeat.json');
      try {
        if (fs.existsSync(hbFile)) {
          const hbData = JSON.parse(fs.readFileSync(hbFile, 'utf-8'));
          if (hbData.last_heartbeat) {
            const ageMs = Date.now() - new Date(hbData.last_heartbeat).getTime();
            liveAgeMin = Math.round(ageMs / 60000);
          }
        }
      } catch { /* use report data as fallback */ }

      agents.push({
        name,
        heartbeatAgeMin: liveAgeMin,
        isStale: liveAgeMin > 300, // 5 hours = stale
        events: data.events,
        realErrors: data.real_errors,
        crashes: data.crashes,
        heartbeats: data.heartbeats,
        stability,
      });
    }
  }

  const fleetStability = agents.length > 0
    ? Math.round(totalStability / agents.length)
    : 100;

  // Count messages per agent from processed/inbox directories
  // Only include agents that belong to this org (from health report)
  const orgAgentNames = new Set(agents.map(a => a.name));
  let deliveredToday = 0;
  let totalPending = 0;
  const perAgentMessages: Record<string, { sent: number; received: number }> = {};
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();

  // Received = messages in this agent's processed dir today
  const processedDir = path.join(CTX_ROOT, 'processed');
  if (fs.existsSync(processedDir)) {
    for (const ad of fs.readdirSync(processedDir, { withFileTypes: true })) {
      if (!ad.isDirectory()) continue;
      const agentName = ad.name;
      if (!orgAgentNames.has(agentName)) continue; // Skip agents not in this org
      if (!perAgentMessages[agentName]) perAgentMessages[agentName] = { sent: 0, received: 0 };
      try {
        for (const f of fs.readdirSync(path.join(processedDir, agentName))) {
          try {
            if (fs.statSync(path.join(processedDir, agentName, f)).mtimeMs >= todayMs) {
              deliveredToday++;
              perAgentMessages[agentName].received++;
              // Parse sender from filename (format: PNUM-EPOCH-from-SENDER-RAND.json)
              const senderMatch = f.match(/from-([a-z0-9_-]+)-/);
              if (senderMatch && orgAgentNames.has(senderMatch[1])) {
                const sender = senderMatch[1];
                if (!perAgentMessages[sender]) perAgentMessages[sender] = { sent: 0, received: 0 };
                perAgentMessages[sender].sent++;
              }
            }
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }
  }

  const inboxDir = path.join(CTX_ROOT, 'inbox');
  if (fs.existsSync(inboxDir)) {
    for (const ad of fs.readdirSync(inboxDir, { withFileTypes: true })) {
      if (!ad.isDirectory()) continue;
      try { totalPending += fs.readdirSync(path.join(inboxDir, ad.name)).length; } catch { /* skip */ }
    }
  }

  const perAgent: AgentMessageCount[] = Object.entries(perAgentMessages)
    .map(([name, counts]) => ({ name, ...counts }))
    .sort((a, b) => (b.sent + b.received) - (a.sent + a.received));

  return {
    agents: agents.sort((a, b) => a.stability - b.stability),
    messageBus: { totalToday: deliveredToday, pending: totalPending, perAgent },
    fleetStability,
    staleCount,
    errorCount,
  };
}

// ---------------------------------------------------------------------------
// Fallback: build fleet health from live heartbeat files when no report exists
function getFleetHealthFromHeartbeats(org: string): FleetHealth | null {
  const CTX_FRAMEWORK_ROOT = process.env.CTX_FRAMEWORK_ROOT ?? path.join(path.dirname(CTX_ROOT), '..');
  const agentsDir = path.join(CTX_FRAMEWORK_ROOT, 'orgs', org, 'agents');
  if (!fs.existsSync(agentsDir)) return null;

  const agents: FleetHealthAgent[] = [];
  for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    const hbFile = path.join(CTX_ROOT, 'state', name, 'heartbeat.json');
    let ageMin = 9999;
    try {
      if (fs.existsSync(hbFile)) {
        const hb = JSON.parse(fs.readFileSync(hbFile, 'utf-8'));
        if (hb.last_heartbeat) {
          ageMin = Math.round((Date.now() - new Date(hb.last_heartbeat).getTime()) / 60000);
        }
      }
    } catch { /* skip */ }

    agents.push({
      name,
      heartbeatAgeMin: ageMin,
      isStale: ageMin > 300,
      events: 0,
      realErrors: 0,
      crashes: 0,
      heartbeats: 1,
      stability: 100,
    });
  }

  if (agents.length === 0) return null;

  return {
    agents,
    messageBus: { totalToday: 0, pending: 0, perAgent: [] },
    fleetStability: 100,
    staleCount: agents.filter(a => a.isStale).length,
    errorCount: 0,
  };
}

// Plan Usage (scraped from /usage via scrape-usage.sh)
// ---------------------------------------------------------------------------

export interface PlanUsage {
  agent: string;
  timestamp: string;
  session: { used_pct: number; resets: string };
  week_all_models: { used_pct: number; resets: string };
  week_sonnet: { used_pct: number };
}

export interface CodexUsage {
  plan_type: string;
  timestamp: string;
  five_hour: { used_pct: number; resets: string };
  seven_day: { used_pct: number; resets: string };
}

/**
 * Codex (ChatGPT) plan usage, read from the wham cache the usage-monitor cron
 * keeps fresh. primary_window is the 5h limit, secondary_window the 7d limit;
 * reset_at is a unix epoch (seconds).
 */
export function getCodexUsage(): CodexUsage | null {
  const cacheFile = path.join(CTX_ROOT, 'state', 'usage', 'codex-wham-cache.json');
  if (!fs.existsSync(cacheFile)) return null;
  try {
    const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    const rl = cache.rate_limit;
    if (!rl) return null;
    const fmtEpoch = (s?: number | null): string =>
      s ? new Date(s * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric' }) : '';
    return {
      plan_type: cache.plan_type ?? 'codex',
      timestamp: fs.statSync(cacheFile).mtime.toISOString(),
      five_hour: { used_pct: rl.primary_window?.used_percent ?? 0, resets: fmtEpoch(rl.primary_window?.reset_at) },
      seven_day: { used_pct: rl.secondary_window?.used_percent ?? 0, resets: fmtEpoch(rl.secondary_window?.reset_at) },
    };
  } catch {
    return null;
  }
}

export function getPlanUsage(): PlanUsage | null {
  // Primary: an explicit `cortextos bus scrape-usage` snapshot. Preserves the
  // manual /usage paste path and the daily JSONL history series.
  const file = path.join(CTX_ROOT, 'state', 'usage', 'latest.json');
  if (fs.existsSync(file)) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      // fall through to the live API cache
    }
  }

  // Fallback: the OAuth usage cache that the usage-monitor cron keeps fresh.
  // This auto-populates the widget with no manual scrape. The cache exposes 5h /
  // 7d / 7d-sonnet utilization, which map onto session / week-all-models / week-sonnet.
  const cacheFile = path.join(CTX_ROOT, 'state', 'usage', 'api-cache.json');
  if (!fs.existsSync(cacheFile)) return null;
  try {
    const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    if (cache.five_hour == null && cache.seven_day == null) return null;
    const fmtReset = (iso?: string | null): string =>
      iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric' }) : '';
    return {
      agent: 'claude-max',
      timestamp: fs.statSync(cacheFile).mtime.toISOString(),
      session: {
        used_pct: cache.five_hour?.utilization ?? 0,
        resets: fmtReset(cache.five_hour?.resets_at),
      },
      week_all_models: {
        used_pct: cache.seven_day?.utilization ?? 0,
        resets: fmtReset(cache.seven_day?.resets_at),
      },
      week_sonnet: {
        used_pct: cache.seven_day_sonnet?.utilization ?? 0,
      },
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Historical Plan Usage (time series from JSONL logs)
// ---------------------------------------------------------------------------

export interface UsageDataPoint {
  timestamp: string;
  session_pct: number;
  week_pct: number;
  sonnet_pct: number;
}

export function getUsageHistory(days: number = 7): UsageDataPoint[] {
  const usageDir = path.join(CTX_ROOT, 'state', 'usage');
  if (!fs.existsSync(usageDir)) return [];

  const points: UsageDataPoint[] = [];
  const now = new Date();

  for (let d = days - 1; d >= 0; d--) {
    const date = new Date(now);
    date.setDate(date.getDate() - d);
    const dateStr = date.toISOString().split('T')[0];
    const file = path.join(usageDir, `${dateStr}.jsonl`);

    if (!fs.existsSync(file)) continue;

    try {
      const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
      for (const line of lines) {
        if (!line) continue;
        try {
          const entry = JSON.parse(line);
          points.push({
            timestamp: entry.timestamp,
            session_pct: entry.session?.used_pct ?? 0,
            week_pct: entry.week_all_models?.used_pct ?? 0,
            sonnet_pct: entry.week_sonnet?.used_pct ?? 0,
          });
        } catch { /* skip bad lines */ }
      }
    } catch { /* skip unreadable files */ }
  }

  return points;
}

// ---------------------------------------------------------------------------
// Cost Intelligence (Phase 3)
// ---------------------------------------------------------------------------

export function getCostIntelligence(org: string): CostIntelligence | null {
  const snapshot = getLatestSnapshot(org);
  if (!snapshot?.cost) return null;

  const costData = snapshot.cost as {
    agents?: Record<string, {
      total_tokens: number;
      input_tokens: number;
      output_tokens: number;
      cost_usd: number;
      models?: Record<string, number>;
    }>;
  };

  if (!costData.agents) return null;

  const perAgent: AgentCostData[] = [];
  let fleetTokens = 0;
  let fleetCost = 0;

  for (const [agent, data] of Object.entries(costData.agents)) {
    fleetTokens += data.total_tokens || 0;
    fleetCost += data.cost_usd || 0;
    perAgent.push({
      agent,
      totalTokens: data.total_tokens || 0,
      inputTokens: data.input_tokens || 0,
      outputTokens: data.output_tokens || 0,
      costUsd: data.cost_usd || 0,
      models: data.models || {},
    });
  }

  return {
    fleetTokensToday: fleetTokens,
    fleetCostToday: fleetCost,
    perAgent: perAgent.sort((a, b) => b.totalTokens - a.totalTokens),
  };
}
