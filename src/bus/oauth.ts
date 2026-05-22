/**
 * OAuth token rotation system for cortextOS.
 *
 * Manages multi-account Claude OAuth credentials with automatic rotation
 * based on utilization thresholds.
 *
 * Key invariants:
 * - Refresh tokens are one-time use — always write accounts.json atomically
 *   BEFORE any preflight that could fail
 * - CLAUDE_CODE_OAUTH_TOKEN is a bare access token string (not JSON blob)
 * - accounts.json lives at state/oauth/accounts.json (per-instance, not per-org)
 * - Usage cache TTL = 3 minutes (API rate limit ~5 req/token)
 */

import { existsSync, readFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';

// --- Types ---

export interface OAuthAccount {
  label: string;
  access_token: string;
  refresh_token: string;
  expires_at: number; // Unix ms
  last_refreshed: string; // ISO 8601
  five_hour_utilization: number; // 0.0–1.0
  seven_day_utilization: number; // 0.0–1.0
}

export interface AccountsStore {
  active: string;
  accounts: Record<string, OAuthAccount>;
  rotation_log: RotationLogEntry[];
}

export interface RotationLogEntry {
  timestamp: string;
  from: string;
  to: string;
  reason: string;
  five_hour_util: number;
  seven_day_util: number;
}

export interface UsageSnapshot {
  account: string;
  five_hour_utilization: number;
  seven_day_utilization: number;
  fetched_at: string;
}

export interface UsageCache {
  snapshot: UsageSnapshot;
  expires_at: number; // Unix ms
}

export interface CheckUsageResult {
  account: string;
  five_hour_utilization: number;
  seven_day_utilization: number;
  cached: boolean;
  fetched_at: string;
}

export interface RotateResult {
  rotated: boolean;
  reason: string;
  from?: string;
  to?: string;
}

const CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes
const ROTATION_LOG_MAX = 50;

// Utilization thresholds for rotation trigger
const THRESHOLD_5H = 0.85;
const THRESHOLD_7D = 0.80;
// Alert thresholds (warn before rotating)
export const ALERT_5H = 0.80;
export const ALERT_7D = 0.70;

// --- Path helpers ---

function oauthDir(ctxRoot: string): string {
  return join(ctxRoot, 'state', 'oauth');
}

function accountsPath(ctxRoot: string): string {
  return join(oauthDir(ctxRoot), 'accounts.json');
}

function usageDir(ctxRoot: string): string {
  return join(ctxRoot, 'state', 'usage');
}

function usageCachePath(ctxRoot: string): string {
  return join(usageDir(ctxRoot), 'cache.json');
}

function usageLatestPath(ctxRoot: string): string {
  return join(usageDir(ctxRoot), 'latest.json');
}

function usageDailyPath(ctxRoot: string): string {
  const today = new Date().toISOString().split('T')[0];
  return join(usageDir(ctxRoot), `${today}.jsonl`);
}

// --- Account store helpers ---

export function loadAccounts(ctxRoot: string): AccountsStore | null {
  const path = accountsPath(ctxRoot);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as AccountsStore;
  } catch {
    return null;
  }
}

function saveAccounts(ctxRoot: string, store: AccountsStore): void {
  ensureDir(oauthDir(ctxRoot));
  const path = accountsPath(ctxRoot);
  atomicWriteSync(path, JSON.stringify(store, null, 2));
  try { chmodSync(path, 0o600); } catch { /* ignore */ }
}

export function getActiveAccount(ctxRoot: string): { name: string; account: OAuthAccount } | null {
  const store = loadAccounts(ctxRoot);
  if (!store) return null;
  const account = store.accounts[store.active];
  if (!account) return null;
  return { name: store.active, account };
}

// --- Usage cache helpers ---

function loadCache(ctxRoot: string): UsageCache | null {
  const path = usageCachePath(ctxRoot);
  if (!existsSync(path)) return null;
  try {
    const cache = JSON.parse(readFileSync(path, 'utf-8')) as UsageCache;
    return cache;
  } catch {
    return null;
  }
}

function saveCache(ctxRoot: string, snapshot: UsageSnapshot): void {
  ensureDir(usageDir(ctxRoot));
  const cache: UsageCache = {
    snapshot,
    expires_at: Date.now() + CACHE_TTL_MS,
  };
  atomicWriteSync(usageCachePath(ctxRoot), JSON.stringify(cache, null, 2));
  atomicWriteSync(usageLatestPath(ctxRoot), JSON.stringify(snapshot, null, 2));

  // Append to daily JSONL log
  const { appendFileSync } = require('fs');
  try {
    appendFileSync(usageDailyPath(ctxRoot), JSON.stringify(snapshot) + '\n');
  } catch { /* ignore */ }
}

// --- check-usage-api ---

/**
 * Fetch utilization from Anthropic usage API for the active account.
 * Respects 3-minute TTL cache to avoid hitting rate limits.
 */
