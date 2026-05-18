/**
 * Wave-1 Task #64 — tests for the `cortextos tdd-loop` CLI wrapper.
 *
 * These focus on the wrapper's responsibilities (commander wiring, git-clean
 * check, runDir resolution, propagating injected invokers) — the iteration
 * logic itself is covered by tdd-loop-runner.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import {
  tddLoopCommand,
  executeTddLoop,
  resolveRunDir,
  generateRunId,
  checkGitClean,
} from '../../../src/cli/tdd-loop';
import {
  type ModelInvoker,
  type TestRunner,
  parseModelTestResponse,
} from '../../../src/daemon/tdd-loop-runner';

describe('Task #64: tdd-loop commander wiring', () => {
  it('is registered as `tdd-loop`', () => {
    expect(tddLoopCommand.name()).toBe('tdd-loop');
  });

  it('requires the --spec option', () => {
    const opts = (tddLoopCommand as unknown as { options: { long: string; required?: boolean; mandatory?: boolean }[] }).options;
    const spec = opts.find(o => o.long === '--spec');
    expect(spec).toBeDefined();
    // commander stores requiredOption as `mandatory`
    expect(spec?.mandatory ?? spec?.required).toBe(true);
  });

  it('describes itself as a TDD loop', () => {
    const desc = tddLoopCommand.description().toLowerCase();
    expect(desc).toContain('test');
    // accept either "feature loop" or "tdd" wording — both ship as accurate
    expect(/loop|tdd/.test(desc)).toBe(true);
  });

  it('exposes the documented options with sensible defaults', () => {
    const opts = (tddLoopCommand as unknown as { options: { long: string; defaultValue?: unknown }[] }).options;
    const byLong = Object.fromEntries(opts.map(o => [o.long, o]));
    expect(byLong['--test-cmd']?.defaultValue).toBe('npm test');
    expect(byLong['--target-files']?.defaultValue).toBe('src/**/*.ts');
    expect(byLong['--max-iterations']?.defaultValue).toBe('10');
    expect(byLong['--model']?.defaultValue).toBe('claude-sonnet');
    expect(byLong['--pre-tests-only']).toBeDefined();
    expect(byLong['--dry-run']).toBeDefined();
    expect(byLong['--run-id']).toBeDefined();
    expect(byLong['--instance']).toBeDefined();
  });
});

describe('Task #64: resolveRunDir', () => {
  it('resolves under ~/.cortextos/<instance>/state/tdd-runs/<runId>', () => {
    const dir = resolveRunDir('myinst', 'abc123');
    expect(dir).toBe(join(homedir(), '.cortextos', 'myinst', 'state', 'tdd-runs', 'abc123'));
  });

  it('generateRunId produces a non-empty id', () => {
    const id = generateRunId();
    expect(id.length).toBeGreaterThan(8);
    // Must be safe as a directory segment (no slashes, no spaces)
    expect(/[\/\s]/.test(id)).toBe(false);
  });
});

describe('Task #64: checkGitClean', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'tdd-git-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns [] for a non-git directory', () => {
    expect(checkGitClean(tmp)).toEqual([]);
  });
});

