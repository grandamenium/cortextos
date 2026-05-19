import fs from 'fs';
import path from 'path';
import { CTX_ROOT, getOrgs } from '@/lib/config';

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

interface UsageRecord {
  agent?: string;
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  timestamp?: string;
}

interface TokenEventEntry {
  agent: string;
  timestamp: string;
  tokens: number;
  dollars: number;
}

export interface AgentTokenUsage {
  agent: string;
  tokens: number;
  dollars: number;
}

export interface TokenLimitsSnapshot {
  fiveHour: {
    used: number;
    cap: number;
    resetAt: string;
    byAgent: AgentTokenUsage[];
  };
  weekly: {
    used: number;
    cap: number;
    resetAt: string;
    pace: number;
    byAgent: AgentTokenUsage[];
  };
  burn24h: {
    points: number[];
    tokens: number;
    dollars: number;
  };
  source: 'admin' | 'fallback';
  fallbackReason?: string;
}

const TOKEN_CACHE_TTL_MS = 60_000;
const DEFAULT_CAP_5H = 5_000_000;
const DEFAULT_CAP_WEEKLY = 150_000_000;

const tokenUsageCache = new Map<string, CacheEntry<TokenLimitsSnapshot>>();

function getCached<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function setCached<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, ttlMs: number): T {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

function getFiveHourCap(): number {
  const raw = Number(process.env.CORTEXTOS_TOKEN_CAP_5H);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CAP_5H;
}

function getWeeklyCap(): number {
  const raw = Number(process.env.CORTEXTOS_TOKEN_CAP_WEEKLY);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CAP_WEEKLY;
}

function isoInHours(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1_000).toISOString();
}

function nextWeekBoundary(): Date {
  const now = new Date();
  const day = now.getUTCDay();
  const daysUntilMonday = day === 0 ? 1 : 8 - day;
  const boundary = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + daysUntilMonday,
    0,
    0,
    0,
    0,
  ));
  return boundary;
}

function currentWeekStart(): Date {
  const boundary = nextWeekBoundary();
  return new Date(boundary.getTime() - 7 * 24 * 60 * 60 * 1_000);
}

function extractAdminUsageRecords(payload: unknown): UsageRecord[] {
  if (Array.isArray(payload)) {
    return payload.filter(isUsageRecord);
  }

  if (typeof payload !== 'object' || payload === null) {
    return [];
  }

  const record = payload as Record<string, unknown>;
  const nested = record.results ?? record.data ?? record.usage;
  if (Array.isArray(nested)) {
    return nested.filter(isUsageRecord);
  }

  return [];
}

function isUsageRecord(value: unknown): value is UsageRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.timestamp === 'string'
    || typeof record.total_tokens === 'number'
    || typeof record.input_tokens === 'number'
    || typeof record.output_tokens === 'number';
}

function usageRecordTokens(record: UsageRecord): number {
  if (typeof record.total_tokens === 'number') return record.total_tokens;
  return (
    (record.input_tokens ?? 0) +
    (record.output_tokens ?? 0) +
    (record.cache_creation_input_tokens ?? 0) +
    (record.cache_read_input_tokens ?? 0)
  );
}

function sumEntries(entries: Array<{ agent?: string; tokens: number; dollars: number }>): AgentTokenUsage[] {
  const grouped = new Map<string, AgentTokenUsage>();

  for (const entry of entries) {
    const agent = entry.agent ?? 'unknown';
    const current = grouped.get(agent) ?? { agent, tokens: 0, dollars: 0 };
    current.tokens += entry.tokens;
    current.dollars += entry.dollars;
    grouped.set(agent, current);
  }

  return Array.from(grouped.values())
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 3);
}

function buildHourlySparkline(entries: TokenEventEntry[]): number[] {
  const now = Date.now();
  const buckets = Array.from({ length: 24 }, () => 0);

  for (const entry of entries) {
    const timestamp = Date.parse(entry.timestamp);
    if (!Number.isFinite(timestamp)) continue;
    const hoursAgo = Math.floor((now - timestamp) / (60 * 60 * 1_000));
    if (hoursAgo < 0 || hoursAgo >= 24) continue;
    const index = 23 - hoursAgo;
    buckets[index] += entry.tokens;
  }

  return buckets;
}

