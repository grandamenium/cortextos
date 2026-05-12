/**
 * tests/integration/multi-agent-crons-codex.test.ts — codex peer to multi-agent-crons.test.ts.
 *
 * Verifies that the cron-migration + CronScheduler stack is fully runtime-agnostic:
 * agents configured with `runtime: codex-app-server` migrate, register, and fire
 * crons identically to claude agents, without runtime-specific collisions.
 *
 * Smoke matrix coverage:
 *   - Migration produces correct crons.json + marker for codex agents
 *   - Schedulers register the right cron counts
 *   - 24h fast-forward sim fires expected counts (no cross-agent leakage)
 *   - bus.sendMessage round-trip works between codex agents
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { CronDefinition, CronExecutionLogEntry, BusPaths } from '../../src/types/index.js';

const TICK_MS = 30_000;
const ONE_MIN = 60_000;
const ONE_HOUR = 3_600_000;
const SIM_24H = 24 * ONE_HOUR;
const CRONS_DIR = '.cortextOS/state/agents';

interface CodexAgentFixture {
  name: string;
  org: string;
  crons: Array<{ name: string; type?: 'recurring'; interval?: string; cron?: string; prompt: string }>;
}

const CODEX_FIXTURES: CodexAgentFixture[] = [
  {
    name: 'codex-alpha',
    org: 'lifeos',
    crons: [
      { name: 'heartbeat', type: 'recurring', interval: '6h', prompt: 'Run heartbeat.' },
      { name: 'hourly-sweep', type: 'recurring', interval: '1h', prompt: 'Sweep tasks.' },
    ],
  },
  {
    name: 'codex-beta',
    org: 'lifeos',
    crons: [
      { name: 'heartbeat', type: 'recurring', interval: '4h', prompt: 'Run heartbeat.' },
      { name: 'half-hour', type: 'recurring', interval: '30m', prompt: 'Half-hourly check.' },
    ],
  },
  {
    name: 'codex-gamma',
    org: 'testorg',
    crons: [
      { name: 'heartbeat', type: 'recurring', interval: '12h', prompt: 'Run heartbeat.' },
    ],
  },
];

let tmpCtxRoot: string;
let tmpFrameworkRoot: string;
const originalCtxRoot = process.env.CTX_ROOT;

let migrateCronsForAgent: typeof import('../../src/daemon/cron-migration.js').migrateCronsForAgent;
let CronScheduler: typeof import('../../src/daemon/cron-scheduler.js').CronScheduler;
let readCrons: typeof import('../../src/bus/crons.js').readCrons;
let sendMessage: typeof import('../../src/bus/message.js').sendMessage;
let checkInbox: typeof import('../../src/bus/message.js').checkInbox;

async function reloadModules() {
  vi.resetModules();
  const mig = await import('../../src/daemon/cron-migration.js');
  migrateCronsForAgent = mig.migrateCronsForAgent;
  const sch = await import('../../src/daemon/cron-scheduler.js');
  CronScheduler = sch.CronScheduler;
  const crons = await import('../../src/bus/crons.js');
  readCrons = crons.readCrons;
  const msg = await import('../../src/bus/message.js');
  sendMessage = msg.sendMessage;
  checkInbox = msg.checkInbox;
}

beforeEach(async () => {
  tmpCtxRoot = mkdtempSync(join(tmpdir(), 'codex-crons-ctx-'));
  tmpFrameworkRoot = mkdtempSync(join(tmpdir(), 'codex-crons-fw-'));
  process.env.CTX_ROOT = tmpCtxRoot;
  vi.useFakeTimers();
  await reloadModules();
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  if (originalCtxRoot !== undefined) process.env.CTX_ROOT = originalCtxRoot;
  else delete process.env.CTX_ROOT;
  try { rmSync(tmpCtxRoot, { recursive: true, force: true }); } catch { /* ok */ }
  try { rmSync(tmpFrameworkRoot, { recursive: true, force: true }); } catch { /* ok */ }
});

function writeAgentConfig(fixture: CodexAgentFixture): string {
  const agentDir = join(tmpFrameworkRoot, 'orgs', fixture.org, 'agents', fixture.name);
  mkdirSync(agentDir, { recursive: true });
  const configPath = join(agentDir, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      agent_name: fixture.name,
      runtime: 'codex-app-server',
      model: 'gpt-5-codex',
      enabled: true,
      crons: fixture.crons,
    }),
    'utf-8',
  );
  return configPath;
}

