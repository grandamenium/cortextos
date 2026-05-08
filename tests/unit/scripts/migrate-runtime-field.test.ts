/**
 * PR 10: scripts/migrate-runtime-field.ts must be idempotent and must
 * preserve all existing config fields when injecting `runtime: claude-code`.
 * If this script overwrote, dropped, or reordered fields incorrectly across
 * 17 live agent configs, recovery would be a per-agent restore. Idempotency
 * also matters because James will run the dry-run, then the real run; we
 * never want a second real run to introduce drift.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runMigration, injectRuntimeField } from '../../../scripts/migrate-runtime-field';

describe('migrate-runtime-field', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mig-runtime-'));
    mkdirSync(join(root, 'orgs', 'lifeos', 'agents'), { recursive: true });
    mkdirSync(join(root, 'orgs', 'cointally', 'agents'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function seed(org: string, agent: string, cfg: Record<string, unknown>) {
    const dir = join(root, 'orgs', org, 'agents', agent);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
    return join(dir, 'config.json');
  }

  it('adds runtime: claude-code to configs missing the field', () => {
    const path = seed('lifeos', 'donna', {
      agent_name: 'donna',
      enabled: true,
      startup_delay: 0,
      crons: [],
    });

    const { summary } = runMigration({ root, dryRun: false });
    expect(summary.willChange).toBe(1);

    const cfg = JSON.parse(readFileSync(path, 'utf-8'));
    expect(cfg.runtime).toBe('claude-code');
    expect(cfg.agent_name).toBe('donna');
    expect(cfg.enabled).toBe(true);
    expect(cfg.crons).toEqual([]);
  });

  it('is idempotent — second run is a no-op', () => {
    const path = seed('lifeos', 'donna', { agent_name: 'donna', enabled: true });

    const first = runMigration({ root, dryRun: false });
    expect(first.summary.willChange).toBe(1);
    const afterFirst = readFileSync(path, 'utf-8');

    const second = runMigration({ root, dryRun: false });
    expect(second.summary.willChange).toBe(0);
    expect(second.summary.alreadySet).toBe(1);
    const afterSecond = readFileSync(path, 'utf-8');

    expect(afterSecond).toBe(afterFirst);
  });

  it('skips configs that already have a runtime set (claude-code, hermes, codex-app-server)', () => {
    seed('lifeos', 'claude-test', { agent_name: 'claude-test', enabled: true, runtime: 'claude-code' });
    seed('lifeos', 'codex-app', { agent_name: 'codex-app', enabled: true, runtime: 'codex-app-server' });
    seed('lifeos', 'hermes-bot', { agent_name: 'hermes-bot', enabled: true, runtime: 'hermes' });

    const { results, summary } = runMigration({ root, dryRun: false });
    expect(summary.willChange).toBe(0);
    expect(summary.alreadySet).toBe(3);

    // None of the existing runtime values are overwritten.
    const codexResult = results.find(r => r.agent === 'codex-app');
    expect(codexResult?.before).toBe('codex-app-server');
  });

  it('dry-run does not write anything to disk', () => {
    const path = seed('lifeos', 'donna', { agent_name: 'donna', enabled: true });
    const before = readFileSync(path, 'utf-8');

    const { summary } = runMigration({ root, dryRun: true });
    expect(summary.willChange).toBe(1);

    const after = readFileSync(path, 'utf-8');
    expect(after).toBe(before);
  });

  it('positions runtime right after enabled for visual parity with agent-codex template', () => {
    const cfg = {
      agent_name: 'donna',
      enabled: true,
      startup_delay: 0,
      crons: [],
    };
    const next = injectRuntimeField(cfg as Record<string, unknown>);
    const keys = Object.keys(next);

    const enabledIdx = keys.indexOf('enabled');
    const runtimeIdx = keys.indexOf('runtime');
    expect(runtimeIdx).toBe(enabledIdx + 1);
    // Original keys still present in original relative order
    expect(keys.indexOf('agent_name')).toBeLessThan(enabledIdx);
    expect(keys.indexOf('startup_delay')).toBeGreaterThan(runtimeIdx);
    expect(keys.indexOf('crons')).toBeGreaterThan(runtimeIdx);
  });

  it('walks every org and every agent under orgs/*/agents/*', () => {
    seed('lifeos', 'donna', { agent_name: 'donna', enabled: true });
    seed('lifeos', 'paul', { agent_name: 'paul', enabled: true });
    seed('cointally', 'tallybot', { agent_name: 'tallybot', enabled: true });

    const { summary } = runMigration({ root, dryRun: true });
    expect(summary.total).toBe(3);
    expect(summary.willChange).toBe(3);
  });
});
