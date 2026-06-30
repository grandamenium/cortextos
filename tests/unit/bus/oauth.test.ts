import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const {
  loadAccounts,
  getActiveAccount,
  checkUsageApi,
  refreshOAuthToken,
  rotateOAuth,
  ALERT_5H,
  ALERT_7D,
} = await import('../../../src/bus/oauth.js');

// Use 4h expiry to stay above the 2h refresh-before-use threshold
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

const SAMPLE_STORE = {
  active: 'primary',
  accounts: {
    primary: {
      label: 'Primary Account',
      access_token: 'tok_primary_abc',
      refresh_token: 'rtok_primary_xyz',
      expires_at: Date.now() + FOUR_HOURS_MS,
      last_refreshed: '2026-04-05T00:00:00Z',
      five_hour_utilization: 0.3,
      seven_day_utilization: 0.2,
    },
    secondary: {
      label: 'Secondary Account',
      access_token: 'tok_secondary_def',
      refresh_token: 'rtok_secondary_uvw',
      expires_at: Date.now() + FOUR_HOURS_MS,
      last_refreshed: '2026-04-05T00:00:00Z',
      five_hour_utilization: 0.1,
      seven_day_utilization: 0.05,
    },
  },
  rotation_log: [],
};

let tmpDir: string;

function writeStore(store = SAMPLE_STORE) {
  const { mkdirSync, writeFileSync } = require('fs');
  const oauthDir = join(tmpDir, 'state', 'oauth');
  mkdirSync(oauthDir, { recursive: true });
  writeFileSync(join(oauthDir, 'accounts.json'), JSON.stringify(store, null, 2));
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cortextos-oauth-test-'));
  mockFetch.mockReset();
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
});

describe('loadAccounts', () => {
  it('returns null when no accounts.json', () => {
    expect(loadAccounts(tmpDir)).toBeNull();
  });

  it('loads valid accounts.json', () => {
    writeStore();
    const store = loadAccounts(tmpDir);
    expect(store?.active).toBe('primary');
    expect(store?.accounts.primary.access_token).toBe('tok_primary_abc');
  });
});

describe('getActiveAccount', () => {
  it('returns null when no store', () => {
    expect(getActiveAccount(tmpDir)).toBeNull();
  });

  it('returns active account', () => {
    writeStore();
    const result = getActiveAccount(tmpDir);
    expect(result?.name).toBe('primary');
    expect(result?.account.access_token).toBe('tok_primary_abc');
  });
});

describe('checkUsageApi', () => {
  it('fetches and caches usage data', async () => {
    writeStore();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ five_hour_utilization: 0.42, seven_day_utilization: 0.18 }),
    });

    const result = await checkUsageApi(tmpDir);
    expect(result.five_hour_utilization).toBe(0.42);
    expect(result.seven_day_utilization).toBe(0.18);
    expect(result.cached).toBe(false);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('normalizes 0-100 values to 0.0-1.0', async () => {
    writeStore();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ five_hour_utilization: 42, seven_day_utilization: 18 }),
    });

    const result = await checkUsageApi(tmpDir, { force: true });
    expect(result.five_hour_utilization).toBeCloseTo(0.42);
    expect(result.seven_day_utilization).toBeCloseTo(0.18);
  });

  it('returns cached result within TTL', async () => {
    writeStore();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ five_hour_utilization: 0.5, seven_day_utilization: 0.3 }),
    });

    await checkUsageApi(tmpDir); // prime cache
    const cached = await checkUsageApi(tmpDir); // should hit cache
    expect(cached.cached).toBe(true);
    expect(mockFetch).toHaveBeenCalledOnce(); // only one real fetch
  });

  it('bypasses cache with --force', async () => {
    writeStore();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ five_hour_utilization: 0.5, seven_day_utilization: 0.3 }),
    });

    await checkUsageApi(tmpDir);
    const fresh = await checkUsageApi(tmpDir, { force: true });
    expect(fresh.cached).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('throws on non-ok API response', async () => {
    writeStore();
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });

    await expect(checkUsageApi(tmpDir, { force: true })).rejects.toThrow('401');
  });

  it('uses Bearer token from active account', async () => {
    writeStore();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ five_hour_utilization: 0.1, seven_day_utilization: 0.05 }),
    });

    await checkUsageApi(tmpDir, { force: true });
    const call = mockFetch.mock.calls[0];
    expect(call[1].headers.Authorization).toBe('Bearer tok_primary_abc');
    expect(call[1].headers['anthropic-beta']).toBe('oauth-2025-04-20');
  });
});