function buildBusPaths(agentName: string): BusPaths {
  return {
    ctxRoot: tmpCtxRoot,
    inbox: join(tmpCtxRoot, 'inbox', agentName),
    inflight: join(tmpCtxRoot, 'inflight', agentName),
    processed: join(tmpCtxRoot, 'processed', agentName),
    logDir: join(tmpCtxRoot, 'logs', agentName),
    stateDir: join(tmpCtxRoot, '.cortextOS', 'state', 'agents', agentName),
    taskDir: join(tmpCtxRoot, 'tasks'),
    approvalDir: join(tmpCtxRoot, 'approvals'),
    analyticsDir: join(tmpCtxRoot, 'analytics'),
    deliverablesDir: join(tmpCtxRoot, 'orgs', 'lifeos', 'deliverables'),
  };
}

async function advanceSim(totalMs: number, stepMs = ONE_MIN) {
  const steps = Math.ceil(totalMs / stepMs);
  for (let i = 0; i < steps; i += 1) {
    await vi.advanceTimersByTimeAsync(Math.min(stepMs, totalMs - i * stepMs));
  }
}

describe('codex multi-agent crons — migration + scheduling parity', () => {
  it('migrates all codex agents identically to claude agents', () => {
    for (const fix of CODEX_FIXTURES) writeAgentConfig(fix);

    const results = CODEX_FIXTURES.map((f) =>
      migrateCronsForAgent(
        f.name,
        join(tmpFrameworkRoot, 'orgs', f.org, 'agents', f.name, 'config.json'),
        tmpCtxRoot,
        { log: () => {} },
      ),
    );

    for (const r of results) {
      expect(r.status, `${r.agentName} migrated`).toBe('migrated');
      expect(r.cronsSkipped, `${r.agentName} no skipped`).toHaveLength(0);
    }
    expect(results[0].cronsMigrated).toBe(2);
    expect(results[1].cronsMigrated).toBe(2);
    expect(results[2].cronsMigrated).toBe(1);

    for (const fix of CODEX_FIXTURES) {
      const cronsPath = join(tmpCtxRoot, CRONS_DIR, fix.name, 'crons.json');
      expect(existsSync(cronsPath), `${fix.name} crons.json exists`).toBe(true);
      const persisted = readCrons(fix.name);
      const expectedNames = new Set(fix.crons.map((c) => c.name));
      for (const c of persisted) {
        expect(expectedNames.has(c.name), `${fix.name}: ${c.name} owned by this agent`).toBe(true);
      }
    }
  });

  it('schedulers register the right cron counts for each codex agent', () => {
    for (const fix of CODEX_FIXTURES) {
      const configPath = writeAgentConfig(fix);
      migrateCronsForAgent(fix.name, configPath, tmpCtxRoot, { log: () => {} });
    }

    const fires: Array<{ agent: string; cron: string }> = [];
    const schedulers = CODEX_FIXTURES.map(
      (fix) =>
        new CronScheduler({
          agentName: fix.name,
          onFire: (cron: CronDefinition) => fires.push({ agent: fix.name, cron: cron.name }),
          logger: () => {},
        }),
    );
    for (const s of schedulers) s.start();
    expect(schedulers[0].getNextFireTimes()).toHaveLength(2);
    expect(schedulers[1].getNextFireTimes()).toHaveLength(2);
    expect(schedulers[2].getNextFireTimes()).toHaveLength(1);
    for (const s of schedulers) s.stop();
  });

  it('24h fast-forward fires correct counts and isolates per-agent state', async () => {
    for (const fix of CODEX_FIXTURES) {
      const configPath = writeAgentConfig(fix);
      migrateCronsForAgent(fix.name, configPath, tmpCtxRoot, { log: () => {} });
    }

    const fires: Array<{ agent: string; cron: string; ts: number }> = [];
    const schedulers = CODEX_FIXTURES.map(
      (fix) =>
        new CronScheduler({
          agentName: fix.name,
          onFire: (cron: CronDefinition) => fires.push({ agent: fix.name, cron: cron.name, ts: Date.now() }),
          logger: () => {},
        }),
    );
    for (const s of schedulers) s.start();
    await advanceSim(SIM_24H);
    for (const s of schedulers) s.stop();

    const countOf = (agent: string, cron: string) =>
      fires.filter((f) => f.agent === agent && f.cron === cron).length;

    // 24h interval-based fires (±1 tolerance for drift)
    expect(countOf('codex-alpha', 'heartbeat')).toBeGreaterThanOrEqual(3);
    expect(countOf('codex-alpha', 'heartbeat')).toBeLessThanOrEqual(5);
    expect(countOf('codex-alpha', 'hourly-sweep')).toBeGreaterThanOrEqual(23);
    expect(countOf('codex-alpha', 'hourly-sweep')).toBeLessThanOrEqual(25);
    expect(countOf('codex-beta', 'heartbeat')).toBeGreaterThanOrEqual(5);
    expect(countOf('codex-beta', 'heartbeat')).toBeLessThanOrEqual(7);
    expect(countOf('codex-beta', 'half-hour')).toBeGreaterThanOrEqual(47);
    expect(countOf('codex-beta', 'half-hour')).toBeLessThanOrEqual(49);
    expect(countOf('codex-gamma', 'heartbeat')).toBeGreaterThanOrEqual(1);
    expect(countOf('codex-gamma', 'heartbeat')).toBeLessThanOrEqual(3);

    // No cross-agent leakage: every fire's agent matches its cron's owning fixture
    const ownersByCron = new Map<string, Set<string>>();
    for (const fix of CODEX_FIXTURES) {
      for (const c of fix.crons) {
        const set = ownersByCron.get(c.name) ?? new Set<string>();
        set.add(fix.name);
        ownersByCron.set(c.name, set);
      }
    }
    for (const fire of fires) {
      const owners = ownersByCron.get(fire.cron);
      expect(owners?.has(fire.agent), `${fire.cron} fire from ${fire.agent} should belong to it`).toBe(true);
    }
  }, 30_000);

  it('bus message round-trip works across codex agents', () => {
    const alpha = buildBusPaths('codex-alpha');
    const beta = buildBusPaths('codex-beta');

    sendMessage(alpha, 'codex-alpha', 'codex-beta', 'high', 'cron-fire delivered');
    const inbox = checkInbox(beta);
    expect(inbox.length).toBe(1);
    expect(inbox[0].from).toBe('codex-alpha');
    expect(inbox[0].to).toBe('codex-beta');
    expect(inbox[0].priority).toBe('high');
    expect(inbox[0].text).toBe('cron-fire delivered');
  });

  it('config.json runtime field is preserved after migration (does not mutate config)', () => {
    const fix = CODEX_FIXTURES[0];
    const configPath = writeAgentConfig(fix);
    migrateCronsForAgent(fix.name, configPath, tmpCtxRoot, { log: () => {} });
    const reread = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(reread.runtime).toBe('codex-app-server');
    expect(reread.model).toBe('gpt-5-codex');
    expect(Array.isArray(reread.crons)).toBe(true);
  });

  it('execution log is per-agent (no cross-contamination on fire)', async () => {
    for (const fix of CODEX_FIXTURES) {
      const configPath = writeAgentConfig(fix);
      migrateCronsForAgent(fix.name, configPath, tmpCtxRoot, { log: () => {} });
    }
    const schedulers = CODEX_FIXTURES.map(
      (fix) =>
        new CronScheduler({
          agentName: fix.name,
          onFire: (_cron: CronDefinition) => {},
          logger: () => {},
        }),
    );
    for (const s of schedulers) s.start();
    await advanceSim(2 * ONE_HOUR);
    for (const s of schedulers) s.stop();

    for (const fix of CODEX_FIXTURES) {
      const logPath = join(tmpCtxRoot, '.cortextOS', 'state', 'agents', fix.name, 'cron-execution.log');
      if (!existsSync(logPath)) continue;
      const entries = readFileSync(logPath, 'utf-8')
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as CronExecutionLogEntry);
      const ownNames = new Set(fix.crons.map((c) => c.name));
      for (const entry of entries) {
        expect(ownNames.has(entry.cron), `${fix.name} log only contains own crons`).toBe(true);
      }
    }
  }, 15_000);
});