function getAnalyticsRoots(): string[] {
  const override = process.env.CORTEXTOS_HOME?.trim();
  const orgs = getOrgs();
  return orgs.map((org) =>
    override
      ? path.join(path.resolve(override), 'orgs', org, 'analytics', 'events')
      : path.join(CTX_ROOT, 'orgs', org, 'analytics', 'events'),
  );
}

function readMetadataRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function extractEventTokens(metadata: Record<string, unknown>): number {
  const total = metadata.total_tokens;
  if (typeof total === 'number' && Number.isFinite(total)) return total;

  const direct = metadata.tokens;
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct;

  const parts = [
    metadata.input_tokens,
    metadata.output_tokens,
    metadata.cache_creation_input_tokens,
    metadata.cache_read_input_tokens,
  ];

  return parts.reduce<number>((sum, value) => {
    if (typeof value === 'number' && Number.isFinite(value)) return sum + value;
    return sum;
  }, 0);
}

function readFallbackTokenEntries(): TokenEventEntry[] {
  const entries: TokenEventEntry[] = [];

  for (const eventsRoot of getAnalyticsRoots()) {
    if (!fs.existsSync(eventsRoot)) continue;

    for (const agentDir of fs.readdirSync(eventsRoot, { withFileTypes: true })) {
      if (!agentDir.isDirectory() || agentDir.name.startsWith('.')) continue;
      const fullAgentDir = path.join(eventsRoot, agentDir.name);
      const files = fs
        .readdirSync(fullAgentDir)
        .filter((name) => name.endsWith('.jsonl'))
        .sort()
        .slice(-8);

      for (const fileName of files) {
        const fullPath = path.join(fullAgentDir, fileName);
        const lines = fs.readFileSync(fullPath, 'utf-8').split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed) as Record<string, unknown>;
            const metadata = readMetadataRecord(parsed.metadata);
            const tokens = extractEventTokens(metadata);
            const costUsd = metadata.cost_usd;
            const dollars = typeof costUsd === 'number' && Number.isFinite(costUsd)
              ? costUsd
              : 0;
            const timestamp = typeof parsed.timestamp === 'string' ? parsed.timestamp : '';

            if (!timestamp) continue;
            entries.push({
              agent: typeof parsed.agent === 'string' ? parsed.agent : agentDir.name,
              timestamp,
              tokens,
              dollars,
            });
          } catch {
            // Ignore malformed JSONL lines.
          }
        }
      }
    }
  }

  return entries;
}