describe('refreshOAuthToken', () => {
  it('throws when no accounts.json', async () => {
    await expect(refreshOAuthToken(tmpDir)).rejects.toThrow('No accounts.json');
  });

  it('refreshes active account and writes atomically', async () => {
    writeStore();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'new_access_tok',
        refresh_token: 'new_refresh_tok',
        expires_in: 3600,
      }),
    });

    const result = await refreshOAuthToken(tmpDir);
    expect(result.account).toBe('primary');
    expect(result.expires_at).toBeGreaterThan(Date.now());

    const call = mockFetch.mock.calls[0];
    expect(call[0]).toBe('https://platform.claude.com/v1/oauth/token');
    expect(call[1].headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(call[1].headers.Accept).toBe('application/json');
    expect(call[1].body).toBeInstanceOf(URLSearchParams);
    expect(call[1].body.get('grant_type')).toBe('refresh_token');
    expect(call[1].body.get('refresh_token')).toBe('rtok_primary_xyz');
    expect(call[1].body.get('client_id')).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e');

    // Verify accounts.json was rewritten with new tokens
    const store = loadAccounts(tmpDir)!;
    expect(store.accounts.primary.access_token).toBe('new_access_tok');
    expect(store.accounts.primary.refresh_token).toBe('new_refresh_tok');
  });

  it('refreshes named account', async () => {
    writeStore();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'sec_new_tok',
        refresh_token: 'sec_new_rtok',
        expires_in: 3600,
      }),
    });

    await refreshOAuthToken(tmpDir, 'secondary');
    const store = loadAccounts(tmpDir)!;
    expect(store.accounts.secondary.access_token).toBe('sec_new_tok');
    // Primary should be unchanged
    expect(store.accounts.primary.access_token).toBe('tok_primary_abc');
  });

  it('throws on failed refresh', async () => {
    writeStore();
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => 'invalid_grant',
    });

    await expect(refreshOAuthToken(tmpDir)).rejects.toThrow('400');
  });
});

describe('rotateOAuth', () => {
  const frameworkRoot = '/tmp/fw';

  it('does not rotate when utilization is low', async () => {
    writeStore(); // primary at 30%/20% — below thresholds
    const result = await rotateOAuth(tmpDir, frameworkRoot, 'acme');
    expect(result.rotated).toBe(false);
    expect(result.reason).toContain('within limits');
  });

  it('rotates when 5h utilization exceeds threshold', async () => {
    const highUtilStore = {
      ...SAMPLE_STORE,
      accounts: {
        ...SAMPLE_STORE.accounts,
        primary: { ...SAMPLE_STORE.accounts.primary, five_hour_utilization: 0.90 },
      },
    };
    writeStore(highUtilStore);

    // Preflight fetch for secondary
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ five_hour_utilization: 0.1, seven_day_utilization: 0.05 }),
    });

    const result = await rotateOAuth(tmpDir, frameworkRoot, 'acme');
    expect(result.rotated).toBe(true);
    expect(result.from).toBe('primary');
    expect(result.to).toBe('secondary');

    // accounts.json should show secondary as active
    const store = loadAccounts(tmpDir)!;
    expect(store.active).toBe('secondary');
    expect(store.rotation_log).toHaveLength(1);
    expect(store.rotation_log[0].from).toBe('primary');
  });

  it('does not rotate when preflight fails', async () => {
    const highUtilStore = {
      ...SAMPLE_STORE,
      accounts: {
        ...SAMPLE_STORE.accounts,
        primary: { ...SAMPLE_STORE.accounts.primary, five_hour_utilization: 0.90 },
      },
    };
    writeStore(highUtilStore);

    // Preflight fails
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });

    const result = await rotateOAuth(tmpDir, frameworkRoot, 'acme');
    expect(result.rotated).toBe(false);
    expect(result.reason).toContain('Preflight failed');

    // accounts.json active should be unchanged
    const store = loadAccounts(tmpDir)!;
    expect(store.active).toBe('primary');
  });

  it('force-rotates regardless of utilization', async () => {
    writeStore(); // low utilization

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ five_hour_utilization: 0.1, seven_day_utilization: 0.05 }),
    });

    const result = await rotateOAuth(tmpDir, frameworkRoot, 'acme', { force: true });
    expect(result.rotated).toBe(true);
  });

  it('returns error when no alternate accounts', async () => {
    const singleAccountStore = {
      active: 'primary',
      accounts: { primary: SAMPLE_STORE.accounts.primary },
      rotation_log: [],
    };
    writeStore(singleAccountStore);
    const store = loadAccounts(tmpDir)!;
    store.accounts.primary.five_hour_utilization = 0.90;
    const { mkdirSync, writeFileSync } = require('fs');
    const oauthDir = join(tmpDir, 'state', 'oauth');
    mkdirSync(oauthDir, { recursive: true });
    writeFileSync(join(oauthDir, 'accounts.json'), JSON.stringify(store, null, 2));

    const result = await rotateOAuth(tmpDir, frameworkRoot, 'acme', { force: true });
    expect(result.rotated).toBe(false);
    expect(result.reason).toContain('No alternate accounts');
  });
});

describe('alert thresholds', () => {
  it('ALERT_5H is 0.80', () => {
    expect(ALERT_5H).toBe(0.80);
  });
  it('ALERT_7D is 0.70', () => {
    expect(ALERT_7D).toBe(0.70);
  });
});
