/**
 * Wave-1 Task #64 — tests for the pure TDD loop driver.
 *
 * We exercise the driver with synthetic model invokers + test runners so
 * iteration logic is verifiable without spending API quota or forking
 * processes. Each test is one acceptance criterion from the task brief.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  parseSpec,
  parseModelTestResponse,
  parseModelFixResponse,
  compileGlob,
  isPathTargetable,
  logIteration,
  readIterationLog,
  runTddLoop,
  type ModelInvoker,
  type ModelInvocationResult,
  type TestRunner,
  type TestRunResult,
  type RunResult,
} from '../../../src/daemon/tdd-loop-runner';

// ---------------------------------------------------------------------------
// Spec parsing
// ---------------------------------------------------------------------------

describe('Task #64: parseSpec', () => {
  it('extracts title, description, and acceptance criteria from a plain markdown spec', () => {
    const md = [
      '# Add a JSON Stringify Helper',
      '',
      'We want a helper that converts a value to a stable, sorted-keys JSON string.',
      '',
      '## Acceptance criteria',
      '- Returns sorted keys for objects',
      '- Handles nested objects',
      '* Returns the literal `null` string for null input',
    ].join('\n');
    const parsed = parseSpec(md);
    expect(parsed.title).toBe('Add a JSON Stringify Helper');
    expect(parsed.description).toContain('stable, sorted-keys JSON string');
    expect(parsed.acceptanceCriteria).toEqual([
      'Returns sorted keys for objects',
      'Handles nested objects',
      'Returns the literal `null` string for null input',
    ]);
    expect(parsed.frontmatter).toEqual({});
  });

  it('parses YAML-style frontmatter when present and prefers it for the title', () => {
    const md = [
      '---',
      'title: "Spec from frontmatter"',
      'owner: hari',
      '---',
      '# this is ignored as title because frontmatter wins',
      '',
      'Description body here.',
      '',
      '## Acceptance Criteria',  // note: mixed case heading
      '1. Numbered bullet should work',
    ].join('\n');
    const parsed = parseSpec(md);
    expect(parsed.title).toBe('Spec from frontmatter');
    expect(parsed.frontmatter.owner).toBe('hari');
    expect(parsed.acceptanceCriteria).toEqual(['Numbered bullet should work']);
  });

  it('throws if no acceptance criteria section is present', () => {
    const md = '# Feature with no AC\n\nDescription only.';
    expect(() => parseSpec(md)).toThrow(/acceptance criteria/i);
  });
});

// ---------------------------------------------------------------------------
// Model response parsing
// ---------------------------------------------------------------------------

describe('Task #64: parseModelTestResponse / parseModelFixResponse', () => {
  it('parses File: header + fenced ts block', () => {
    const raw = [
      'File: tests/unit/foo/bar.test.ts',
      '```ts',
      "import { describe, it, expect } from 'vitest';",
      "describe('bar', () => { it('works', () => expect(true).toBe(true)); });",
      '```',
    ].join('\n');
    const files = parseModelTestResponse(raw);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('tests/unit/foo/bar.test.ts');
    expect(files[0].content).toContain('describe(');
  });

  it('parses ```ts path=... attribute syntax', () => {
    const raw = [
      'Some prose.',
      '```ts path=tests/unit/foo.test.ts',
      'export const x = 1;',
      '```',
    ].join('\n');
    const files = parseModelTestResponse(raw);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('tests/unit/foo.test.ts');
  });

  it('parses a JSON envelope', () => {
    const raw = [
      'Here are the files:',
      '```json',
      '{ "files": [',
      '  { "path": "tests/unit/json.test.ts", "content": "// hello" },',
      '  { "path": "tests/unit/json2.test.ts", "content": "// world" }',
      '] }',
      '```',
    ].join('\n');
    const files = parseModelTestResponse(raw);
    expect(files).toHaveLength(2);
    expect(files.map(f => f.path)).toEqual([
      'tests/unit/json.test.ts',
      'tests/unit/json2.test.ts',
    ]);
  });

  it('drops fenced blocks with no path indicator', () => {
    const raw = '```ts\nconst orphan = 1;\n```\n';
    expect(parseModelTestResponse(raw)).toEqual([]);
  });

  it('parseModelFixResponse uses the same parser shape', () => {
    const raw = [
      'File: src/foo.ts',
      '```ts',
      'export const replaced = 2;',
      '```',
    ].join('\n');
    const files = parseModelFixResponse(raw);
    expect(files).toEqual([{ path: 'src/foo.ts', content: 'export const replaced = 2;' }]);
  });
});

// ---------------------------------------------------------------------------
// Glob matching
// ---------------------------------------------------------------------------

describe('Task #64: compileGlob + isPathTargetable', () => {
  it('matches files under src with **/* token', () => {
    const rx = compileGlob('src/**/*.ts');
    expect(rx.test('src/foo.ts')).toBe(true);
    expect(rx.test('src/cli/bar.ts')).toBe(true);
    expect(rx.test('src/cli/nested/baz.ts')).toBe(true);
    expect(rx.test('tests/foo.ts')).toBe(false);
    expect(rx.test('src/foo.js')).toBe(false);
  });

  it('matches brace alternation', () => {
    const rx = compileGlob('src/**/*.{ts,tsx}');
    expect(rx.test('src/a/b.ts')).toBe(true);
    expect(rx.test('src/a/b.tsx')).toBe(true);
    expect(rx.test('src/a/b.js')).toBe(false);
  });

  it('isPathTargetable rejects tests/ regardless of glob', () => {
    expect(isPathTargetable('tests/unit/foo.test.ts', 'tests/**/*.ts')).toBe(false);
    expect(isPathTargetable('tests/foo.ts', '**/*.ts')).toBe(false);
  });

  it('isPathTargetable rejects path traversal', () => {
    expect(isPathTargetable('../outside.ts', 'src/**/*.ts')).toBe(false);
    expect(isPathTargetable('src/../etc/passwd', 'src/**/*.ts')).toBe(false);
  });

  it('isPathTargetable accepts a file matching the glob and not under tests/', () => {
    expect(isPathTargetable('src/cli/foo.ts', 'src/**/*.ts')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Iteration journal
// ---------------------------------------------------------------------------

describe('Task #64: iteration journal', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'tdd-log-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('logIteration appends one JSONL line per call', () => {
    const logPath = join(tmp, 'iterations.jsonl');
    logIteration(logPath, {
      iteration: 1, ts: '2026-01-01T00:00:00Z', phase: 'write-tests', files: ['tests/a.test.ts'],
    });
    logIteration(logPath, {
      iteration: 2, ts: '2026-01-01T00:00:01Z', phase: 'run-tests', files: [], exitCode: 1, message: 'red',
    });
    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ iteration: 1, phase: 'write-tests' });
  });

  it('readIterationLog returns [] for a missing file', () => {
    expect(readIterationLog(join(tmp, 'nope.jsonl'))).toEqual([]);
  });

  it('readIterationLog round-trips written entries', () => {
    const logPath = join(tmp, 'iterations.jsonl');
    const entries = [
      { iteration: 1, ts: 't1', phase: 'write-tests' as const, files: ['a'] },
      { iteration: 2, ts: 't2', phase: 'run-tests' as const, files: [], exitCode: 0 },
    ];
    for (const e of entries) logIteration(logPath, e);
    const back = readIterationLog(logPath);
    expect(back).toHaveLength(2);
    expect(back[0].phase).toBe('write-tests');
    expect(back[1].exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Loop driver — end-to-end behaviour
// ---------------------------------------------------------------------------

interface Sandbox {
  root: string;
  repoRoot: string;
  runDir: string;
  specPath: string;
}

function makeSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'tdd-loop-'));
  const repoRoot = join(root, 'repo');
  const runDir = join(root, 'run');
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(runDir, { recursive: true });
  // tests/ root exists so test writes succeed without surprise
  mkdirSync(join(repoRoot, 'tests', 'unit'), { recursive: true });
  // src/ root for fix-loop writes
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  const specPath = join(repoRoot, 'spec.md');
  writeFileSync(specPath, [
    '# Sample Feature',
    '',
    'Adds a helper that returns 42.',
    '',
    '## Acceptance criteria',
    '- Returns 42',
  ].join('\n'), 'utf-8');
  return { root, repoRoot, runDir, specPath };
}