async function fetchAdminUsage(): Promise<TokenLimitsSnapshot | null> {
  const adminKey = process.env.ANTHROPIC_ADMIN_KEY;
  if (!adminKey) return null;

  const baseUrl = process.env.ANTHROPIC_API_BASE_URL ?? 'https://api.anthropic.com';
  const fiveHourStart = new Date(Date.now() - 5 * 60 * 60 * 1_000).toISOString();
  const weeklyStart = currentWeekStart().toISOString();

  try {
    const [fiveHourResponse, weeklyResponse] = await Promise.all([
      fetch(`${baseUrl}/v1/organizations/usage_report?starting_at=${encodeURIComponent(fiveHourStart)}`, {
        headers: {
          'x-api-key': adminKey,
          'anthropic-version': '2023-06-01',
        },
        cache: 'no-store',
      }),
      fetch(`${baseUrl}/v1/organizations/usage_report?starting_at=${encodeURIComponent(weeklyStart)}`, {
        headers: {
          'x-api-key': adminKey,
          'anthropic-version': '2023-06-01',
        },
        cache: 'no-store',
      }),
    ]);

    if (!fiveHourResponse.ok || !weeklyResponse.ok) {
      return null;
    }

    const [fiveHourPayload, weeklyPayload] = await Promise.all([
      fiveHourResponse.json(),
      weeklyResponse.json(),
    ]);

    const fiveHourRecords = extractAdminUsageRecords(fiveHourPayload);
    const weeklyRecords = extractAdminUsageRecords(weeklyPayload);

    const fiveHourUsed = fiveHourRecords.reduce((sum, record) => sum + usageRecordTokens(record), 0);
    const weeklyUsed = weeklyRecords.reduce((sum, record) => sum + usageRecordTokens(record), 0);

    return {
      fiveHour: {
        used: fiveHourUsed,
        cap: getFiveHourCap(),
        resetAt: isoInHours(5),
        byAgent: sumEntries(
          fiveHourRecords.map((record) => ({
            agent: record.agent,
            tokens: usageRecordTokens(record),
            dollars: 0,
          })),
        ),
      },
      weekly: {
        used: weeklyUsed,
        cap: getWeeklyCap(),
        resetAt: nextWeekBoundary().toISOString(),
        pace: Math.min(1, (Date.now() - currentWeekStart().getTime()) / (7 * 24 * 60 * 60 * 1_000)),
        byAgent: sumEntries(
          weeklyRecords.map((record) => ({
            agent: record.agent,
            tokens: usageRecordTokens(record),
            dollars: 0,
          })),
        ),
      },
      burn24h: {
        points: Array.from({ length: 24 }, () => 0),
        tokens: 0,
        dollars: 0,
      },
      source: 'admin',
    };
  } catch {
    return null;
  }
}

function buildFallbackSnapshot(): TokenLimitsSnapshot {
  const now = Date.now();
  const fiveHoursAgo = now - 5 * 60 * 60 * 1_000;
  const twentyFourHoursAgo = now - 24 * 60 * 60 * 1_000;
  const weekStartMs = currentWeekStart().getTime();

  const allEntries = readFallbackTokenEntries();
  const fiveHourEntries = allEntries.filter((entry) => Date.parse(entry.timestamp) >= fiveHoursAgo);
  const weeklyEntries = allEntries.filter((entry) => Date.parse(entry.timestamp) >= weekStartMs);
  const burnEntries = allEntries.filter((entry) => Date.parse(entry.timestamp) >= twentyFourHoursAgo);

  return {
    fiveHour: {
      used: fiveHourEntries.reduce((sum, entry) => sum + entry.tokens, 0),
      cap: getFiveHourCap(),
      resetAt: isoInHours(5),
      byAgent: sumEntries(
        fiveHourEntries.map((entry) => ({
          agent: entry.agent,
          tokens: entry.tokens,
          dollars: entry.dollars,
        })),
      ),
    },
    weekly: {
      used: weeklyEntries.reduce((sum, entry) => sum + entry.tokens, 0),
      cap: getWeeklyCap(),
      resetAt: nextWeekBoundary().toISOString(),
      pace: Math.min(1, (now - weekStartMs) / (7 * 24 * 60 * 60 * 1_000)),
      byAgent: sumEntries(
        weeklyEntries.map((entry) => ({
          agent: entry.agent,
          tokens: entry.tokens,
          dollars: entry.dollars,
        })),
      ),
    },
    burn24h: {
      points: buildHourlySparkline(burnEntries),
      tokens: burnEntries.reduce((sum, entry) => sum + entry.tokens, 0),
      dollars: burnEntries.reduce((sum, entry) => sum + entry.dollars, 0),
    },
    source: 'fallback',
    fallbackReason: process.env.ANTHROPIC_ADMIN_KEY ? 'admin_fetch_failed' : 'admin_key_missing',
  };
}

export async function getTokenUsage(): Promise<TokenLimitsSnapshot> {
  const cacheKey = 'token-usage';
  const cached = getCached(tokenUsageCache, cacheKey);
  if (cached) return cached;

  console.error('[cache-miss] getTokenUsage');
  const adminSnapshot = await fetchAdminUsage();
  const snapshot = adminSnapshot ?? buildFallbackSnapshot();
  return setCached(tokenUsageCache, cacheKey, snapshot, TOKEN_CACHE_TTL_MS);
}
