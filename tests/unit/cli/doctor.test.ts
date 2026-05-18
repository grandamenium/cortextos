/**
 * `cortextos doctor` — unit tests for the auto-remediation command.
 *
 * Drives `collectDoctorPlan` / `executeDoctorPlan` directly with stubbed
 * StatusReports + injected exec/fs hooks so:
 *   - the test is hermetic (never shells out, never touches the real fleet)
 *   - each check can be exercised in isolation
 *   - dry-run vs --fix is differentiated by whether commands actually ran
 *
 * Coverage:
 *   - Each check's detect() correctly identifies its issue from a synthetic
 *     fixture StatusReport (no false positives, no false negatives).
 *   - Dry-run mode never invokes exec or fs hooks.
 *   - --fix mode for clear-stale-errors actually moves the .errors dir
 *     (verified via real fs in a tmp dir).
 *   - --only / --skip filters work as expected.
 *   - JSON output is well-formed (round-trips through JSON.parse).
 *   - host-field-missing requires --fix-host-fields opt-in.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  collectDoctorPlan,
  executeDoctorPlan,
  ALL_CHECKS,
  doctorCommand,
  renderDoctorPlanText,
  renderDoctorRunText,
  regenEcosystemCheck,
  restartHaltedCheck,
  clearStaleErrorsCheck,
  applyScopePluginsCheck,
  daemonEnvMissingCheck,
  hostFieldMissingCheck,
  manifestDriftCheck,
  crashLoopRecentCheck,
  type CheckContext,
  type DoctorOptions,
  type ExecRunner,
  type DoctorFsHooks,
} from '../../../src/cli/doctor';
import type { StatusReport } from '../../../src/cli/status';

/**
 * Build a baseline StatusReport with no problems — each test mutates the
 * fields relevant to the check it's exercising. Keeps every test small.
 */
function baseReport(): StatusReport {
  return {
    host: {
      hostId: 'test@host',
      hostname: 'host',
      user: 'test',
      instance: 'default',
    },
    daemon: { running: true, pid: 999, uptimeSec: 60, restartCount: 0 },
    agents: [],
    bus: { rows: [] },
    breaker: [],
    hmac: { keyPresent: true, graceActive: false, keyFingerprint: 'abc1234567890def' },
    manifest: { loaded: true, agentCount: 0, driftOnDisk: [] },
    crashes: [],
    generatedAt: '2026-05-18T00:00:00.000Z',
    alerts: [],
  };
}

/**
 * Build a CheckContext for unit-testing a single check's detect/plan/execute
 * in isolation (avoids spinning up the whole collectDoctorPlan plumbing).
 */
