/**
 * tests/integration/cron-engine-field.test.ts — F1-lite engine-field plumbing.
 *
 * The engine field must survive the full config.json → crons.json journey or
 * the daemon can never see it (this is exactly how it became dead metadata
 * the first time). Covers:
 *
 *  1. migrateCronsForAgent preserves engine:"shell" (and absence stays absent)
 *  2. resyncCronsFromConfig ADD path carries engine
 *  3. resyncCronsFromConfig UPDATE path: engine change in config.json is
 *     pulled forward into crons.json and reported as updated
 *  4. resyncCronsFromConfig removal: config.json dropping the field clears it
 *     from crons.json (reverts to default PTY dispatch)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import type { CronDefinition } from '../../src/types/index.js';

let tmpCtxRoot: string;
let tmpFrameworkRoot: string;
const originalCtxRoot = process.env.CTX_ROOT;

let migrateCronsForAgent: typeof import('../../src/daemon/cron-migration.js').migrateCronsForAgent;
let resyncCronsFromConfig: typeof import('../../src/daemon/cron-migration.js').resyncCronsFromConfig;
let readCrons: typeof import('../../src/bus/crons.js').readCrons;

async function reloadModules() {
  vi.resetModules();
  const migModule = await import('../../src/daemon/cron-migration.js');
  migrateCronsForAgent = migModule.migrateCronsForAgent;
  resyncCronsFromConfig = migModule.resyncCronsFromConfig;
  const cronsModule = await import('../../src/bus/crons.js');
  readCrons = cronsModule.readCrons;
}

function writeConfigJson(agentDir: string, crons: unknown[]): void {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, 'config.json'),
    JSON.stringify({ agent_name: 'test', enabled: true, crons }),
    'utf-8',
  );
}

function byName(crons: CronDefinition[], name: string): CronDefinition | undefined {
  return crons.find((c) => c.name === name);
}

beforeEach(async () => {
  tmpCtxRoot = mkdtempSync(join(tmpdir(), 'cron-engine-ctx-'));
  tmpFrameworkRoot = mkdtempSync(join(tmpdir(), 'cron-engine-fw-'));
  process.env.CTX_ROOT = tmpCtxRoot;
  await reloadModules();
});

afterEach(() => {
  vi.resetModules();
  if (originalCtxRoot !== undefined) {
    process.env.CTX_ROOT = originalCtxRoot;
  } else {
    delete process.env.CTX_ROOT;
  }
  try { rmSync(tmpCtxRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(tmpFrameworkRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('engine field — migration', () => {
  it('preserves engine:"shell" through migrateCronsForAgent; absent stays absent', () => {
    const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'alpha');
    writeConfigJson(agentDir, [
      { name: 'uptime', interval: '30m', engine: 'shell', prompt: 'bash check.sh' },
      { name: 'heartbeat', interval: '6h', prompt: 'Read HEARTBEAT.md.' },
    ]);

    const result = migrateCronsForAgent('alpha', join(agentDir, 'config.json'), tmpCtxRoot);
    expect(result.status).toBe('migrated');

    const crons = readCrons('alpha');
    expect(byName(crons, 'uptime')?.engine).toBe('shell');
    expect(byName(crons, 'heartbeat')?.engine).toBeUndefined();
  });
});

describe('engine field — config-state resync', () => {
  it('ADD path: new config cron with engine:"shell" lands in crons.json with the field', () => {
    const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'beta');
    const configPath = join(agentDir, 'config.json');

    writeConfigJson(agentDir, [
      { name: 'breaker', interval: '30m', engine: 'shell', prompt: 'bash breaker.sh' },
    ]);

    const result = resyncCronsFromConfig('beta', configPath, { log: () => {} });
    expect(result.added).toContain('breaker');
    expect(byName(readCrons('beta'), 'breaker')?.engine).toBe('shell');
  });

  it('UPDATE path: engine added in config.json is pulled forward and reported', () => {
    const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'gamma');
    const configPath = join(agentDir, 'config.json');

    // Boot 1: cron without engine
    writeConfigJson(agentDir, [
      { name: 'uptime', interval: '30m', prompt: 'bash check.sh' },
    ]);
    resyncCronsFromConfig('gamma', configPath, { log: () => {} });
    expect(byName(readCrons('gamma'), 'uptime')?.engine).toBeUndefined();

    // Boot 2: operator sets engine:"shell" in config.json
    writeConfigJson(agentDir, [
      { name: 'uptime', interval: '30m', engine: 'shell', prompt: 'bash check.sh' },
    ]);
    const result = resyncCronsFromConfig('gamma', configPath, { log: () => {} });

    expect(result.updated).toContain('uptime');
    expect(byName(readCrons('gamma'), 'uptime')?.engine).toBe('shell');
  });

  it('REMOVAL path: dropping engine from config.json clears it in crons.json', () => {
    const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'delta');
    const configPath = join(agentDir, 'config.json');

    writeConfigJson(agentDir, [
      { name: 'uptime', interval: '30m', engine: 'shell', prompt: 'bash check.sh' },
    ]);
    resyncCronsFromConfig('delta', configPath, { log: () => {} });
    expect(byName(readCrons('delta'), 'uptime')?.engine).toBe('shell');

    // Operator removes the field → revert to default PTY dispatch
    writeConfigJson(agentDir, [
      { name: 'uptime', interval: '30m', prompt: 'bash check.sh' },
    ]);
    const result = resyncCronsFromConfig('delta', configPath, { log: () => {} });

    expect(result.updated).toContain('uptime');
    expect(byName(readCrons('delta'), 'uptime')?.engine).toBeUndefined();
  });

  it('no-change resync does not report engine-stable crons as updated', () => {
    const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'epsilon');
    const configPath = join(agentDir, 'config.json');

    writeConfigJson(agentDir, [
      { name: 'uptime', interval: '30m', engine: 'shell', prompt: 'bash check.sh' },
    ]);
    resyncCronsFromConfig('epsilon', configPath, { log: () => {} });

    // Same config again — nothing changed
    const result = resyncCronsFromConfig('epsilon', configPath, { log: () => {} });
    expect(result.changed).toBe(false);
    expect(result.updated).toHaveLength(0);
  });
});
