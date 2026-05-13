import fs from 'fs';
import path from 'path';
import os from 'os';

const ANTHROPIC_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CTX_ROOT = process.env.CTX_ROOT ?? path.join(os.homedir(), '.cortextos', process.env.CTX_INSTANCE_ID ?? 'default');
const CACHE_DIR = path.join(CTX_ROOT, 'state', 'dashboard');
const CACHE_PATH = path.join(CACHE_DIR, 'quota-last-good.json');

export interface QuotaSnapshot {
  five_hour_remaining_pct: number;
  seven_day_remaining_pct: number;
  fetched_at: string;
  source: 'env' | 'credentials.json' | 'accounts.json';
}

export interface QuotaResponse extends QuotaSnapshot {
  stale: boolean;
  cache_age_ms: number;
}

function normalizeUtilization(v: number | undefined): number {
  if (v === undefined || v === null) return 0;
  return v > 1 ? v / 100 : v;
}

function readClaudeCredentialsToken(): string | null {
  const credentialsPath = path.join(os.homedir(), '.claude', '.credentials.json');
  if (!fs.existsSync(credentialsPath)) return null;

  try {
    const parsed = JSON.parse(fs.readFileSync(credentialsPath, 'utf-8')) as {
      claudeAiOauth?: {
        accessToken?: string;
        access_token?: string;
      };
    };
    return parsed.claudeAiOauth?.accessToken ?? parsed.claudeAiOauth?.access_token ?? null;
  } catch {
    return null;
  }
}

function readAccountsJsonToken(): string | null {
  const accountsPath = path.join(CTX_ROOT, 'state', 'oauth', 'accounts.json');
  if (!fs.existsSync(accountsPath)) return null;

  try {
    const parsed = JSON.parse(fs.readFileSync(accountsPath, 'utf-8')) as {
      active?: string;
      accounts?: Record<string, { access_token?: string }>;
    };
    const active = parsed.active;
    return active ? parsed.accounts?.[active]?.access_token ?? null : null;
  } catch {
    return null;
  }
}

function getOAuthToken(): { token: string; source: QuotaSnapshot['source'] } | null {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { token: process.env.CLAUDE_CODE_OAUTH_TOKEN, source: 'env' };
  }

  const credentialsToken = readClaudeCredentialsToken();
  if (credentialsToken) return { token: credentialsToken, source: 'credentials.json' };

  const accountsToken = readAccountsJsonToken();
  if (accountsToken) return { token: accountsToken, source: 'accounts.json' };

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
    fs.writeFileSync(CACHE_PATH, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
  } catch {
    // Best effort only. A cache write failure should not break the dashboard.
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
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return null;

  const data = (await response.json()) as {
    five_hour?: { utilization?: number };
    seven_day?: { utilization?: number };
    five_hour_utilization?: number;
    seven_day_utilization?: number;
    fiveHourUtilization?: number;
    sevenDayUtilization?: number;
  };

  const fiveHour = normalizeUtilization(
    data.five_hour?.utilization ?? data.five_hour_utilization ?? data.fiveHourUtilization,
  );
  const sevenDay = normalizeUtilization(
    data.seven_day?.utilization ?? data.seven_day_utilization ?? data.sevenDayUtilization,
  );

  return {
    five_hour_remaining_pct: Math.max(0, Math.round((1 - fiveHour) * 100)),
    seven_day_remaining_pct: Math.max(0, Math.round((1 - sevenDay) * 100)),
    fetched_at: new Date().toISOString(),
    source: auth.source,
  };
}

export async function fetchQuotaSnapshot(): Promise<QuotaResponse | null> {
  const fresh = await fetchFresh();
  if (fresh) {
    writeCache(fresh);
    return { ...fresh, stale: false, cache_age_ms: 0 };
  }

  const cached = readCache();
  if (!cached) return null;

  const cacheAgeMs = Date.now() - new Date(cached.fetched_at).getTime();
  return { ...cached, stale: true, cache_age_ms: Math.max(0, cacheAgeMs) };
}
