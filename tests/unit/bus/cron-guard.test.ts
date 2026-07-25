/**
 * tests/unit/bus/cron-guard.test.ts
 *
 * Tests for the cron-guard changes (Jul-2026 outage prevention):
 *   1. Auto-restore: readCronsWithStatus detects .paused-* / .disabled-* backup
 *      files when crons.json is missing and restores from them automatically.
 *   2. pauseAgentCrons: in-file enabled:false (no rename), writes pause-lock.
 *   3. resumeAgentCrons: sets enabled:true, removes pause-lock.
 *   4. Quota guard: at most one agent paused at a time.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const AGENTS_DIR = '.cortextOS/state/agents';

let tmpRoot: string;
const originalCtxRoot = process.env.CTX_ROOT;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cron-guard-test-'));
  process.env.CTX_ROOT = tmpRoot;
  vi.resetModules();
});

afterEach(() => {
  if (originalCtxRoot !== undefined) {
    process.env.CTX_ROOT = originalCtxRoot;
  } else {
    delete process.env.CTX_ROOT;
  }
  try { rmSync(tmpRoot, { recursive: true }); } catch { /* ignore */ }
});

async function importCrons() {
  return import('../../../src/bus/crons.js');
}

function agentDir(agentName: string): string {
  return join(tmpRoot, AGENTS_DIR, agentName);
}

function cronsJson(agentName: string): string {
  return join(agentDir(agentName), 'crons.json');
}

function makeValidCronsJson(crons: object[] = []): string {
  return JSON.stringify({ updated_at: new Date().toISOString(), crons });
}

const SAMPLE_CRON = {
  name: 'heartbeat',
  type: 'recurring',
  interval: '1h',
  schedule: '1h',
  prompt: 'Check inbox.',
  enabled: true,
};

// ---------------------------------------------------------------------------
// 1. Auto-restore from .paused-* backup
// ---------------------------------------------------------------------------

