/**
 * Wave-1 Task #65 — `cortextos swarm` CLI unit tests.
 *
 * Covers argument parsing + delegation to the runner with the right params.
 * The runner itself is mocked — the swarm-runner test suite covers its
 * behaviour. We're verifying the CLI layer here.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  executeRun,
  loadItemsFromFile,
  resolvePromptTemplate,
  formatStatus,
  type RunOptions,
} from '../../../src/cli/swarm';
import type { SwarmRunResult, SwarmStatus } from '../../../src/daemon/swarm-runner';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'swarm-cli-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('loadItemsFromFile', () => {
  it('parses each non-empty, non-comment line as a JSON object', () => {
    const path = join(tmpRoot, 'items.jsonl');
    writeFileSync(path, [
      '# a comment',
      '',
      '{"id": "alpha"}',
      '{"id": "beta", "payload": "data"}',
      '',
    ].join('\n'), 'utf-8');
    const items = loadItemsFromFile(path);
    expect(items).toEqual([
      { id: 'alpha' },
      { id: 'beta', payload: 'data' },
    ]);
  });

  it('throws when the file does not exist', () => {
    expect(() => loadItemsFromFile(join(tmpRoot, 'nope.jsonl'))).toThrow(/not found/);
  });

  it('throws on a line missing an id', () => {
    const path = join(tmpRoot, 'bad.jsonl');
    writeFileSync(path, '{"foo": "bar"}', 'utf-8');
    expect(() => loadItemsFromFile(path)).toThrow(/'id'/);
  });

  it('throws on invalid JSON', () => {
    const path = join(tmpRoot, 'bad.jsonl');
    writeFileSync(path, '{not json}', 'utf-8');
    expect(() => loadItemsFromFile(path)).toThrow(/not valid JSON/);
  });

  it('throws on a non-object top-level line', () => {
    const path = join(tmpRoot, 'bad.jsonl');
    writeFileSync(path, '["array"]', 'utf-8');
    expect(() => loadItemsFromFile(path)).toThrow(/JSON object/);
  });

  it('throws when zero items result', () => {
    const path = join(tmpRoot, 'empty.jsonl');
    writeFileSync(path, '# only comments\n', 'utf-8');
    expect(() => loadItemsFromFile(path)).toThrow(/0 items/);
  });
});

describe('resolvePromptTemplate', () => {
  it('reads a file when the value points to one', () => {
    const path = join(tmpRoot, 'prompt.txt');
    writeFileSync(path, 'Hello {{item.id}}', 'utf-8');
    expect(resolvePromptTemplate(path)).toBe('Hello {{item.id}}');
  });

  it('treats inline strings as the template when no file exists', () => {
    expect(resolvePromptTemplate('Inline {{item.id}}')).toBe('Inline {{item.id}}');
  });

  it('throws on empty string', () => {
    expect(() => resolvePromptTemplate('')).toThrow(/required/);
  });
});

describe('executeRun: argument validation', () => {
  function writeMinimalInput(): string {
    const path = join(tmpRoot, 'items.jsonl');
    writeFileSync(path, '{"id":"a"}\n{"id":"b"}', 'utf-8');
    return path;
  }

  it('throws when --model is empty', async () => {
    const path = writeMinimalInput();
    await expect(executeRun(
      { input: path, prompt: 'x', model: [] },
      {},
      vi.fn().mockResolvedValue({} as SwarmRunResult),
    )).rejects.toThrow(/--model required/);
  });

  it('throws when --concurrent is not a positive integer', async () => {
    const path = writeMinimalInput();
    await expect(executeRun(
      { input: path, prompt: 'x', model: ['m'], concurrent: '-1' },
      {},
      vi.fn().mockResolvedValue({} as SwarmRunResult),
    )).rejects.toThrow(/--concurrent/);
  });

  it('throws when --reconcile is not a valid mode', async () => {
    const path = writeMinimalInput();
    await expect(executeRun(
      { input: path, prompt: 'x', model: ['m'], reconcile: 'bogus' },
      {},
      vi.fn().mockResolvedValue({} as SwarmRunResult),
    )).rejects.toThrow(/--reconcile/);
  });
});

describe('executeRun: forwards parsed config to the runner', () => {
  it('passes items + prompt + single model + concurrent to the runner', async () => {
    const inputPath = join(tmpRoot, 'items.jsonl');
    writeFileSync(inputPath, '{"id":"alpha"}\n{"id":"beta"}', 'utf-8');

    const runner = vi.fn().mockResolvedValue({
      runId: 'fake',
      runDir: tmpRoot,
      results: [],
      summary: {} as SwarmRunResult['summary'],
    });

    const options: RunOptions = {
      input: inputPath,
      prompt: 'Render {{item.id}}',
      model: ['claude-sonnet'],
      concurrent: '4',
    };

    await executeRun(options, {}, runner as unknown as typeof import('../../../src/daemon/swarm-runner').runSwarm);

    expect(runner).toHaveBeenCalledOnce();
    const callArgs = runner.mock.calls[0]!;
    const cfg = callArgs[0];
    expect(cfg.items.map((i: { id: string }) => i.id)).toEqual(['alpha', 'beta']);
    expect(cfg.promptTemplate).toBe('Render {{item.id}}');
    // Single model is unwrapped from the array — keeps the runner signature
    // explicit about the "swarm-of-one-model" vs "dual-model" distinction.
    expect(cfg.model).toBe('claude-sonnet');
    expect(cfg.maxConcurrent).toBe(4);
  });

  it('forwards multiple --model values as an array', async () => {
    const inputPath = join(tmpRoot, 'items.jsonl');
    writeFileSync(inputPath, '{"id":"a"}', 'utf-8');
    const runner = vi.fn().mockResolvedValue({
      runId: 'fake',
      runDir: tmpRoot,
      results: [],
      summary: {} as SwarmRunResult['summary'],
    });

    await executeRun({
      input: inputPath,
      prompt: 'x',
      model: ['claude-opus', 'codex'],
      reconcile: 'all',
    }, {}, runner as unknown as typeof import('../../../src/daemon/swarm-runner').runSwarm);

    const cfg = runner.mock.calls[0]![0];
    expect(cfg.model).toEqual(['claude-opus', 'codex']);
    expect(cfg.reconcileMode).toBe('all');
  });

  it('defaults concurrent to 8 when not provided', async () => {
    const inputPath = join(tmpRoot, 'items.jsonl');
    writeFileSync(inputPath, '{"id":"a"}', 'utf-8');
    const runner = vi.fn().mockResolvedValue({
      runId: 'fake', runDir: tmpRoot, results: [],
      summary: {} as SwarmRunResult['summary'],
    });

    await executeRun(
      { input: inputPath, prompt: 'x', model: ['m'] },
      {},
      runner as unknown as typeof import('../../../src/daemon/swarm-runner').runSwarm,
    );

    expect(runner.mock.calls[0]![0].maxConcurrent).toBe(8);
  });

  it('threads --out-dir through to swarmStateRoot deps + config', async () => {
    const inputPath = join(tmpRoot, 'items.jsonl');
    writeFileSync(inputPath, '{"id":"a"}', 'utf-8');
    const customOut = join(tmpRoot, 'custom-out');
    mkdirSync(customOut, { recursive: true });

    const runner = vi.fn().mockResolvedValue({
      runId: 'fake', runDir: customOut, results: [],
      summary: {} as SwarmRunResult['summary'],
    });

    await executeRun(
      { input: inputPath, prompt: 'x', model: ['m'], outDir: customOut },
      {},
      runner as unknown as typeof import('../../../src/daemon/swarm-runner').runSwarm,
    );

    const depsArg = runner.mock.calls[0]![1];
    expect(depsArg.swarmStateRoot).toBe(customOut);
    expect(runner.mock.calls[0]![0].outDir).toBe(customOut);
  });

  it('threads --run-id through to the runner config', async () => {
    const inputPath = join(tmpRoot, 'items.jsonl');
    writeFileSync(inputPath, '{"id":"a"}', 'utf-8');
    const runner = vi.fn().mockResolvedValue({
      runId: 'my-runid', runDir: tmpRoot, results: [],
      summary: {} as SwarmRunResult['summary'],
    });

    await executeRun(
      { input: inputPath, prompt: 'x', model: ['m'], runId: 'my-runid' },
      {},
      runner as unknown as typeof import('../../../src/daemon/swarm-runner').runSwarm,
    );

    expect(runner.mock.calls[0]![0].runId).toBe('my-runid');
  });
});

describe('formatStatus', () => {
  it('renders a complete status block', () => {
    const status: SwarmStatus = {
      runId: 'swarm-test',
      runDir: '/tmp/swarm-test',
      completed: 3,
      succeeded: 2,
      failed: 1,
      totalDispatches: 5,
      avgDurationMs: 2500,
      etaMs: 5000,
      recent: [
        {
          runId: 'swarm-test', itemId: 'a', model: 'm',
          output: '', exitCode: 0, durationMs: 1234,
          startedAt: '2026-05-17T00:00:00.000Z',
          finishedAt: '2026-05-17T00:00:01.000Z',
        },
      ],
    };
    const out = formatStatus(status);
    expect(out).toContain('runId: swarm-test');
    expect(out).toContain('progress: 3/5');
    expect(out).toContain('ok=2');
    expect(out).toContain('fail=1');
    expect(out).toContain('eta:');
    expect(out).toContain('a via m');
  });

  it('handles missing totalDispatches (run still scheduling)', () => {
    const status: SwarmStatus = {
      runId: 'r', runDir: '/tmp/r',
      completed: 1, succeeded: 1, failed: 0,
      avgDurationMs: 0,
      recent: [],
    };
    const out = formatStatus(status);
    expect(out).toContain('still scheduling');
  });
});
