import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { snapshotSessionCost } from '../../../src/bus/task-cost';
import { createTask, updateTask, completeTask } from '../../../src/bus/task';
import { makeTempDir, removeTempDir, makeBusPaths } from '../../setup';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProjectDir(projectsBase: string, cwd: string): string {
  const dirName = cwd.replace(/\//g, '-');
  const projectDir = join(projectsBase, dirName);
  mkdirSync(projectDir, { recursive: true });
  return projectDir;
}

function snap(sessionId: string, cwd: string, projectsBase: string): number {
  return snapshotSessionCost(sessionId, cwd, projectsBase);
}

function writeJSONL(dir: string, sessionId: string, lines: object[]): void {
  writeFileSync(
    join(dir, `${sessionId}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    'utf-8',
  );
}

function assistantEntry(usage: {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}, model = 'claude-sonnet-4-6'): object {
  return {
    type: 'assistant',
    message: {
      model,
      usage: {
        input_tokens: usage.input_tokens ?? 0,
        output_tokens: usage.output_tokens ?? 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// snapshotSessionCost unit tests
// ---------------------------------------------------------------------------

describe('snapshotSessionCost', () => {
  let projectsBase: string;

  beforeEach(() => {
    projectsBase = mkdtempSync(join(tmpdir(), 'ctx-claude-projects-'));
  });

  afterEach(() => {
    rmSync(projectsBase, { recursive: true, force: true });
  });

  it('returns 0 when sessionId is empty', () => {
    expect(snap('', '/some/dir', projectsBase)).toBe(0);
  });

  it('returns 0 when JSONL file does not exist', () => {
    expect(snap('no-such-session', '/some/dir', projectsBase)).toBe(0);
  });

  it('sums pre-computed costUSD fields from assistant entries', () => {
    const cwd = '/fake/agent/cwd';
    const projectDir = makeProjectDir(projectsBase, cwd);
    writeJSONL(projectDir, 'sess-1', [
      { type: 'user', message: 'hello' },
      { type: 'assistant', costUSD: 0.005 },
      { type: 'assistant', costUSD: 0.003 },
      { type: 'assistant', message: { usage: { input_tokens: 0, output_tokens: 0 } } },
    ]);
    expect(snap('sess-1', cwd, projectsBase)).toBeCloseTo(0.008, 6);
  });

  it('computes cost from token usage when costUSD is absent', () => {
    // 1M input at $3/M + 1M output at $15/M = $18
    const cwd = '/fake/agent/cwd2';
    const projectDir = makeProjectDir(projectsBase, cwd);
    writeJSONL(projectDir, 'sess-2', [
      assistantEntry({ input_tokens: 1_000_000, output_tokens: 1_000_000 }),
    ]);
    expect(snap('sess-2', cwd, projectsBase)).toBeCloseTo(18.0, 5);
  });

  it('includes cache write and read token costs', () => {
    // cw: 1M * $3.75/M = $3.75, cr: 1M * $0.30/M = $0.30
    const cwd = '/fake/agent/cwd3';
    const projectDir = makeProjectDir(projectsBase, cwd);
    writeJSONL(projectDir, 'sess-3', [
      assistantEntry({
        cache_creation_input_tokens: 1_000_000,
        cache_read_input_tokens: 1_000_000,
      }),
    ]);
    expect(snap('sess-3', cwd, projectsBase)).toBeCloseTo(4.05, 5);
  });

  it('skips non-assistant entries', () => {
    const cwd = '/fake/agent/cwd4';
    const projectDir = makeProjectDir(projectsBase, cwd);
    writeJSONL(projectDir, 'sess-4', [
      { type: 'user', costUSD: 99 },
      { type: 'system', costUSD: 99 },
      { type: 'assistant', costUSD: 0.001 },
    ]);
    expect(snap('sess-4', cwd, projectsBase)).toBeCloseTo(0.001, 6);
  });

  it('skips all-zero usage entries', () => {
    const cwd = '/fake/agent/cwd5';
    const projectDir = makeProjectDir(projectsBase, cwd);
    writeJSONL(projectDir, 'sess-5', [
      assistantEntry({ input_tokens: 0, output_tokens: 0 }),
    ]);
    expect(snap('sess-5', cwd, projectsBase)).toBe(0);
  });

  it('skips corrupt JSON lines without throwing', () => {
    const cwd = '/fake/agent/cwd6';
    const projectDir = makeProjectDir(projectsBase, cwd);
    writeFileSync(join(projectDir, 'sess-6.jsonl'),
      'not json\n' +
      JSON.stringify({ type: 'assistant', costUSD: 0.002 }) + '\n' +
      '{bad\n',
    );
    expect(snap('sess-6', cwd, projectsBase)).toBeCloseTo(0.002, 6);
  });
});

// ---------------------------------------------------------------------------
// Integration: updateTask wires cost_snapshot_start on in_progress transition
// ---------------------------------------------------------------------------

describe('updateTask cost snapshot', () => {
  let testDir: string;
  let paths: BusPaths;
  let originalSession: string | undefined;

  beforeEach(() => {
    testDir = makeTempDir('ctx-task-cost-update-');
    paths = makeBusPaths(testDir, 'dev');
    originalSession = process.env['CLAUDE_CODE_SESSION_ID'];
  });

  afterEach(() => {
    removeTempDir(testDir);
    if (originalSession === undefined) {
      delete process.env['CLAUDE_CODE_SESSION_ID'];
    } else {
      process.env['CLAUDE_CODE_SESSION_ID'] = originalSession;
    }
  });

  it('stores cost_snapshot_start in meta when transitioning to in_progress', () => {
    const taskId = createTask(paths, 'dev', 'acme', 'Test cost snapshot');
    updateTask(paths, taskId, 'in_progress');

    const task = JSON.parse(
      readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8'),
    );
    expect(task.meta).toBeDefined();
    expect(typeof task.meta.cost_snapshot_start).toBe('number');
    expect(task.meta.cost_snapshot_start).toBeGreaterThanOrEqual(0);
  });

  it('does not set cost_snapshot_start for non-in_progress transitions', () => {
    const taskId = createTask(paths, 'dev', 'acme', 'Test no snapshot');
    updateTask(paths, taskId, 'blocked', {
      blocker: { blocker_reason: 'waiting', next_proof_required: 'PR merged' },
    });

    const task = JSON.parse(
      readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8'),
    );
    expect(task.meta?.cost_snapshot_start).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Integration: completeTask computes session_cost_usd delta
// ---------------------------------------------------------------------------

describe('completeTask cost attribution', () => {
  let testDir: string;
  let paths: BusPaths;
  let originalSession: string | undefined;

  beforeEach(() => {
    testDir = makeTempDir('ctx-task-cost-complete-');
    paths = makeBusPaths(testDir, 'dev');
    originalSession = process.env['CLAUDE_CODE_SESSION_ID'];
    delete process.env['CLAUDE_CODE_SESSION_ID'];
  });

  afterEach(() => {
    removeTempDir(testDir);
    if (originalSession === undefined) {
      delete process.env['CLAUDE_CODE_SESSION_ID'];
    } else {
      process.env['CLAUDE_CODE_SESSION_ID'] = originalSession;
    }
  });

  it('stores session_cost_usd when cost_snapshot_start is present in meta', () => {
    const taskId = createTask(paths, 'dev', 'acme', 'Cost delta task', {
      meta: { cost_snapshot_start: 5.0 },
    });
    updateTask(paths, taskId, 'in_progress');
    completeTask(paths, taskId, 'done');

    const task = JSON.parse(
      readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8'),
    );
    expect(task.meta).toBeDefined();
    expect(typeof task.meta.session_cost_usd).toBe('number');
    // endCost will be 0 (no session JSONL), so delta = max(0, 0 - 5.0) = 0
    expect(task.meta.session_cost_usd).toBeGreaterThanOrEqual(0);
  });

  it('does not store session_cost_usd when task is completed without an in_progress snapshot', () => {
    // Complete directly from pending — updateTask(in_progress) was never called,
    // so meta.cost_snapshot_start is never written, so completeTask has no delta to store.
    const taskId = createTask(paths, 'dev', 'acme', 'No snapshot task');
    // Manually set to in_progress without triggering the wiring, then complete
    // by skipping updateTask and going straight to completeTask.
    completeTask(paths, taskId, 'done');

    const task = JSON.parse(
      readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8'),
    );
    expect(task.meta?.session_cost_usd).toBeUndefined();
  });

  it('session_cost_usd is never negative', () => {
    // Start snapshot is in the future (impossible in practice, but guard against it)
    const taskId = createTask(paths, 'dev', 'acme', 'Negative guard', {
      meta: { cost_snapshot_start: 999.0 },
    });
    updateTask(paths, taskId, 'in_progress');
    completeTask(paths, taskId, 'done');

    const task = JSON.parse(
      readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8'),
    );
    expect(task.meta.session_cost_usd).toBeGreaterThanOrEqual(0);
  });
});