describe('readCronsWithStatus — auto-restore from suspended backup', () => {
  it('restores crons.json from .paused-YYYY-MM-DD when primary is missing', async () => {
    const dir = agentDir('myagent');
    mkdirSync(dir, { recursive: true });

    const backupPath = join(dir, 'crons.json.paused-2026-07-24');
    writeFileSync(backupPath, makeValidCronsJson([SAMPLE_CRON]));
    // crons.json does NOT exist

    const { readCronsWithStatus } = await importCrons();
    const result = readCronsWithStatus('myagent');

    expect(result.corrupt).toBe(false);
    expect(result.crons).toHaveLength(1);
    expect(result.crons[0].name).toBe('heartbeat');
    // primary file should now exist (restored)
    expect(existsSync(cronsJson('myagent'))).toBe(true);
    // backup preserved
    expect(existsSync(backupPath)).toBe(true);
  });

  it('restores from .disabled-for-* backup when primary is missing', async () => {
    const dir = agentDir('polly');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'crons.json.disabled-for-routine-test'),
      makeValidCronsJson([{ ...SAMPLE_CRON, name: 'polly-cron' }]),
    );

    const { readCronsWithStatus } = await importCrons();
    const result = readCronsWithStatus('polly');

    expect(result.corrupt).toBe(false);
    expect(result.crons[0].name).toBe('polly-cron');
    expect(existsSync(cronsJson('polly'))).toBe(true);
  });

  it('picks the most recent backup when multiple .paused-* files exist', async () => {
    const dir = agentDir('atlas');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'crons.json.paused-2026-07-23'),
      makeValidCronsJson([{ ...SAMPLE_CRON, name: 'old-cron' }]),
    );
    writeFileSync(
      join(dir, 'crons.json.paused-2026-07-25'),
      makeValidCronsJson([{ ...SAMPLE_CRON, name: 'new-cron' }]),
    );

    const { readCronsWithStatus } = await importCrons();
    const result = readCronsWithStatus('atlas');

    // -07-25 is written second so it has a newer mtime — mtime sort picks it first.
    expect(result.crons[0].name).toBe('new-cron');
  });

  it('returns empty (not corrupt) when no backup exists — normal empty state', async () => {
    mkdirSync(agentDir('fresh'), { recursive: true });

    const { readCronsWithStatus } = await importCrons();
    const result = readCronsWithStatus('fresh');

    expect(result.corrupt).toBe(false);
    expect(result.crons).toHaveLength(0);
    expect(existsSync(cronsJson('fresh'))).toBe(false);
  });

  it('fails loud (corrupt:true) when backup exists but fails to parse', async () => {
    const dir = agentDir('broken');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'crons.json.paused-2026-07-25'), 'NOT JSON {{{');

    const { readCronsWithStatus } = await importCrons();
    const result = readCronsWithStatus('broken');

    expect(existsSync(cronsJson('broken'))).toBe(false);
    expect(result.crons).toHaveLength(0);
    // Backup exists but is invalid → fail loud (corrupt:true), not silent empty
    expect(result.corrupt).toBe(true);
  });

  it('fails loud (corrupt:true) when backup parses but has 0 crons — empty backup is not enough', async () => {
    // An empty-crons backup could be a partial write or a stale backup from
    // before any crons were registered. Content validation must require non-empty.
    const dir = agentDir('empty-backup');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'crons.json.paused-2026-07-25'),
      makeValidCronsJson([]), // parseable but 0 crons
    );

    const { readCronsWithStatus } = await importCrons();
    const result = readCronsWithStatus('empty-backup');

    expect(existsSync(cronsJson('empty-backup'))).toBe(false);
    expect(result.crons).toHaveLength(0);
    expect(result.corrupt).toBe(true); // fail loud — a filename is not proof of correct content
  });

  it('skips empty/corrupt backups and restores from the next valid one', async () => {
    const dir = agentDir('mixed');
    mkdirSync(dir, { recursive: true });
    // Written first (older mtime): valid with crons.
    writeFileSync(
      join(dir, 'crons.json.paused-2026-07-24'),
      makeValidCronsJson([{ ...SAMPLE_CRON, name: 'older-cron' }]),
    );
    // Written second (newer mtime): parseable but empty — should be skipped.
    writeFileSync(join(dir, 'crons.json.paused-2026-07-25'), makeValidCronsJson([]));

    const { readCronsWithStatus } = await importCrons();
    const result = readCronsWithStatus('mixed');

    // Should skip the empty newest and restore from the older valid one
    expect(result.corrupt).toBe(false);
    expect(result.crons[0].name).toBe('older-cron');
    expect(existsSync(cronsJson('mixed'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. pauseAgentCrons
// ---------------------------------------------------------------------------

describe('pauseAgentCrons', () => {
  it('sets enabled:false on all crons and writes pause-lock', async () => {
    const { writeCrons, pauseAgentCrons } = await importCrons();
    writeCrons('target', [SAMPLE_CRON, { ...SAMPLE_CRON, name: 'report', enabled: true }]);

    const { paused } = pauseAgentCrons('target', { reason: 'routine migration test', pausedBy: 'forge' });
    expect(paused).toBe(2);

    // All crons should be disabled
    const raw = JSON.parse(readFileSync(cronsJson('target'), 'utf-8'));
    expect(raw.crons.every((c: { enabled: boolean }) => c.enabled === false)).toBe(true);

    // Pause-lock should exist
    const lockPath = join(agentDir('target'), 'crons-paused.json');
    expect(existsSync(lockPath)).toBe(true);
    const lock = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(lock.agent).toBe('target');
    expect(lock.reason).toBe('routine migration test');
    expect(lock.paused_by).toBe('forge');
    expect(lock.cron_count).toBe(2);
  });

  it('does not count already-disabled crons', async () => {
    const { writeCrons, pauseAgentCrons } = await importCrons();
    writeCrons('target', [
      { ...SAMPLE_CRON, enabled: false },
      { ...SAMPLE_CRON, name: 'active', enabled: true },
    ]);

    const { paused } = pauseAgentCrons('target', { reason: 'test' });
    expect(paused).toBe(1); // only the active one was paused
  });

  it('is idempotent — pausing an already-paused agent does not throw', async () => {
    const { writeCrons, pauseAgentCrons } = await importCrons();
    writeCrons('target', [SAMPLE_CRON]);

    pauseAgentCrons('target', { reason: 'first pause' });
    expect(() => pauseAgentCrons('target', { reason: 'second pause' })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. resumeAgentCrons
// ---------------------------------------------------------------------------

describe('resumeAgentCrons', () => {
  it('sets enabled:true on paused crons and removes the lock', async () => {
    const { writeCrons, pauseAgentCrons, resumeAgentCrons } = await importCrons();
    writeCrons('target', [SAMPLE_CRON]);
    pauseAgentCrons('target', { reason: 'test' });

    const { resumed } = resumeAgentCrons('target');
    expect(resumed).toBe(1);

    const raw = JSON.parse(readFileSync(cronsJson('target'), 'utf-8'));
    expect(raw.crons[0].enabled).toBe(true);

    const lockPath = join(agentDir('target'), 'crons-paused.json');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('is idempotent on an agent that was never paused', async () => {
    const { writeCrons, resumeAgentCrons } = await importCrons();
    writeCrons('fresh', [SAMPLE_CRON]);

    const { resumed } = resumeAgentCrons('fresh');
    expect(resumed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Quota guard — at most one agent paused at a time
// ---------------------------------------------------------------------------

describe('pauseAgentCrons — quota guard', () => {
  it('throws if another agent is already paused', async () => {
    const { writeCrons, pauseAgentCrons } = await importCrons();
    writeCrons('agent-a', [SAMPLE_CRON]);
    writeCrons('agent-b', [SAMPLE_CRON]);

    pauseAgentCrons('agent-a', { reason: 'first' });

    expect(() => pauseAgentCrons('agent-b', { reason: 'second' })).toThrow(
      /quota exceeded.*agent-a/i,
    );
  });

  it('allows pausing after the first agent is resumed', async () => {
    const { writeCrons, pauseAgentCrons, resumeAgentCrons } = await importCrons();
    writeCrons('agent-a', [SAMPLE_CRON]);
    writeCrons('agent-b', [SAMPLE_CRON]);

    pauseAgentCrons('agent-a', { reason: 'first' });
    resumeAgentCrons('agent-a');

    expect(() => pauseAgentCrons('agent-b', { reason: 'second' })).not.toThrow();
  });

  it('allows re-pausing the same agent (idempotent quota check)', async () => {
    const { writeCrons, pauseAgentCrons } = await importCrons();
    writeCrons('agent-a', [SAMPLE_CRON]);

    pauseAgentCrons('agent-a', { reason: 'first' });
    expect(() => pauseAgentCrons('agent-a', { reason: 'second' })).not.toThrow();
  });
});
