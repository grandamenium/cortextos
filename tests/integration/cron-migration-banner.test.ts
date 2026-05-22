/**
 * tests/integration/cron-migration-banner.test.ts
 *
 * Part C of the upgrade-cron-teaching follow-up: assert that
 * `migrateCronsForAgent` emits a one-line advisory when the agent workspace
 * still contains stale CronCreate / /loop / config.json teaching, that the
 * advisory is suppressed after the `.cron-teaching-checked` marker is
 * dropped, and that `force: true` re-runs the scan.
 *
 * The advisory is pure: it never blocks the migration result, never modifies
 * workspace files, and runs once per agent.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  migrateCronsForAgent,
  isTeachingChecked,
} from '../../src/daemon/cron-migration.js';

const CRONS_DIR = '.cortextOS/state/agents';
const TEACHING_MARKER = '.cron-teaching-checked';

let tmpCtxRoot: string;
let tmpAgentDir: string;
const originalCtxRoot = process.env.CTX_ROOT;

beforeEach(() => {
  tmpCtxRoot = mkdtempSync(join(tmpdir(), 'cron-banner-ctx-'));
  tmpAgentDir = mkdtempSync(join(tmpdir(), 'cron-banner-agent-'));
  process.env.CTX_ROOT = tmpCtxRoot;
});

afterEach(() => {
  try {
    rmSync(tmpCtxRoot, { recursive: true, force: true });
  } catch { /* ignore */ }
  try {
    rmSync(tmpAgentDir, { recursive: true, force: true });
  } catch { /* ignore */ }
  if (originalCtxRoot === undefined) delete process.env.CTX_ROOT;
  else process.env.CTX_ROOT = originalCtxRoot;
});

function writeAgentFile(rel: string, body: string): void {
  const fp = join(tmpAgentDir, rel);
  mkdirSync(join(fp, '..'), { recursive: true });
  writeFileSync(fp, body, 'utf-8');
}

function writeConfigJson(crons: unknown[]): string {
  const fp = join(tmpAgentDir, 'config.json');
  writeFileSync(
    fp,
    JSON.stringify({ agent_name: 'banner-test', enabled: true, crons }),
    'utf-8',
  );
  return fp;
}

function captureLog(): { lines: string[]; log: (msg: string) => void } {
  const lines: string[] = [];
  return { lines, log: (msg: string) => { lines.push(msg); } };
}