function makeTestInvoker(responses: Record<'write-tests' | 'fix', string[]>): ModelInvoker {
  const writeQueue = [...responses['write-tests']];
  const fixQueue = [...responses['fix']];
  return async (phase) => {
    const raw = phase === 'write-tests' ? (writeQueue.shift() ?? '') : (fixQueue.shift() ?? '');
    const files = phase === 'write-tests'
      ? parseModelTestResponse(raw)
      : parseModelFixResponse(raw);
    const result: ModelInvocationResult = { raw, files };
    return result;
  };
}

function makeStubTestRunner(sequence: TestRunResult[]): TestRunner {
  const queue = [...sequence];
  return () => queue.shift() ?? { exitCode: 1, stdout: '', stderr: 'no more queued runs' };
}

describe('Task #64: runTddLoop', () => {
  let sb: Sandbox;
  beforeEach(() => {
    sb = makeSandbox();
  });
  afterEach(() => {
    rmSync(sb.root, { recursive: true, force: true });
  });

  it('writes tests on iteration 1 and exits success when tests go green', async () => {
    const result = await runTddLoop({
      specPath: sb.specPath,
      runDir: sb.runDir,
      repoRoot: sb.repoRoot,
      maxIterations: 10,
      modelInvoker: makeTestInvoker({
        'write-tests': [[
          'File: tests/unit/sample.test.ts',
          '```ts',
          "import { it, expect } from 'vitest';",
          "it('returns 42', () => expect(42).toBe(42));",
          '```',
        ].join('\n')],
        'fix': [],
      }),
      testRunner: makeStubTestRunner([
        { exitCode: 0, stdout: 'green', stderr: '' },
      ]),
    });
    expect(result.status).toBe('success');
    expect(result.iterations).toBe(2); // 1 = write-tests, 2 = run-tests
    expect(result.testFilesWritten).toEqual(['tests/unit/sample.test.ts']);
    expect(existsSync(join(sb.repoRoot, 'tests/unit/sample.test.ts'))).toBe(true);
  });

  it('exits cap_reached after maxIterations of failing runs', async () => {
    // Provide fix responses that legitimately patch (so we don't get rejected early)
    const fixResponses = Array.from({ length: 10 }, (_, i) => [
      `File: src/foo.ts`,
      '```ts',
      `export const x = ${i};`,
      '```',
    ].join('\n'));

    const testRuns: TestRunResult[] = Array.from({ length: 10 }, () => ({
      exitCode: 1, stdout: 'fail', stderr: 'AssertionError',
    }));

    const result = await runTddLoop({
      specPath: sb.specPath,
      runDir: sb.runDir,
      repoRoot: sb.repoRoot,
      maxIterations: 5, // tight cap
      modelInvoker: makeTestInvoker({
        'write-tests': [[
          'File: tests/unit/sample.test.ts',
          '```ts',
          'export const _ = 1;',
          '```',
        ].join('\n')],
        'fix': fixResponses,
      }),
      testRunner: makeStubTestRunner(testRuns),
    });
    expect(result.status).toBe('cap_reached');
    expect(result.iterations).toBe(5);
    expect(result.message).toMatch(/cap/);
  });

  it('--pre-tests-only stops after the test-write step', async () => {
    const invoker: ModelInvoker = async (phase) => {
      if (phase === 'fix') throw new Error('fix invoker must not be called in pre-tests-only');
      const raw = [
        'File: tests/unit/p.test.ts',
        '```ts',
        'export const t = 1;',
        '```',
      ].join('\n');
      return { raw, files: parseModelTestResponse(raw) };
    };
    let runnerCalled = 0;
    const runner: TestRunner = () => {
      runnerCalled += 1;
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const result = await runTddLoop({
      specPath: sb.specPath,
      runDir: sb.runDir,
      repoRoot: sb.repoRoot,
      preTestsOnly: true,
      modelInvoker: invoker,
      testRunner: runner,
    });
    expect(result.status).toBe('pre_tests_only');
    expect(result.iterations).toBe(1);
    expect(runnerCalled).toBe(0);
    expect(existsSync(join(sb.repoRoot, 'tests/unit/p.test.ts'))).toBe(true);
  });

  it('rejects fix proposals outside --target-files and stops with a clear message', async () => {
    const result = await runTddLoop({
      specPath: sb.specPath,
      runDir: sb.runDir,
      repoRoot: sb.repoRoot,
      targetFilesGlob: 'src/**/*.ts',
      maxIterations: 3,
      modelInvoker: makeTestInvoker({
        'write-tests': [[
          'File: tests/unit/g.test.ts',
          '```ts',
          'export const t = 1;',
          '```',
        ].join('\n')],
        'fix': [[
          // model tries to write OUTSIDE the glob (no src/ prefix)
          'File: scripts/evil.ts',
          '```ts',
          'export const e = 1;',
          '```',
        ].join('\n')],
      }),
      testRunner: makeStubTestRunner([
        { exitCode: 1, stdout: '', stderr: 'red' },
      ]),
    });
    expect(result.status).toBe('rejected');
    expect(result.message).toMatch(/outside --target-files/);
    // The untargeted file MUST NOT have been written.
    expect(existsSync(join(sb.repoRoot, 'scripts/evil.ts'))).toBe(false);
  });

  it('rejects fix attempts that try to modify a test file', async () => {
    const result = await runTddLoop({
      specPath: sb.specPath,
      runDir: sb.runDir,
      repoRoot: sb.repoRoot,
      targetFilesGlob: '**/*.ts', // permissive glob — only the tests/ guard should block
      maxIterations: 3,
      modelInvoker: makeTestInvoker({
        'write-tests': [[
          'File: tests/unit/g.test.ts',
          '```ts',
          'export const t = 1;',
          '```',
        ].join('\n')],
        'fix': [[
          // model tries to overwrite the test file (cheating)
          'File: tests/unit/g.test.ts',
          '```ts',
          'export const t = 99; // cheat',
          '```',
        ].join('\n')],
      }),
      testRunner: makeStubTestRunner([
        { exitCode: 1, stdout: '', stderr: 'red' },
      ]),
    });
    expect(result.status).toBe('rejected');
    // The original (iteration-1) test file content MUST be preserved.
    const onDisk = readFileSync(join(sb.repoRoot, 'tests/unit/g.test.ts'), 'utf-8').trim();
    expect(onDisk).toBe('export const t = 1;');
  });

  it('dry-run does not write any test files and reports dry_run', async () => {
    const result = await runTddLoop({
      specPath: sb.specPath,
      runDir: sb.runDir,
      repoRoot: sb.repoRoot,
      dryRun: true,
      modelInvoker: makeTestInvoker({
        'write-tests': [[
          'File: tests/unit/dry.test.ts',
          '```ts',
          'export const d = 1;',
          '```',
        ].join('\n')],
        'fix': [],
      }),
      testRunner: makeStubTestRunner([]),
    });
    expect(result.status).toBe('dry_run');
    expect(existsSync(join(sb.repoRoot, 'tests/unit/dry.test.ts'))).toBe(false);
  });

  it('resumes from an existing runDir, continuing the iteration counter', async () => {
    // First run: write tests, then a single red test cycle. Stop short of green.
    const writeRaw = [
      'File: tests/unit/r.test.ts',
      '```ts',
      'export const r = 1;',
      '```',
    ].join('\n');
    const fixRaw = [
      'File: src/r.ts',
      '```ts',
      'export const r = 1;',
      '```',
    ].join('\n');
    const result1 = await runTddLoop({
      specPath: sb.specPath,
      runDir: sb.runDir,
      repoRoot: sb.repoRoot,
      maxIterations: 3, // 1=write, 2=run(red), 3=fix → cap
      modelInvoker: makeTestInvoker({
        'write-tests': [writeRaw],
        'fix': [fixRaw],
      }),
      testRunner: makeStubTestRunner([
        { exitCode: 1, stdout: '', stderr: 'red' },
      ]),
    });
    expect(result1.status).toBe('cap_reached');
    expect(result1.iterations).toBe(3);

    // Resume: same runDir, this time tests go green. Loop must NOT re-run the
    // test-write step (testsAlreadyWritten is detected) and must continue
    // counting from where iteration 3 left off.
    const result2 = await runTddLoop({
      specPath: sb.specPath,
      runDir: sb.runDir, // same runDir
      repoRoot: sb.repoRoot,
      maxIterations: 10,
      modelInvoker: async (phase) => {
        if (phase === 'write-tests') {
          throw new Error('write-tests must not be invoked on resume');
        }
        return { raw: fixRaw, files: parseModelFixResponse(fixRaw) };
      },
      testRunner: makeStubTestRunner([
        { exitCode: 0, stdout: 'green', stderr: '' },
      ]),
    });
    expect(result2.status).toBe('success');
    // Counter continues from 3 → next run-tests is iteration 4
    expect(result2.iterations).toBe(4);
  });

  it('records every iteration in the JSONL log', async () => {
    const result = await runTddLoop({
      specPath: sb.specPath,
      runDir: sb.runDir,
      repoRoot: sb.repoRoot,
      maxIterations: 4,
      modelInvoker: makeTestInvoker({
        'write-tests': [[
          'File: tests/unit/j.test.ts',
          '```ts',
          'export const j = 1;',
          '```',
        ].join('\n')],
        'fix': [[
          'File: src/j.ts',
          '```ts',
          'export const j = 1;',
          '```',
        ].join('\n')],
      }),
      testRunner: makeStubTestRunner([
        { exitCode: 1, stdout: '', stderr: 'red' },
        { exitCode: 0, stdout: 'green', stderr: '' },
      ]),
    });
    expect(result.status).toBe('success');
    const entries = readIterationLog(result.logPath);
    const phases = entries.map(e => e.phase);
    expect(phases).toContain('write-tests');
    expect(phases).toContain('run-tests');
    expect(phases).toContain('fix');
    expect(phases).toContain('done');
  });

  it('writes a result.json summary on success', async () => {
    const result = await runTddLoop({
      specPath: sb.specPath,
      runDir: sb.runDir,
      repoRoot: sb.repoRoot,
      maxIterations: 5,
      modelInvoker: makeTestInvoker({
        'write-tests': [[
          'File: tests/unit/s.test.ts',
          '```ts',
          'export const s = 1;',
          '```',
        ].join('\n')],
        'fix': [],
      }),
      testRunner: makeStubTestRunner([
        { exitCode: 0, stdout: 'green', stderr: '' },
      ]),
    });
    expect(existsSync(result.resultPath)).toBe(true);
    const summary: RunResult = JSON.parse(readFileSync(result.resultPath, 'utf-8'));
    expect(summary.status).toBe('success');
    expect(summary.testFilesWritten).toEqual(['tests/unit/s.test.ts']);
  });
});
