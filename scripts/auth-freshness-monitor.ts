#!/usr/bin/env tsx
/**
 * auth-freshness-monitor.ts
 * Probes key credentials and upserts freshness rows to public.auth_sessions.
 *
 * Usage:
 *   npx tsx scripts/auth-freshness-monitor.ts
 *
 * Exit code 0 = all probes ok (or skipped).
 * Exit code 1 = at least one probe returned 'error'.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ProbeStatus = 'ok' | 'expired' | 'error' | 'skipped';

interface ProbeResult {
  service: string;
  account: string;
  is_valid: boolean;
  probe_status: ProbeStatus;
  probe_detail: string | null;
  expires_hint: string | null;
}

// ---------------------------------------------------------------------------
// Env loading — same pattern as theta-freshness-watchdog.ts
// ---------------------------------------------------------------------------

function readEnvFile(filePath: string): void {
  try {
    const raw = readFileSync(filePath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const [key, ...rest] = trimmed.split('=');
      if (!process.env[key]) process.env[key] = rest.join('=').replace(/^['"]|['"]$/g, '');
    }
  } catch {
    // Optional local env hydration; explicit process env still wins.
  }
}

function loadEnv(): void {
  const root = process.env.CTX_ROOT ?? '/home/cortextos/cortextos';
  readEnvFile(join(root, 'orgs/revops-global/secrets.env'));
  // Also try agent .env for TELEGRAM_CHAT_ID fallback
  readEnvFile(join(root, 'orgs/revops-global/agents/orchestrator/.env'));
}

// ---------------------------------------------------------------------------
// Supabase upsert
// ---------------------------------------------------------------------------

async function upsertAuthSession(result: ProbeResult): Promise<void> {
  const url = process.env.SUPABASE_RGOS_URL;
  const key = process.env.SUPABASE_RGOS_SERVICE_KEY;
  if (!url || !key) throw new Error('missing SUPABASE_RGOS_URL or SUPABASE_RGOS_SERVICE_KEY');

  const now = new Date().toISOString();
  const body = {
    service: result.service,
    account: result.account,
    captured_at: now,
    expires_hint: result.expires_hint,
    is_valid: result.is_valid,
    probe_status: result.probe_status,
    probe_detail: result.probe_detail,
    updated_at: now,
  };

  const endpoint = `${url}/rest/v1/auth_sessions`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`upsert failed for ${result.service}: ${response.status} ${detail}`);
  }
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

async function probeAnthropic(): Promise<ProbeResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { service: 'anthropic', account: 'default', is_valid: false, probe_status: 'skipped', probe_detail: 'ANTHROPIC_API_KEY not set', expires_hint: null };
  }
  try {
    const resp = await fetch('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    });
    if (resp.status === 200) {
      return { service: 'anthropic', account: 'default', is_valid: true, probe_status: 'ok', probe_detail: null, expires_hint: null };
    }
    if (resp.status === 401) {
      return { service: 'anthropic', account: 'default', is_valid: false, probe_status: 'expired', probe_detail: `HTTP 401`, expires_hint: null };
    }
    return { service: 'anthropic', account: 'default', is_valid: false, probe_status: 'error', probe_detail: `HTTP ${resp.status}`, expires_hint: null };
  } catch (err) {
    return { service: 'anthropic', account: 'default', is_valid: false, probe_status: 'error', probe_detail: err instanceof Error ? err.message : String(err), expires_hint: null };
  }
}

async function probeOpenAI(): Promise<ProbeResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { service: 'openai', account: 'default', is_valid: false, probe_status: 'skipped', probe_detail: 'OPENAI_API_KEY not set', expires_hint: null };
  }
  try {
    const resp = await fetch('https://api.openai.com/v1/models', {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });
    if (resp.status === 200) {
      return { service: 'openai', account: 'default', is_valid: true, probe_status: 'ok', probe_detail: null, expires_hint: null };
    }
    if (resp.status === 401) {
      return { service: 'openai', account: 'default', is_valid: false, probe_status: 'expired', probe_detail: `HTTP 401`, expires_hint: null };
    }
    return { service: 'openai', account: 'default', is_valid: false, probe_status: 'error', probe_detail: `HTTP ${resp.status}`, expires_hint: null };
  } catch (err) {
    return { service: 'openai', account: 'default', is_valid: false, probe_status: 'error', probe_detail: err instanceof Error ? err.message : String(err), expires_hint: null };
  }
}

async function probeGoogleOAuth(): Promise<ProbeResult> {
  const clientId = process.env.GOOGLE_CLIENT_ID ?? process.env.GWS_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? process.env.GWS_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  const account = 'greg.harned@supremeopti.com';

  if (!clientId || !clientSecret || !refreshToken) {
    const missing = [
      !clientId ? 'GOOGLE_CLIENT_ID/GWS_OAUTH_CLIENT_ID' : null,
      !clientSecret ? 'GOOGLE_CLIENT_SECRET/GWS_OAUTH_CLIENT_SECRET' : null,
      !refreshToken ? 'GOOGLE_REFRESH_TOKEN' : null,
    ].filter(Boolean).join(', ');
    return { service: 'google-oauth', account, is_valid: false, probe_status: 'skipped', probe_detail: `missing: ${missing}`, expires_hint: null };
  }

  try {
    const params = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const body = await resp.json() as Record<string, unknown>;
    if (resp.status === 200 && typeof body['access_token'] === 'string') {
      return { service: 'google-oauth', account, is_valid: true, probe_status: 'ok', probe_detail: null, expires_hint: null };
    }
    const errDesc = typeof body['error_description'] === 'string' ? body['error_description'] : `HTTP ${resp.status}`;
    return { service: 'google-oauth', account, is_valid: false, probe_status: 'expired', probe_detail: errDesc, expires_hint: null };
  } catch (err) {
    return { service: 'google-oauth', account, is_valid: false, probe_status: 'error', probe_detail: err instanceof Error ? err.message : String(err), expires_hint: null };
  }
}

async function probeLinkedIn(): Promise<ProbeResult> {
  const liAt = process.env.LINKEDIN_LI_AT;
  const account = 'default';

  if (!liAt) {
    return { service: 'linkedin', account, is_valid: false, probe_status: 'skipped', probe_detail: 'LINKEDIN_LI_AT not set', expires_hint: null };
  }

  const expiresHint = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

  try {
    const resp = await fetch('https://www.linkedin.com/voyager/api/identity/profiles/me', {
      headers: {
        Cookie: `li_at=${liAt}`,
        'x-li-lang': 'en_US',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      },
    });
    if (resp.status === 200) {
      return { service: 'linkedin', account, is_valid: true, probe_status: 'ok', probe_detail: null, expires_hint: expiresHint };
    }
    if (resp.status === 401 || resp.status === 403) {
      return { service: 'linkedin', account, is_valid: false, probe_status: 'expired', probe_detail: `HTTP ${resp.status}`, expires_hint: null };
    }
    return { service: 'linkedin', account, is_valid: false, probe_status: 'error', probe_detail: `HTTP ${resp.status}`, expires_hint: expiresHint };
  } catch (err) {
    return { service: 'linkedin', account, is_valid: false, probe_status: 'error', probe_detail: err instanceof Error ? err.message : String(err), expires_hint: expiresHint };
  }
}

async function probeSupabase(): Promise<ProbeResult> {
  const url = process.env.SUPABASE_RGOS_URL;
  const key = process.env.SUPABASE_RGOS_SERVICE_KEY;

  if (!url || !key) {
    return { service: 'supabase-rgos', account: 'default', is_valid: false, probe_status: 'skipped', probe_detail: 'SUPABASE_RGOS_URL or SUPABASE_RGOS_SERVICE_KEY not set', expires_hint: null };
  }

  try {
    const endpoint = `${url}/rest/v1/orch_agents?select=id&limit=1`;
    const resp = await fetch(endpoint, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
    });
    if (resp.status === 200) {
      return { service: 'supabase-rgos', account: 'default', is_valid: true, probe_status: 'ok', probe_detail: null, expires_hint: null };
    }
    return { service: 'supabase-rgos', account: 'default', is_valid: false, probe_status: 'error', probe_detail: `HTTP ${resp.status}`, expires_hint: null };
  } catch (err) {
    return { service: 'supabase-rgos', account: 'default', is_valid: false, probe_status: 'error', probe_detail: err instanceof Error ? err.message : String(err), expires_hint: null };
  }
}

// ---------------------------------------------------------------------------
// Summary table
// ---------------------------------------------------------------------------

function printSummary(results: ProbeResult[]): void {
  const col1 = Math.max(16, ...results.map(r => r.service.length));
  const col2 = Math.max(7, ...results.map(r => r.probe_status.length));
  const header = `${'service'.padEnd(col1)}  ${'status'.padEnd(col2)}  detail`;
  const sep = '-'.repeat(header.length);
  console.log(sep);
  console.log(header);
  console.log(sep);
  for (const r of results) {
    const icon = r.probe_status === 'ok' ? '✓' : r.probe_status === 'skipped' ? '⚠' : '✗';
    const detail = r.probe_detail ?? '';
    console.log(`${r.service.padEnd(col1)}  ${(icon + ' ' + r.probe_status).padEnd(col2 + 2)}  ${detail}`);
  }
  console.log(sep);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  loadEnv();

  const probes: Array<() => Promise<ProbeResult>> = [
    probeAnthropic,
    probeOpenAI,
    probeGoogleOAuth,
    probeLinkedIn,
    probeSupabase,
  ];

  const results: ProbeResult[] = [];
  const upsertErrors: string[] = [];

  for (const probe of probes) {
    let result: ProbeResult;
    try {
      result = await probe();
    } catch (err) {
      // Defensive: probe functions already catch internally, but belt-and-suspenders
      result = {
        service: probe.name.replace(/^probe/, '').toLowerCase() || 'unknown',
        account: 'default',
        is_valid: false,
        probe_status: 'error',
        probe_detail: err instanceof Error ? err.message : String(err),
        expires_hint: null,
      };
    }
    results.push(result);

    // Upsert to Supabase (best-effort — don't let upsert errors abort remaining probes)
    try {
      await upsertAuthSession(result);
    } catch (err) {
      upsertErrors.push(`${result.service}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  printSummary(results);

  if (upsertErrors.length > 0) {
    console.error('\nUpsert errors:');
    for (const e of upsertErrors) console.error(`  ${e}`);
  }

  const hasError = results.some(r => r.probe_status === 'error');
  if (hasError || upsertErrors.length > 0) {
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
});