export async function checkUsageApi(
  ctxRoot: string,
  opts: { force?: boolean; account?: string } = {},
): Promise<CheckUsageResult> {
  // Check cache first (unless force)
  if (!opts.force) {
    const cache = loadCache(ctxRoot);
    if (cache && cache.expires_at > Date.now()) {
      return { ...cache.snapshot, cached: true };
    }
  }

  // Determine which account to check
  let accessToken: string | undefined;
  let accountName: string;

  if (opts.account) {
    const store = loadAccounts(ctxRoot);
    const acct = store?.accounts[opts.account];
    if (!acct) throw new Error(`Account "${opts.account}" not found in accounts.json`);
    accessToken = acct.access_token;
    accountName = opts.account;
  } else {
    // Fall back to env / Keychain
    const active = getActiveAccount(ctxRoot);
    if (active) {
      accessToken = active.account.access_token;
      accountName = active.name;
    } else {
      accessToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
      accountName = 'env';
      if (!accessToken) throw new Error('No OAuth token available (no accounts.json and CLAUDE_CODE_OAUTH_TOKEN not set)');
    }
  }

  const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
    },
  });

  if (!response.ok) {
    throw new Error(`Usage API returned ${response.status}: ${await response.text()}`);
  }

  // The Anthropic OAuth usage API returns NESTED objects:
  //   { five_hour: { utilization, resets_at }, seven_day: {...}, ... }
  // The earlier flat-only parsing always returned undefined → normalize → 0
  // → "100% remaining" regardless of real usage. That made the watchdog
  // blind to real burn (it tripped only on ccusage's heuristic) and
  // hid Sondre's actual quota in the dashboard. Keep flat fallbacks in
  // case the API ever returns either shape.
  const data = await response.json() as {
    five_hour?: { utilization?: number };
    seven_day?: { utilization?: number };
    five_hour_utilization?: number;
    seven_day_utilization?: number;
    fiveHourUtilization?: number;
    sevenDayUtilization?: number;
  };

  // Normalize 0–100 → 0.0–1.0 if needed
  const normalize = (v: number | undefined) => {
    if (v === undefined) return 0;
    return v > 1 ? v / 100 : v;
  };

  const fiveHour = normalize(
    data.five_hour?.utilization ?? data.five_hour_utilization ?? data.fiveHourUtilization,
  );
  const sevenDay = normalize(
    data.seven_day?.utilization ?? data.seven_day_utilization ?? data.sevenDayUtilization,
  );
  const fetchedAt = new Date().toISOString();

  const snapshot: UsageSnapshot = {
    account: accountName,
    five_hour_utilization: fiveHour,
    seven_day_utilization: sevenDay,
    fetched_at: fetchedAt,
  };

  // Update cache and accounts.json utilization fields
  saveCache(ctxRoot, snapshot);

  const store = loadAccounts(ctxRoot);
  if (store && store.accounts[accountName]) {
    store.accounts[accountName].five_hour_utilization = fiveHour;
    store.accounts[accountName].seven_day_utilization = sevenDay;
    saveAccounts(ctxRoot, store);
  }

  return { ...snapshot, cached: false };
}

// --- refresh-oauth-token ---

/**
 * Refresh an OAuth token for the given account.
 * CRITICAL: writes accounts.json atomically BEFORE returning.
 * Refresh tokens are one-time use — the write must never be deferred.
 */
export async function refreshOAuthToken(
  ctxRoot: string,
  accountName?: string,
): Promise<{ account: string; expires_at: number }> {
  const store = loadAccounts(ctxRoot);
  if (!store) throw new Error('No accounts.json found. Cannot refresh.');

  const name = accountName || store.active;
  const account = store.accounts[name];
  if (!account) throw new Error(`Account "${name}" not found in accounts.json`);
  if (!account.refresh_token) throw new Error(`Account "${name}" has no refresh_token`);

  const response = await fetch('https://console.anthropic.com/v1/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: account.refresh_token,
    }),
  });

  if (!response.ok) {
    throw new Error(`Token refresh failed (${response.status}): ${await response.text()}`);
  }

  const tokens = await response.json() as {
    access_token: string;
    refresh_token: string;
    expires_in?: number;
  };

  if (!tokens.access_token || !tokens.refresh_token) {
    throw new Error('Token refresh response missing access_token or refresh_token');
  }

  const expiresAt = Date.now() + (tokens.expires_in ?? 3600) * 1000;

  // ATOMIC WRITE — must happen before any further use of the new tokens
  store.accounts[name] = {
    ...account,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: expiresAt,
    last_refreshed: new Date().toISOString(),
  };
  saveAccounts(ctxRoot, store);

  return { account: name, expires_at: expiresAt };
}

// --- rotate-oauth ---

/**
 * Rotate the active OAuth account based on utilization thresholds.
 *
 * Two-phase write:
 *   Phase 1: accounts.json (permanent, written after refresh)
 *   Phase 2: agent .env files (conditional on preflight passing)
 */
