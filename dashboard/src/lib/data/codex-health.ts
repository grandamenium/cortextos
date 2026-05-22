import fs from 'fs';
import path from 'path';
import os from 'os';
import { db } from '@/lib/db';

const CTX_ROOT = process.env.CTX_ROOT ?? path.join(os.homedir(), '.cortextos', process.env.CTX_INSTANCE_ID ?? 'default');

// Utilization thresholds (mirrors src/bus/oauth.ts ALERT_5H / ALERT_7D)
const ALERT_5H_THRESHOLD = 0.80; // page when 5h-band ≥ 80% used (< 20% remaining)
const ALERT_7D_THRESHOLD = 0.80; // page when weekly burn projects to hit cap in < 48h

// Rough cost per spillover dispatch: claude-opus-4-7 typical short job
const SPILLOVER_COST_PER_DISPATCH_USD = 0.40;
const SPILLOVER_MONTHLY_SOFT_CAP_USD = 400;

export interface CodexLimitHitEvent {
  id: string;
  timestamp: string;
  agent: string;
  limit_class: string;
  retry_after_secs: number | null;
  task_id: string | null;
}

export interface CodexFailoverEvent {
  id: string;
  timestamp: string;
  agent: string;
  worker_name: string;
  limit_class: string;
  task_id: string | null;
  parent_agent: string;
}

export interface CodexAccountHealth {
  account: string;
  five_hour_used_pct: number;
  seven_day_used_pct: number;
  alert_5h: boolean;
  alert_7d: boolean;
  source: string;
}

export interface CodexHealthData {
  account: CodexAccountHealth | null;
  recentLimitHits: CodexLimitHitEvent[];
  recentFailovers: CodexFailoverEvent[];
  failoverCount30d: number;
  spilloverSpendEstimateUsd: number;
  spilloverMonthlySoftCapUsd: number;
  autoFallbackAgents: string[];
  generatedAt: string;
}

function readAccountHealth(): CodexAccountHealth | null {
  // Try oauth accounts.json first (has utilization data from checkUsageApi)
  const accountsPath = path.join(CTX_ROOT, 'state', 'oauth', 'accounts.json');
  if (fs.existsSync(accountsPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(accountsPath, 'utf-8')) as {
        active?: string;
        accounts?: Record<string, {
          label?: string;
          five_hour_utilization?: number;
          seven_day_utilization?: number;
        }>;
      };
      const active = raw.active;
      const account = active ? raw.accounts?.[active] : undefined;
      if (account) {
        const fh = account.five_hour_utilization ?? 0;
        const sd = account.seven_day_utilization ?? 0;
        return {
          account: account.label ?? active ?? 'gregharned@gmail.com',
          five_hour_used_pct: Math.round(fh * 100),
          seven_day_used_pct: Math.round(sd * 100),
          alert_5h: fh >= ALERT_5H_THRESHOLD,
          alert_7d: sd >= ALERT_7D_THRESHOLD,
          source: 'accounts.json',
        };
      }
    } catch { /* fall through */ }
  }

  // Fall back to dashboard quota cache
  const quotaCachePath = path.join(CTX_ROOT, 'state', 'dashboard', 'quota-last-good.json');
  if (fs.existsSync(quotaCachePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(quotaCachePath, 'utf-8')) as {
        five_hour_remaining_pct?: number;
        seven_day_remaining_pct?: number;
        source?: string;
      };
      if (raw.five_hour_remaining_pct !== undefined) {
        const fhUsed = Math.round(100 - (raw.five_hour_remaining_pct ?? 100));
        const sdUsed = Math.round(100 - (raw.seven_day_remaining_pct ?? 100));
        return {
          account: 'gregharned@gmail.com',
          five_hour_used_pct: fhUsed,
          seven_day_used_pct: sdUsed,
          alert_5h: fhUsed >= ALERT_5H_THRESHOLD * 100,
          alert_7d: sdUsed >= ALERT_7D_THRESHOLD * 100,
          source: raw.source ?? 'quota-cache',
        };
      }
    } catch { /* fall through */ }
  }

  return null;
}

function readAutoFallbackAgents(): string[] {
  const agentsDir = path.join(CTX_ROOT, '..', '..', 'orgs', 'revops-global', 'agents');
  const resolved = path.resolve(agentsDir);
  if (!fs.existsSync(resolved)) return [];

  const agents: string[] = [];
  try {
    const dirs = fs.readdirSync(resolved, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    for (const dir of dirs) {
      const cfgPath = path.join(resolved, dir, 'config.json');
      if (!fs.existsSync(cfgPath)) continue;
      try {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as {
          codex_auto_fallback?: boolean;
        };
        if (cfg.codex_auto_fallback === true) {
          agents.push(dir);
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return agents;
}

function queryEvents<T>(eventType: string, limit: number): T[] {
  try {
    const rows = db
      .prepare(
        `SELECT id, timestamp, agent, data FROM events
         WHERE type = ?
         ORDER BY timestamp DESC
         LIMIT ?`
      )
      .all(eventType, limit) as { id: string; timestamp: string; agent: string; data: string | null }[];

    return rows.map((row) => {
      let meta: Record<string, unknown> = {};
      if (row.data) {
        try { meta = JSON.parse(row.data) as Record<string, unknown>; } catch { /* skip */ }
      }
      return { id: row.id, timestamp: row.timestamp, agent: row.agent, ...meta } as T;
    });
  } catch {
    return [];
  }
}

function countFailovers30d(): number {
  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const row = db
      .prepare(`SELECT COUNT(*) as cnt FROM events WHERE type = 'codex_failover_dispatched' AND timestamp >= ?`)
      .get(since) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  } catch {
    return 0;
  }
}

export function getCodexHealthData(): CodexHealthData {
  const recentLimitHits = queryEvents<CodexLimitHitEvent>('codex_limit_hit', 20);
  const recentFailovers = queryEvents<CodexFailoverEvent>('codex_failover_dispatched', 20);
  const failoverCount30d = countFailovers30d();

  return {
    account: readAccountHealth(),
    recentLimitHits,
    recentFailovers,
    failoverCount30d,
    spilloverSpendEstimateUsd: Math.round(failoverCount30d * SPILLOVER_COST_PER_DISPATCH_USD * 100) / 100,
    spilloverMonthlySoftCapUsd: SPILLOVER_MONTHLY_SOFT_CAP_USD,
    autoFallbackAgents: readAutoFallbackAgents(),
    generatedAt: new Date().toISOString(),
  };
}