function buildCtx(report: StatusReport, overrides: Partial<CheckContext> = {}): CheckContext {
  return {
    report,
    ctxRoot: '/tmp/doctor-test-ctxroot',
    frameworkRoot: '/tmp/doctor-test-fwroot',
    env: {},
    fixHostFields: false,
    now: new Date('2026-05-18T00:00:00.000Z'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Per-check detect() — happy path (no issue) + unhappy path (issue surfaced)
// ---------------------------------------------------------------------------

describe('doctor: per-check detect()', () => {
  let tmpRoot: string;
  let ctxRoot: string;
  let frameworkRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'doctor-detect-'));
    ctxRoot = join(tmpRoot, '.cortextos', 'default');
    frameworkRoot = join(tmpRoot, 'cortextos');
    mkdirSync(ctxRoot, { recursive: true });
    mkdirSync(frameworkRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('regen-ecosystem: clean file with HOME-relative joins -> no issue', () => {
    writeFileSync(
      join(frameworkRoot, 'ecosystem.config.js'),
      [
        'const HOME = process.env.HOME;',
        'module.exports = { apps: [{ name: "x", script: path.join(HOME, "cortextos", "dist", "daemon.js") }] };',
      ].join('\n'),
    );
    const ctx = buildCtx(baseReport(), { frameworkRoot });
    expect(regenEcosystemCheck.detect(ctx)).toBeNull();
  });

  it('regen-ecosystem: hardcoded /Users/.../cortextos path -> issue', () => {
    writeFileSync(
      join(frameworkRoot, 'ecosystem.config.js'),
      'module.exports = { apps: [{ script: "/Users/somebody/cortextos/dist/daemon.js" }] };',
    );
    const ctx = buildCtx(baseReport(), { frameworkRoot });
    const issue = regenEcosystemCheck.detect(ctx);
    expect(issue).not.toBeNull();
    expect(issue!.summary).toContain('hardcoded path');
    expect(issue!.severity).toBe('warn');
  });

  it('regen-ecosystem: missing file -> issue (warn)', () => {
    const ctx = buildCtx(baseReport(), { frameworkRoot });
    const issue = regenEcosystemCheck.detect(ctx);
    expect(issue).not.toBeNull();
    expect(issue!.summary).toContain('missing');
  });

  it('restart-halted: no halted agents -> no issue', () => {
    const r = baseReport();
    r.agents = [
      { name: 'sam', status: 'running', inManifest: true },
      { name: 'forge', status: 'crashed', inManifest: true },
    ];
    expect(restartHaltedCheck.detect(buildCtx(r))).toBeNull();
  });

  it('restart-halted: two halted agents -> issue with both names', () => {
    const r = baseReport();
    r.agents = [
      { name: 'sam', status: 'halted', inManifest: true },
      { name: 'forge', status: 'halted', inManifest: true },
      { name: 'pa', status: 'running', inManifest: true },
    ];
    const issue = restartHaltedCheck.detect(buildCtx(r));
    expect(issue).not.toBeNull();
    expect(issue!.severity).toBe('error');
    expect((issue!.details as { agents: string[] }).agents).toEqual(['sam', 'forge']);
  });

  it('clear-stale-errors: ≤5 errors -> no issue', () => {
    const r = baseReport();
    r.bus.rows = [
      { agent: 'sam', inbox: 0, errors: 5, flagged: false },
      { agent: 'pa', inbox: 0, errors: 3, flagged: false },
    ];
    expect(clearStaleErrorsCheck.detect(buildCtx(r))).toBeNull();
  });

  it('clear-stale-errors: 6 errors -> issue', () => {
    const r = baseReport();
    r.bus.rows = [
      { agent: 'sam', inbox: 0, errors: 6, flagged: true },
      { agent: 'pa', inbox: 0, errors: 12, flagged: true },
      { agent: 'forge', inbox: 0, errors: 0, flagged: false },
    ];
    const issue = clearStaleErrorsCheck.detect(buildCtx(r));
    expect(issue).not.toBeNull();
    expect((issue!.details as { offenders: Array<{ agent: string; count: number }> }).offenders)
      .toEqual([
        { agent: 'sam', count: 6 },
        { agent: 'pa', count: 12 },
      ]);
  });

  it('apply-scope-plugins: settings.json present -> no issue', () => {
    const r = baseReport();
    r.manifest.loaded = true;
    r.agents = [{ name: 'sam', status: 'running', inManifest: true }];
    mkdirSync(join(frameworkRoot, 'orgs', 'subbu-ops', 'agents', 'sam', '.claude'), { recursive: true });
    writeFileSync(
      join(frameworkRoot, 'orgs', 'subbu-ops', 'agents', 'sam', '.claude', 'settings.json'),
      '{"enabledPlugins":{}}',
    );
    expect(applyScopePluginsCheck.detect(buildCtx(r, { frameworkRoot }))).toBeNull();
  });

  it('apply-scope-plugins: settings.json missing -> issue', () => {
    const r = baseReport();
    r.manifest.loaded = true;
    r.agents = [{ name: 'sam', status: 'running', inManifest: true }];
    mkdirSync(join(frameworkRoot, 'orgs', 'subbu-ops', 'agents', 'sam'), { recursive: true });
    const issue = applyScopePluginsCheck.detect(buildCtx(r, { frameworkRoot }));
    expect(issue).not.toBeNull();
    expect((issue!.details as { missing: string[] }).missing).toContain('sam');
  });

  it('apply-scope-plugins: agent not in manifest is ignored (handled by manifest-drift)', () => {
    const r = baseReport();
    r.manifest.loaded = true;
    r.agents = [{ name: 'rogue', status: 'running', inManifest: false }];
    mkdirSync(join(frameworkRoot, 'orgs', 'subbu-ops', 'agents', 'rogue'), { recursive: true });
    expect(applyScopePluginsCheck.detect(buildCtx(r, { frameworkRoot }))).toBeNull();
  });

  it('daemon-env-missing: all 3 vars present -> no issue', () => {
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    writeFileSync(
      join(ctxRoot, 'config', 'daemon.env'),
      [
        'CTX_BUS_AUTH_GRACE_UNTIL=2026-05-18T20:20:49Z',
        'CTX_REQUIRE_EXPLICIT_ENABLE=1',
        'CTX_DEBUG_ALLOW_CRASH_TRIGGER=0',
      ].join('\n'),
    );
    expect(daemonEnvMissingCheck.detect(buildCtx(baseReport(), { ctxRoot }))).toBeNull();
  });

  it('daemon-env-missing: 1 var missing -> issue lists exactly that var', () => {
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    writeFileSync(
      join(ctxRoot, 'config', 'daemon.env'),
      'CTX_BUS_AUTH_GRACE_UNTIL=2026-05-18T20:20:49Z\nCTX_REQUIRE_EXPLICIT_ENABLE=1\n',
    );
    const issue = daemonEnvMissingCheck.detect(buildCtx(baseReport(), { ctxRoot }));
    expect(issue).not.toBeNull();
    expect((issue!.details as { missing: string[] }).missing).toEqual(['CTX_DEBUG_ALLOW_CRASH_TRIGGER']);
  });

  it('daemon-env-missing: file missing entirely -> issue lists all 3', () => {
    const issue = daemonEnvMissingCheck.detect(buildCtx(baseReport(), { ctxRoot }));
    expect(issue).not.toBeNull();
    expect((issue!.details as { missing: string[] }).missing).toEqual([
      'CTX_BUS_AUTH_GRACE_UNTIL',
      'CTX_REQUIRE_EXPLICIT_ENABLE',
      'CTX_DEBUG_ALLOW_CRASH_TRIGGER',
    ]);
  });

  it('host-field-missing: all entries have host -> no issue', () => {
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    writeFileSync(
      join(ctxRoot, 'config', 'enabled-agents.json'),
      JSON.stringify({
        sam: { host: 'a@b', enabled: true },
        pa: { host: 'a@b', enabled: true },
      }),
    );
    expect(hostFieldMissingCheck.detect(buildCtx(baseReport(), { ctxRoot }))).toBeNull();
  });

  it('host-field-missing: one entry lacks host -> issue', () => {
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    writeFileSync(
      join(ctxRoot, 'config', 'enabled-agents.json'),
      JSON.stringify({
        sam: { host: 'a@b', enabled: true },
        pa: { enabled: true },
      }),
    );
    const issue = hostFieldMissingCheck.detect(buildCtx(baseReport(), { ctxRoot }));
    expect(issue).not.toBeNull();
    expect((issue!.details as { missing: string[] }).missing).toEqual(['pa']);
  });

  it('host-field-missing: requires --fix-host-fields to be auto-fixable', () => {
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    writeFileSync(
      join(ctxRoot, 'config', 'enabled-agents.json'),
      JSON.stringify({ pa: { enabled: true } }),
    );
    const ctx = buildCtx(baseReport(), { ctxRoot, fixHostFields: false });
    const issue = hostFieldMissingCheck.detect(ctx)!;
    const planned = hostFieldMissingCheck.plan(issue, ctx);
    expect(planned.autoFixable).toBe(false);
    expect(planned.commands).toEqual([]);

    const ctxOptIn = buildCtx(baseReport(), { ctxRoot, fixHostFields: true });
    const plannedOptIn = hostFieldMissingCheck.plan(issue, ctxOptIn);
    expect(plannedOptIn.autoFixable).toBe(true);
    expect(plannedOptIn.commands.length).toBe(1);
  });

  it('manifest-drift: empty drift -> no issue', () => {
    const r = baseReport();
    r.manifest.driftOnDisk = [];
    expect(manifestDriftCheck.detect(buildCtx(r))).toBeNull();
  });

  it('manifest-drift: drift items -> issue (not auto-fixable)', () => {
    const r = baseReport();
    r.manifest.driftOnDisk = ['claw-research', 'foo'];
    const issue = manifestDriftCheck.detect(buildCtx(r))!;
    expect(issue).not.toBeNull();
    const planned = manifestDriftCheck.plan(issue, buildCtx(r));
    expect(planned.autoFixable).toBe(false);
    expect(planned.commands).toEqual([]);
  });

  it('crash-loop-recent: 0 crashes -> no issue', () => {
    expect(crashLoopRecentCheck.detect(buildCtx(baseReport()))).toBeNull();
  });

  it('crash-loop-recent: 2 crashes in window -> no issue (threshold is 3)', () => {
    const r = baseReport();
    const now = new Date('2026-05-18T00:00:00.000Z');
    r.crashes = [
      { ts: new Date(now.getTime() - 60_000).toISOString() },
      { ts: new Date(now.getTime() - 120_000).toISOString() },
    ];
    expect(crashLoopRecentCheck.detect(buildCtx(r, { now }))).toBeNull();
  });

  it('crash-loop-recent: 3 crashes in window -> issue (not auto-fixable)', () => {
    const r = baseReport();
    const now = new Date('2026-05-18T00:00:00.000Z');
    r.crashes = [
      { ts: new Date(now.getTime() - 60_000).toISOString() },
      { ts: new Date(now.getTime() - 120_000).toISOString() },
      { ts: new Date(now.getTime() - 180_000).toISOString() },
    ];
    const ctx = buildCtx(r, { now });
    const issue = crashLoopRecentCheck.detect(ctx)!;
    expect(issue).not.toBeNull();
    expect(issue.severity).toBe('error');
    const planned = crashLoopRecentCheck.plan(issue, ctx);
    expect(planned.autoFixable).toBe(false);
  });

  it('crash-loop-recent: 3 crashes OUTSIDE the 15-min window -> no issue', () => {
    const r = baseReport();
    const now = new Date('2026-05-18T00:00:00.000Z');
    r.crashes = [
      { ts: new Date(now.getTime() - 20 * 60 * 1000).toISOString() },
      { ts: new Date(now.getTime() - 22 * 60 * 1000).toISOString() },
      { ts: new Date(now.getTime() - 24 * 60 * 1000).toISOString() },
    ];
    expect(crashLoopRecentCheck.detect(buildCtx(r, { now }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Dry-run mode: collectDoctorPlan never executes or writes
// ---------------------------------------------------------------------------

describe('doctor: dry-run does not execute', () => {
  let tmpRoot: string;
  let ctxRoot: string;
  let frameworkRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'doctor-dryrun-'));
    ctxRoot = join(tmpRoot, '.cortextos', 'default');
    frameworkRoot = join(tmpRoot, 'cortextos');
    mkdirSync(ctxRoot, { recursive: true });
    mkdirSync(frameworkRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('does not invoke exec or fs hooks in plan mode', async () => {
    // Force every check to fire something so we'd see writes if collectPlan
    // were calling execute(). Setup: stale ecosystem, halted agent, 6 errors,
    // missing daemon.env, missing settings.json, drift, crash loop.
    writeFileSync(
      join(frameworkRoot, 'ecosystem.config.js'),
      'module.exports = { apps: [{ script: "/Users/somebody/cortextos/foo" }] };',
    );
    mkdirSync(join(frameworkRoot, 'orgs', 'subbu-ops', 'agents', 'sam'), { recursive: true });
    mkdirSync(join(ctxRoot, 'inbox', 'sam', '.errors'), { recursive: true });
    for (let i = 0; i < 7; i++) {
      writeFileSync(join(ctxRoot, 'inbox', 'sam', '.errors', `e-${i}.json`), '{}');
    }

    let execCalls = 0;
    let moveCalls = 0;
    let writeCalls = 0;
    const exec: ExecRunner = () => { execCalls++; return { exitCode: 0, stdout: '', stderr: '' }; };
    const fs: DoctorFsHooks = {
      moveDir: () => { moveCalls++; },
      mkdirp: () => {},
      writeText: () => { writeCalls++; },
    };

    const now = new Date('2026-05-18T00:00:00.000Z');
    const opts: DoctorOptions = {
      instance: 'default',
      ctxRoot,
      frameworkRoot,
      env: {},
      now: () => now,
      exec,
      fs,
      statusProvider: async () => ({
        ...baseReport(),
        agents: [
          { name: 'sam', status: 'halted', inManifest: true },
        ],
        bus: { rows: [{ agent: 'sam', inbox: 0, errors: 7, flagged: true }] },
        manifest: { loaded: true, agentCount: 1, driftOnDisk: ['rogue'] },
        crashes: [
          { ts: new Date(now.getTime() - 60_000).toISOString() },
          { ts: new Date(now.getTime() - 120_000).toISOString() },
          { ts: new Date(now.getTime() - 180_000).toISOString() },
        ],
      }),
    };

    const plan = await collectDoctorPlan(opts);
    // We expect at least: regen-ecosystem, restart-halted, clear-stale-errors,
    // daemon-env-missing, apply-scope-plugins, manifest-drift, crash-loop-recent.
    expect(plan.steps.length).toBeGreaterThanOrEqual(5);
    expect(execCalls).toBe(0);
    expect(moveCalls).toBe(0);
    expect(writeCalls).toBe(0);

    // Snapshot the .errors dir size — collectDoctorPlan must not have touched it.
    const after = existsSync(join(ctxRoot, 'inbox', 'sam', '.errors'));
    expect(after).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// --fix mode: clear-stale-errors actually moves the directory
// ---------------------------------------------------------------------------

describe('doctor --fix: clear-stale-errors moves .errors dir', () => {
  let tmpRoot: string;
  let ctxRoot: string;
  let frameworkRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'doctor-fix-'));
    ctxRoot = join(tmpRoot, '.cortextos', 'default');
    frameworkRoot = join(tmpRoot, 'cortextos');
    mkdirSync(ctxRoot, { recursive: true });
    mkdirSync(frameworkRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('moves the .errors dir to .errors-archived-<ts>', async () => {
    // Real fs — no mocks for this one. Set up a 7-entry .errors dir.
    const errorsDir = join(ctxRoot, 'inbox', 'sam', '.errors');
    mkdirSync(errorsDir, { recursive: true });
    for (let i = 0; i < 7; i++) {
      writeFileSync(join(errorsDir, `e-${i}.json`), '{}');
    }

    const now = new Date('2026-05-18T00:25:00.000Z');
    const run = await executeDoctorPlan({
      instance: 'default',
      ctxRoot,
      frameworkRoot,
      env: {},
      now: () => now,
      only: ['clear-stale-errors'],
      fix: true,
      statusProvider: async () => ({
        ...baseReport(),
        bus: { rows: [{ agent: 'sam', inbox: 0, errors: 7, flagged: true }] },
      }),
    });

    expect(run.steps.length).toBe(1);
    expect(run.steps[0].id).toBe('clear-stale-errors');
    expect(run.steps[0].result.ok).toBe(true);
    expect(run.succeeded).toBe(1);
    expect(run.failed).toBe(0);

    // The original .errors dir should be GONE.
    expect(existsSync(errorsDir)).toBe(false);

    // The archive dir should EXIST with all 7 files.
    const expectedTs = now.toISOString().replace(/[:.]/g, '').slice(0, 15) + 'Z';
    const archiveDir = join(ctxRoot, 'inbox', 'sam', `.errors-archived-${expectedTs}`);
    expect(existsSync(archiveDir)).toBe(true);
    const files = require('fs').readdirSync(archiveDir).filter((f: string) => f.endsWith('.json'));
    expect(files.length).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// --fix mode: daemon-env-missing appends with safe defaults
// ---------------------------------------------------------------------------

describe('doctor --fix: daemon-env-missing appends canonical vars', () => {
  let tmpRoot: string;
  let ctxRoot: string;
  let frameworkRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'doctor-env-'));
    ctxRoot = join(tmpRoot, '.cortextos', 'default');
    frameworkRoot = join(tmpRoot, 'cortextos');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    mkdirSync(frameworkRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('appends missing var without overwriting existing operator content', async () => {
    const envPath = join(ctxRoot, 'config', 'daemon.env');
    writeFileSync(
      envPath,
      '# operator custom\nMY_CUSTOM_VAR=1\nCTX_BUS_AUTH_GRACE_UNTIL=2026-05-18T20:20:49Z\n',
    );

    const run = await executeDoctorPlan({
      instance: 'default',
      ctxRoot,
      frameworkRoot,
      env: {},
      only: ['daemon-env-missing'],
      fix: true,
      statusProvider: async () => baseReport(),
    });

    expect(run.steps.length).toBe(1);
    expect(run.steps[0].result.ok).toBe(true);

    const after = readFileSync(envPath, 'utf-8');
    // Original lines preserved
    expect(after).toContain('MY_CUSTOM_VAR=1');
    expect(after).toContain('CTX_BUS_AUTH_GRACE_UNTIL=2026-05-18T20:20:49Z');
    // Missing vars now present
    expect(after).toContain('CTX_REQUIRE_EXPLICIT_ENABLE=1');
    expect(after).toContain('CTX_DEBUG_ALLOW_CRASH_TRIGGER=0');
  });
});

// ---------------------------------------------------------------------------
// --only / --skip filters
// ---------------------------------------------------------------------------

describe('doctor: --only / --skip filters', () => {
  it('--only filters the plan to a single check', async () => {
    const r = baseReport();
    r.agents = [{ name: 'sam', status: 'halted', inManifest: true }];
    r.bus.rows = [{ agent: 'sam', inbox: 0, errors: 9, flagged: true }];
    r.manifest = { loaded: true, agentCount: 1, driftOnDisk: ['rogue'] };

    const plan = await collectDoctorPlan({
      only: ['restart-halted'],
      statusProvider: async () => r,
      ctxRoot: '/tmp/nope-' + Date.now(),
      frameworkRoot: '/tmp/nope-fw-' + Date.now(),
    });
    expect(plan.steps.map(s => s.id)).toEqual(['restart-halted']);
  });

  it('--skip removes a check from the plan', async () => {
    const r = baseReport();
    r.agents = [{ name: 'sam', status: 'halted', inManifest: true }];
    r.manifest = { loaded: true, agentCount: 1, driftOnDisk: ['rogue'] };

    const plan = await collectDoctorPlan({
      skip: ['restart-halted'],
      statusProvider: async () => r,
      ctxRoot: '/tmp/nope-' + Date.now(),
      frameworkRoot: '/tmp/nope-fw-' + Date.now(),
    });
    expect(plan.steps.map(s => s.id)).not.toContain('restart-halted');
    expect(plan.steps.map(s => s.id)).toContain('manifest-drift');
  });

  it('--only and --skip on the same id excludes it (skip wins)', async () => {
    const r = baseReport();
    r.agents = [{ name: 'sam', status: 'halted', inManifest: true }];

    const plan = await collectDoctorPlan({
      only: ['restart-halted'],
      skip: ['restart-halted'],
      statusProvider: async () => r,
      ctxRoot: '/tmp/nope-' + Date.now(),
      frameworkRoot: '/tmp/nope-fw-' + Date.now(),
    });
    expect(plan.steps).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// JSON output well-formedness
// ---------------------------------------------------------------------------

describe('doctor: JSON output', () => {
  it('plan JSON round-trips through JSON.parse', async () => {
    const r = baseReport();
    r.agents = [{ name: 'sam', status: 'halted', inManifest: true }];
    r.manifest = { loaded: true, agentCount: 1, driftOnDisk: ['rogue'] };

    const plan = await collectDoctorPlan({
      statusProvider: async () => r,
      ctxRoot: '/tmp/nope-' + Date.now(),
      frameworkRoot: '/tmp/nope-fw-' + Date.now(),
    });
    const json = JSON.stringify(plan);
    const reparsed = JSON.parse(json);
    expect(reparsed.steps.length).toBe(plan.steps.length);
    expect(reparsed.host.hostId).toBe(plan.host.hostId);
    expect(reparsed.summary).toBe(plan.summary);
  });

  it('run JSON round-trips and includes succeeded/failed/skipped counters', async () => {
    const r = baseReport();
    r.manifest = { loaded: true, agentCount: 0, driftOnDisk: ['rogue'] };
    const run = await executeDoctorPlan({
      fix: true,
      statusProvider: async () => r,
      ctxRoot: '/tmp/nope-' + Date.now(),
      frameworkRoot: '/tmp/nope-fw-' + Date.now(),
    });
    const json = JSON.stringify(run);
    const reparsed = JSON.parse(json);
    expect(reparsed).toHaveProperty('succeeded');
    expect(reparsed).toHaveProperty('failed');
    expect(reparsed).toHaveProperty('skipped');
    // manifest-drift is surface-only -> skipped
    expect(reparsed.skipped).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe('doctor: rendering', () => {
  it('renderDoctorPlanText shows "No issues found" when plan is empty', async () => {
    // Need real fixture dirs so regen-ecosystem + daemon-env-missing don't
    // false-fire on missing-file conditions. Set up a clean ecosystem.config.js
    // and a complete daemon.env so every check returns null.
    const tmp = mkdtempSync(join(tmpdir(), 'doctor-empty-'));
    try {
      const fr = join(tmp, 'cortextos');
      const cr = join(tmp, '.cortextos', 'default');
      mkdirSync(fr, { recursive: true });
      mkdirSync(join(cr, 'config'), { recursive: true });
      writeFileSync(
        join(fr, 'ecosystem.config.js'),
        'const HOME=process.env.HOME; module.exports={apps:[{script:path.join(HOME,"cortextos","dist","daemon.js")}]};',
      );
      writeFileSync(
        join(cr, 'config', 'daemon.env'),
        'CTX_BUS_AUTH_GRACE_UNTIL=2099-01-01T00:00:00Z\nCTX_REQUIRE_EXPLICIT_ENABLE=1\nCTX_DEBUG_ALLOW_CRASH_TRIGGER=0\n',
      );
      const plan = await collectDoctorPlan({
        statusProvider: async () => baseReport(),
        ctxRoot: cr,
        frameworkRoot: fr,
      });
      const txt = renderDoctorPlanText(plan);
      expect(txt).toContain('cortextos doctor');
      expect(plan.steps).toEqual([]);
      expect(txt).toContain('No issues found');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('renderDoctorRunText shows succeeded/failed/skipped tallies', async () => {
    const r = baseReport();
    r.manifest = { loaded: true, agentCount: 0, driftOnDisk: ['rogue'] };
    const run = await executeDoctorPlan({
      fix: true,
      statusProvider: async () => r,
      ctxRoot: '/tmp/nope-' + Date.now(),
      frameworkRoot: '/tmp/nope-fw-' + Date.now(),
    });
    const txt = renderDoctorRunText(run);
    expect(txt).toContain('cortextos doctor --fix');
    expect(txt).toContain('Result:');
    expect(txt).toMatch(/skipped/);
  });
});

// ---------------------------------------------------------------------------
// Commander wiring smoke test
// ---------------------------------------------------------------------------

describe('doctor: commander wiring', () => {
  it('command name is `doctor`', () => {
    expect(doctorCommand.name()).toBe('doctor');
  });

  it('has --fix, --json, --instance, --only, --skip, --fix-host-fields options', () => {
    const opts = (doctorCommand as unknown as { options: { long: string }[] }).options;
    const longs = opts.map(o => o.long).sort();
    expect(longs).toContain('--fix');
    expect(longs).toContain('--json');
    expect(longs).toContain('--instance');
    expect(longs).toContain('--only');
    expect(longs).toContain('--skip');
    expect(longs).toContain('--fix-host-fields');
  });

  it('ALL_CHECKS includes every documented id', () => {
    const ids = ALL_CHECKS.map(c => c.id).sort();
    expect(ids).toEqual([
      'apply-scope-plugins',
      'clear-stale-errors',
      'crash-loop-recent',
      'daemon-env-missing',
      'host-field-missing',
      'manifest-drift',
      'regen-ecosystem',
      'restart-halted',
    ]);
  });
});
