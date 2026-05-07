/**
 * Integration tests for scripts/plan-review-gate.sh — focused on the
 * word-boundary fix from task_1777093291910_415.
 *
 * Before the fix, the persona-row verdict check used a substring grep
 * (`grep -iE "FAIL|REJECT|BLOCK"`). It false-positived on prose words like
 * "failure", "blocking", "non-blocking", "unblocking", "rejection". I hit
 * this twice during PR #245 and PR #248 and had to rewrite legitimate
 * prose. The fix uses `grep -w` against an explicit list of verdict words
 * + their common inflections (FAILED/FAILS/REJECTED/REJECTS/BLOCKED/
 * BLOCKS) so verdict tokens still trip the gate but prose stays clear.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { execSync, spawnSync } from 'child_process';

const scriptPath = resolve(__dirname, '../../../scripts/plan-review-gate.sh');

interface RunResult { status: number | null; stdout: string; stderr: string; }

describe('scripts/plan-review-gate.sh — word-boundary fix', () => {
  let workDir: string;
  let plansDir: string;

  function git(args: string) {
    execSync(`git ${args}`, { cwd: workDir, stdio: 'ignore' });
  }

  function writePlan(filename: string, body: string) {
    writeFileSync(join(plansDir, filename), body, 'utf-8');
  }

  function runGate(branch: string): RunResult {
    const result = spawnSync('bash', [scriptPath], {
      cwd: workDir,
      env: {
        ...process.env,
        PLAN_REVIEW_DIR: plansDir,
        PLAN_REVIEW_BRANCH: branch,
      },
      encoding: 'utf-8',
    });
    return {
      status: result.status,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    };
  }

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'plan-review-gate-test-'));
    plansDir = join(workDir, 'plans');
    mkdirSync(plansDir, { recursive: true });
    // Gate calls `git rev-parse --show-toplevel`; need a git repo.
    execSync(`git init -q "${workDir}"`, { stdio: 'ignore' });
    git('config user.email t@t.t');
    git('config user.name t');
    writeFileSync(join(workDir, 'README.md'), 'init');
    git('add README.md');
    git('commit -q -m initial');
  });

  afterEach(() => {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ── True-positives: actual non-PASS verdicts must still BLOCK ──────────────

  it('BLOCKS when Security verdict is FAIL', () => {
    writePlan('feat-x-plan.md', [
      '| Persona | Verdict |',
      '|---|---|',
      '| Security | FAIL |',
      '| DataIntegrity | PASS |',
      '',
      'QUORUM: PASS (8/10)',
    ].join('\n'));
    const r = runGate('feat/x');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Security.*not PASS/);
  });

  it('BLOCKS when Security verdict is REJECTED', () => {
    writePlan('feat-x-plan.md', [
      '| Security | REJECTED |',
      '| DataIntegrity | PASS |',
      'QUORUM: PASS (8/10)',
    ].join('\n'));
    const r = runGate('feat/x');
    expect(r.status).toBe(1);
  });

  it('BLOCKS when DataIntegrity verdict is BLOCK', () => {
    writePlan('feat-x-plan.md', [
      '| Security | PASS |',
      '| DataIntegrity | BLOCK |',
      'QUORUM: PASS (8/10)',
    ].join('\n'));
    const r = runGate('feat/x');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/DataIntegrity.*not PASS/);
  });

  it('BLOCKS when verdict is BLOCKED (past tense)', () => {
    writePlan('feat-x-plan.md', [
      '| Security | BLOCKED |',
      '| DataIntegrity | PASS |',
      'QUORUM: PASS (8/10)',
    ].join('\n'));
    const r = runGate('feat/x');
    expect(r.status).toBe(1);
  });

  it('BLOCKS when verdict is FAILS (third-person)', () => {
    writePlan('feat-x-plan.md', [
      '| Security | FAILS |',
      '| DataIntegrity | PASS |',
      'QUORUM: PASS (8/10)',
    ].join('\n'));
    const r = runGate('feat/x');
    expect(r.status).toBe(1);
  });

  it('BLOCKS case-insensitively (lowercase fail)', () => {
    writePlan('feat-x-plan.md', [
      '| Security | fail |',
      '| DataIntegrity | PASS |',
      'QUORUM: PASS (8/10)',
    ].join('\n'));
    const r = runGate('feat/x');
    expect(r.status).toBe(1);
  });

  // ── False-positives BEFORE the fix: prose words must NOT block ─────────────

  it('PASSES when Security PASS row contains the word "failure" in prose', () => {
    writePlan('feat-x-plan.md', [
      '| Security | PASS | mitigates the failure mode in the writer fault-tolerance path |',
      '| DataIntegrity | PASS | safe |',
      '',
      'QUORUM: PASS (10/10)',
    ].join('\n'));
    const r = runGate('feat/x');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/PASS:/);
  });

  it('PASSES when DataIntegrity PASS row contains the word "non-blocking"', () => {
    writePlan('feat-x-plan.md', [
      '| Security | PASS | safe |',
      '| DataIntegrity | PASS | hook is non-blocking so a slow Telegram cannot wedge the merge |',
      '',
      'QUORUM: PASS (10/10)',
    ].join('\n'));
    const r = runGate('feat/x');
    expect(r.status).toBe(0);
  });

  it('PASSES when verdict notes mention "blocking" prose', () => {
    writePlan('feat-x-plan.md', [
      '| Security | PASS | not blocking on this since auth is unchanged |',
      '| DataIntegrity | PASS |',
      'QUORUM: PASS (8/10)',
    ].join('\n'));
    const r = runGate('feat/x');
    expect(r.status).toBe(0);
  });

  it('PASSES when verdict notes mention "unblocking" prose', () => {
    writePlan('feat-x-plan.md', [
      '| Security | PASS | unblocking the migration path discussed in #200 |',
      '| DataIntegrity | PASS |',
      'QUORUM: PASS (8/10)',
    ].join('\n'));
    const r = runGate('feat/x');
    expect(r.status).toBe(0);
  });

  it('PASSES when verdict notes mention "rejection" prose', () => {
    writePlan('feat-x-plan.md', [
      '| Security | PASS | adds rejection rules at the auth layer |',
      '| DataIntegrity | PASS |',
      'QUORUM: PASS (8/10)',
    ].join('\n'));
    const r = runGate('feat/x');
    expect(r.status).toBe(0);
  });

  // ── Composition: trivial-exempt + full-panel paths still work ──────────────

  it('PASSES on trivial-exempt path (no persona check applied)', () => {
    writePlan('feat-x-plan.md', 'TRIVIAL-TASK-EXEMPT: typo fix in README\n');
    const r = runGate('feat/x');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/PASS \(trivial-task-exempt\)/);
  });

  it('BLOCKS when QUORUM line missing entirely', () => {
    writePlan('feat-x-plan.md', '| Security | PASS |\n| DataIntegrity | PASS |\n');
    const r = runGate('feat/x');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/QUORUM/);
  });
});
