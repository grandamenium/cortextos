/**
 * Quota helpers for the dashboard's quota-usage indicator.
 *
 * Mirrors the OAuth-token fallback logic the bash watchdog uses
 * (`/root/cortextos/bin/quota-watchdog.sh`): read access token from
 * Claude Code's local credentials store, call Anthropic's OAuth usage API,
 * normalise to 0–1 utilization fractions.
 *
 * Adds a server-side last-good cache so transient 429s / network errors
 * don't blank the dashboard. On any failure we return the most recent
 * successful snapshot with `stale: true` and a `cache_age_ms` field;
 * the component renders an "Xm ago" suffix. Only when no cache exists
 * (cold boot) do we return null — that becomes "no data yet" in the UI.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

const ANTHROPIC_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_CREDS = path.join(os.homedir(), '.claude', '.credentials.json');

const CACHE_DIR = path.join(
  process.env.CTX_ROOT ?? path.join(os.homedir(), '.cortextos', 'default'),
  'state',
  'dashboard',
);
const CACHE_PATH = path.join(CACHE_DIR, 'quota-last-good.json');

export interface QuotaSnapshot {
  five_hour_remaining_pct: number;
  seven_day_remaining_pct: number;
  fetched_at: string;
  source: 'env' | 'credentials.json' | 'accounts.json';
}

export interface QuotaResponse extends QuotaSnapshot {
  /** True when the snapshot came from cache (API call failed). */
  stale: boolean;
  /** Milliseconds since the cached snapshot was originally fetched. 0 if fresh. */
  cache_age_ms: number;
}

export interface UsageApiBody {
  five_hour?: { utilization?: number | null } | null;
  seven_day?: { utilization?: number | null } | null;
  five_hour_utilization?: number;
  seven_day_utilization?: number;
  fiveHourUtilization?: number;
  sevenDayUtilization?: number;
}

/**
 * Usage API body → 0–1 fractions. The API returns NESTED windows with WHOLE
 * percentages ({ five_hour: { utilization: 4, resets_at } }), so nested values
 * are always divided by 100. The old `v > 1 ? v / 100 : v` read 1% as 100%
 * ("0% remaining" on a fresh account). Flat fields are a legacy fallback of
 * unknown scale and keep that heuristic. Mirrors parseUsageResponse in
 * src/bus/oauth.ts.
 */
export function parseUsageFractions(data: UsageApiBody): { fiveH: number; sevenD: number } {
  const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
  const pct = (v: number | null | undefined): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? clamp01(v / 100) : undefined;
  const legacy = (v: number | undefined): number =>
    typeof v === 'number' && Number.isFinite(v) ? clamp01(v > 1 ? v / 100 : v) : 0;
  return {
    fiveH: pct(data.five_hour?.utilization) ?? legacy(data.five_hour_utilization ?? data.fiveHourUtilization),
    sevenD: pct(data.seven_day?.utilization) ?? legacy(data.seven_day_utilization ?? data.sevenDayUtilization),
  };
}

function getOAuthToken(): { token: string; source: QuotaSnapshot['source'] } | null {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { token: process.env.CLAUDE_CODE_OAUTH_TOKEN, source: 'env' };
  }
  if (fs.existsSync(CLAUDE_CREDS)) {
    try {
      const raw = fs.readFileSync(CLAUDE_CREDS, 'utf-8');
      const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } };
      const token = parsed.claudeAiOauth?.accessToken;
      if (token) return { token, source: 'credentials.json' };
    } catch {
      /* fall through */
    }
  }
  return null;
}

function readCache(): QuotaSnapshot | null {
  if (!fs.existsSync(CACHE_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8')) as QuotaSnapshot;
  } catch {
    return null;
  }
}

function writeCache(snapshot: QuotaSnapshot): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(snapshot, null, 2));
  } catch {
    /* Best-effort: cache write failure shouldn't break the request. */
  }
}

async function fetchFresh(): Promise<QuotaSnapshot | null> {
  const auth = getOAuthToken();
  if (!auth) return null;

  const response = await fetch(ANTHROPIC_USAGE_URL, {
    headers: {
      Authorization: `Bearer ${auth.token}`,
      'anthropic-beta': 'oauth-2025-04-20',
    },
  });
  if (!response.ok) return null;

  const { fiveH, sevenD } = parseUsageFractions(await response.json());

  return {
    five_hour_remaining_pct: Math.round((1 - fiveH) * 100),
    seven_day_remaining_pct: Math.round((1 - sevenD) * 100),
    fetched_at: new Date().toISOString(),
    source: auth.source,
  };
}

/**
 * Fetch a quota response. Always returns the freshest available data:
 * a fresh API call when it succeeds, the cached last-good when it
 * doesn't, or null when neither is available (cold-boot only).
 */
export async function fetchQuotaSnapshot(): Promise<QuotaResponse | null> {
  const fresh = await fetchFresh();
  if (fresh) {
    writeCache(fresh);
    return { ...fresh, stale: false, cache_age_ms: 0 };
  }

  const cached = readCache();
  if (cached) {
    const cacheAgeMs = Date.now() - new Date(cached.fetched_at).getTime();
    return { ...cached, stale: true, cache_age_ms: Math.max(0, cacheAgeMs) };
  }

  return null;
}