export async function rotateOAuth(
  ctxRoot: string,
  frameworkRoot: string,
  org: string,
  opts: { reason?: string; agent?: string; force?: boolean } = {},
): Promise<RotateResult> {
  const store = loadAccounts(ctxRoot);
  if (!store) return { rotated: false, reason: 'No accounts.json found' };

  const currentName = store.active;
  const current = store.accounts[currentName];
  if (!current) return { rotated: false, reason: `Active account "${currentName}" not found` };

  // Check utilization thresholds (or force flag)
  const needsRotation = opts.force ||
    current.five_hour_utilization >= THRESHOLD_5H ||
    current.seven_day_utilization >= THRESHOLD_7D;

  if (!needsRotation) {
    return {
      rotated: false,
      reason: `Utilization within limits (5h: ${pct(current.five_hour_utilization)}, 7d: ${pct(current.seven_day_utilization)})`,
    };
  }

  // Find the next account with lowest 5h utilization
  const candidates = Object.entries(store.accounts)
    .filter(([name]) => name !== currentName)
    .sort(([, a], [, b]) => a.five_hour_utilization - b.five_hour_utilization);

  if (candidates.length === 0) {
    return { rotated: false, reason: 'No alternate accounts available for rotation' };
  }

  let [nextName, nextAccount] = candidates[0];

  // Refresh next account token if expiring within 2 hours
  if (nextAccount.expires_at - Date.now() < 2 * 60 * 60 * 1000) {
    await refreshOAuthToken(ctxRoot, nextName);
    // Reload after refresh (accounts.json was rewritten)
    const refreshed = loadAccounts(ctxRoot)!;
    nextAccount = refreshed.accounts[nextName];
  }

  // PREFLIGHT: verify next account's token works
  let preflight: CheckUsageResult;
  try {
    preflight = await checkUsageApi(ctxRoot, { force: true, account: nextName });
  } catch (err) {
    // Preflight failed — do NOT write .env files
    return {
      rotated: false,
      reason: `Preflight failed for account "${nextName}": ${err}`,
    };
  }

  // PHASE 1: Update accounts.json (active + rotation_log)
  const reloaded = loadAccounts(ctxRoot)!;
  reloaded.active = nextName;
  reloaded.accounts[nextName].five_hour_utilization = preflight.five_hour_utilization;
  reloaded.accounts[nextName].seven_day_utilization = preflight.seven_day_utilization;

  const logEntry: RotationLogEntry = {
    timestamp: new Date().toISOString(),
    from: currentName,
    to: nextName,
    reason: opts.reason || buildRotationReason(current),
    five_hour_util: current.five_hour_utilization,
    seven_day_util: current.seven_day_utilization,
  };
  reloaded.rotation_log = [logEntry, ...reloaded.rotation_log].slice(0, ROTATION_LOG_MAX);
  saveAccounts(ctxRoot, reloaded);

  // PHASE 2: Write bare access token to agent .env files
  const finalStore = loadAccounts(ctxRoot)!;
  const newToken = finalStore.accounts[nextName].access_token;
  writeTokenToAgents(frameworkRoot, org, newToken, opts.agent);

  return {
    rotated: true,
    reason: logEntry.reason,
    from: currentName,
    to: nextName,
  };
}

// --- Helpers ---

function buildRotationReason(account: OAuthAccount): string {
  if (account.five_hour_utilization >= THRESHOLD_5H) {
    return `5h utilization at ${pct(account.five_hour_utilization)} (threshold: ${pct(THRESHOLD_5H)})`;
  }
  return `7d utilization at ${pct(account.seven_day_utilization)} (threshold: ${pct(THRESHOLD_7D)})`;
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

/**
 * Write the bare access token to agent .env files.
 * Writes CLAUDE_CODE_OAUTH_TOKEN=<token> — bare string, not JSON.
 * Scoped to a specific agent if opts.agent is set, otherwise all agents in org.
 */
function writeTokenToAgents(
  frameworkRoot: string,
  org: string,
  token: string,
  targetAgent?: string,
): void {
  const agentsBase = join(frameworkRoot, 'orgs', org, 'agents');
  if (!existsSync(agentsBase)) return;

  const { readdirSync, writeFileSync } = require('fs');

  let agentNames: string[];
  if (targetAgent) {
    agentNames = [targetAgent];
  } else {
    try {
      agentNames = readdirSync(agentsBase, { withFileTypes: true })
        .filter((d: { isDirectory(): boolean }) => d.isDirectory())
        .map((d: { name: string }) => d.name);
    } catch {
      return;
    }
  }

  for (const name of agentNames) {
    const envPath = join(agentsBase, name, '.env');
    if (!existsSync(envPath)) continue;

    try {
      let content = readFileSync(envPath, 'utf-8');

      if (content.includes('CLAUDE_CODE_OAUTH_TOKEN=')) {
        // Replace existing line
        content = content.replace(
          /^CLAUDE_CODE_OAUTH_TOKEN=.*$/m,
          `CLAUDE_CODE_OAUTH_TOKEN=${token}`,
        );
      } else {
        // Append new line
        content = content.trimEnd() + `\nCLAUDE_CODE_OAUTH_TOKEN=${token}\n`;
      }

      atomicWriteSync(envPath, content);
      try { chmodSync(envPath, 0o600); } catch { /* ignore */ }
    } catch { /* skip agents whose .env we can't write */ }
  }
}