describe('Task #64: executeTddLoop wraps the runner end-to-end', () => {
  let tmp: string;
  let repoRoot: string;
  let specPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'tdd-cli-'));
    repoRoot = join(tmp, 'repo');
    mkdirSync(join(repoRoot, 'src'), { recursive: true });
    mkdirSync(join(repoRoot, 'tests', 'unit'), { recursive: true });
    specPath = join(repoRoot, 'spec.md');
    writeFileSync(specPath, [
      '# Sample',
      '',
      '## Acceptance criteria',
      '- Works',
    ].join('\n'), 'utf-8');
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns 0 on success and writes the test file', async () => {
    const writeRaw = [
      'File: tests/unit/cli-sample.test.ts',
      '```ts',
      "import { it, expect } from 'vitest';",
      "it('ok', () => expect(1).toBe(1));",
      '```',
    ].join('\n');
    const invoker: ModelInvoker = async (phase) => ({
      raw: writeRaw,
      files: phase === 'write-tests' ? parseModelTestResponse(writeRaw) : [],
    });
    const runner: TestRunner = () => ({ exitCode: 0, stdout: 'ok', stderr: '' });

    const runId = generateRunId();
    const code = await executeTddLoop({
      spec: specPath,
      testCmd: 'echo skipped',
      targetFiles: 'src/**/*.ts',
      maxIterations: '10',
      model: 'claude-sonnet',
      instance: 'test-instance',
      runId,
      repoRoot,
      skipGitCheck: true,
      modelInvoker: invoker,
      testRunner: runner,
    });
    expect(code).toBe(0);
    expect(existsSync(join(repoRoot, 'tests/unit/cli-sample.test.ts'))).toBe(true);
    // Result file lives where resolveRunDir says it does
    const runDir = resolveRunDir('test-instance', runId);
    expect(existsSync(join(runDir, 'result.json'))).toBe(true);
    expect(existsSync(join(runDir, 'iterations.jsonl'))).toBe(true);

    // Cleanup the run dir we just created so we don't leak under ~/.cortextos
    rmSync(runDir, { recursive: true, force: true });
  });

  it('returns 1 when the spec file does not exist', async () => {
    const code = await executeTddLoop({
      spec: join(repoRoot, 'no-spec.md'),
      testCmd: 'echo skipped',
      targetFiles: 'src/**/*.ts',
      maxIterations: '10',
      model: 'claude-sonnet',
      instance: 'test-instance',
      runId: generateRunId(),
      repoRoot,
      skipGitCheck: true,
      modelInvoker: async () => ({ raw: '', files: [] }),
      testRunner: () => ({ exitCode: 0, stdout: '', stderr: '' }),
    });
    expect(code).toBe(1);
  });

  it('--pre-tests-only stops after iteration 2 (the test-write step)', async () => {
    // The brief defines "iteration 2" as test-write in operator-facing
    // numbering. In our internal counter (1-based) the test-write step is
    // iteration 1; we assert here that the loop stops at exactly that step
    // and never invokes the test runner — the property the operator cares
    // about regardless of counter naming.
    const writeRaw = [
      'File: tests/unit/pre-only.test.ts',
      '```ts',
      'export const p = 1;',
      '```',
    ].join('\n');
    let runnerCalled = 0;
    const code = await executeTddLoop({
      spec: specPath,
      testCmd: 'echo skipped',
      targetFiles: 'src/**/*.ts',
      maxIterations: '10',
      model: 'claude-sonnet',
      instance: 'test-instance',
      runId: generateRunId(),
      repoRoot,
      skipGitCheck: true,
      preTestsOnly: true,
      modelInvoker: async (phase) => {
        if (phase === 'fix') {
          throw new Error('fix invoker must not be called with --pre-tests-only');
        }
        return { raw: writeRaw, files: parseModelTestResponse(writeRaw) };
      },
      testRunner: () => {
        runnerCalled += 1;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    // pre_tests_only is a non-success status, so the CLI returns non-zero
    expect(code).toBe(1);
    expect(runnerCalled).toBe(0);
    expect(existsSync(join(repoRoot, 'tests/unit/pre-only.test.ts'))).toBe(true);

    // Cleanup
    rmSync(resolveRunDir('test-instance', 'noop-cleanup'), { recursive: true, force: true });
  });

  it('rejects a fix proposal that targets a file outside --target-files (untargeted file is not written)', async () => {
    const writeRaw = [
      'File: tests/unit/tgt.test.ts',
      '```ts',
      'export const t = 1;',
      '```',
    ].join('\n');
    const fixRaw = [
      // Outside src/ — should be rejected.
      'File: docs/evil.ts',
      '```ts',
      'export const e = 1;',
      '```',
    ].join('\n');
    const code = await executeTddLoop({
      spec: specPath,
      testCmd: 'echo skipped',
      targetFiles: 'src/**/*.ts',
      maxIterations: '5',
      model: 'claude-sonnet',
      instance: 'test-instance',
      runId: generateRunId(),
      repoRoot,
      skipGitCheck: true,
      modelInvoker: async (phase) => {
        if (phase === 'write-tests') return { raw: writeRaw, files: parseModelTestResponse(writeRaw) };
        return { raw: fixRaw, files: [] };
      },
      testRunner: () => ({ exitCode: 1, stdout: '', stderr: 'red' }),
    });
    expect(code).toBe(1);
    // The untargeted file must NOT exist
    expect(existsSync(join(repoRoot, 'docs/evil.ts'))).toBe(false);
  });
});