describe('migrateCronsForAgent — cron-teaching upgrade banner', () => {
  it('emits an advisory when workspace contains stale CronCreate teaching', () => {
    const configPath = writeConfigJson([
      { name: 'heartbeat', interval: '4h', prompt: 'beat' },
    ]);
    writeAgentFile(
      'CLAUDE.md',
      [
        '# agent',
        'Use `CronCreate` to schedule a 4h heartbeat.',
        'Edit config.json to add the cron entry.',
      ].join('\n'),
    );

    const cap = captureLog();
    const result = migrateCronsForAgent('banner-test', configPath, tmpCtxRoot, {
      log: cap.log,
    });

    expect(result.status).toBe('migrated');
    const banner = cap.lines.find((l) =>
      l.includes('cron-teaching upgrade recommended'),
    );
    expect(banner).toBeDefined();
    expect(banner).toContain('cortextos bus upgrade-cron-teaching banner-test');
    expect(banner).toMatch(/\d+ stale references in \d+ files/);
    // The agent name is provided by the caller's logger (e.g. daemon wraps with
    // [<agent>] [migration]). The migration module itself must not duplicate it.
    expect(banner!.startsWith('cron-teaching upgrade recommended')).toBe(true);

    // Marker dropped so the next run is silent.
    expect(isTeachingChecked(tmpCtxRoot, 'banner-test')).toBe(true);
  });

  it('suppresses the advisory after the marker is dropped', () => {
    const configPath = writeConfigJson([
      { name: 'heartbeat', interval: '4h', prompt: 'beat' },
    ]);
    writeAgentFile('CLAUDE.md', '# agent\nUse `CronCreate` for scheduling.\n');

    // First run drops the marker.
    migrateCronsForAgent('banner-test', configPath, tmpCtxRoot, {
      log: () => { /* drop */ },
    });
    expect(isTeachingChecked(tmpCtxRoot, 'banner-test')).toBe(true);

    // Second run should NOT log a banner.
    const cap = captureLog();
    migrateCronsForAgent('banner-test', configPath, tmpCtxRoot, {
      log: cap.log,
    });
    const banner = cap.lines.find((l) =>
      l.includes('cron-teaching upgrade recommended'),
    );
    expect(banner).toBeUndefined();
  });

  it('re-runs the scan when force: true is passed', () => {
    const configPath = writeConfigJson([
      { name: 'heartbeat', interval: '4h', prompt: 'beat' },
    ]);
    writeAgentFile('CLAUDE.md', '# agent\nUse `CronCreate` for scheduling.\n');

    migrateCronsForAgent('banner-test', configPath, tmpCtxRoot, {
      log: () => { /* drop */ },
    });
    expect(
      existsSync(join(tmpCtxRoot, CRONS_DIR, 'banner-test', TEACHING_MARKER)),
    ).toBe(true);

    const cap = captureLog();
    migrateCronsForAgent('banner-test', configPath, tmpCtxRoot, {
      force: true,
      log: cap.log,
    });
    const banner = cap.lines.find((l) =>
      l.includes('cron-teaching upgrade recommended'),
    );
    expect(banner).toBeDefined();
    expect(
      existsSync(join(tmpCtxRoot, CRONS_DIR, 'banner-test', TEACHING_MARKER)),
    ).toBe(true);
  });

  it('drops the marker without logging when no stale references exist', () => {
    const configPath = writeConfigJson([
      { name: 'heartbeat', interval: '4h', prompt: 'beat' },
    ]);
    writeAgentFile(
      'CLAUDE.md',
      '# agent\nAll crons live in `crons.json` (configured via cortextos bus add-cron).\n',
    );

    const cap = captureLog();
    migrateCronsForAgent('banner-test', configPath, tmpCtxRoot, {
      log: cap.log,
    });

    const banner = cap.lines.find((l) =>
      l.includes('cron-teaching upgrade recommended'),
    );
    expect(banner).toBeUndefined();
    expect(isTeachingChecked(tmpCtxRoot, 'banner-test')).toBe(true);
  });

  it('honors per-file sentinel marker — files opted out are skipped', () => {
    const configPath = writeConfigJson([
      { name: 'heartbeat', interval: '4h', prompt: 'beat' },
    ]);
    writeAgentFile(
      'CLAUDE.md',
      [
        '# agent',
        '<!-- /loop is intentionally used for short-lived in-session task queueing -->',
        'Use `/loop 4h` to poll the queue.',
        'CronCreate fallback for one-shot reminders.',
      ].join('\n'),
    );

    const cap = captureLog();
    migrateCronsForAgent('banner-test', configPath, tmpCtxRoot, {
      log: cap.log,
    });

    const banner = cap.lines.find((l) =>
      l.includes('cron-teaching upgrade recommended'),
    );
    expect(banner).toBeUndefined();
    expect(isTeachingChecked(tmpCtxRoot, 'banner-test')).toBe(true);
  });

  it('does not block migration if the workspace dir is gone', () => {
    const configPath = join(tmpAgentDir, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({ agent_name: 'banner-test', enabled: true, crons: [] }),
      'utf-8',
    );

    // Write the config, then nuke the parent dir AFTER reading the path
    // (simulates a workspace removed between config-read and scan).
    rmSync(tmpAgentDir, { recursive: true, force: true });

    const cap = captureLog();
    const result = migrateCronsForAgent(
      'banner-test',
      configPath,
      tmpCtxRoot,
      { log: cap.log },
    );

    // Migration code path returns 'no-config' (file does not exist).
    expect(result.status).toBe('no-config');
    expect(isTeachingChecked(tmpCtxRoot, 'banner-test')).toBe(true);
    const banner = cap.lines.find((l) =>
      l.includes('cron-teaching upgrade recommended'),
    );
    expect(banner).toBeUndefined();
  });

  it('survives a corrupt config.json without throwing through the advisory', () => {
    const configPath = join(tmpAgentDir, 'config.json');
    writeFileSync(configPath, '{ not valid json', 'utf-8');
    writeAgentFile(
      'AGENTS.md',
      'Use `CronCreate` for the heartbeat.\nEdit config.json to register a cron.',
    );

    const cap = captureLog();
    const result = migrateCronsForAgent(
      'banner-test',
      configPath,
      tmpCtxRoot,
      { log: cap.log },
    );

    expect(result.status).toBe('no-crons');
    const banner = cap.lines.find((l) =>
      l.includes('cron-teaching upgrade recommended'),
    );
    expect(banner).toBeDefined();
    expect(banner).toContain('cortextos bus upgrade-cron-teaching banner-test');
  });
});
