/**
 * tests/integration/codex-fallback-smoke.test.ts
 *
 * Smoke test: exercises the full parseCodexLimit → handleCodexFallback path
 * with a mocked 429 long_lock response to verify end-to-end wiring without
 * spawning real processes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { BusPaths } from '../../src/types/index.js';

vi.mock('../../src/bus/rgos-mirror.js', () => ({
  mirrorEventToRgos: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawnSync: vi.fn().mockReturnValue({ status: 0 }) };
});

const { spawnSync } = await import('child_process');
const { parseCodexLimit, handleCodexFallback } = await import('../../src/bus/codex-fallback.js');

const mockSpawnSync = vi.mocked(spawnSync);

function makePaths(root: string): BusPaths {
  return {
    ctxRoot: root,
    inbox: join(root, 'inbox'),
    inflight: join(root, 'inflight'),
    processed: join(root, 'processed'),
    logDir: join(root, 'logs'),
    stateDir: join(root, 'state'),
    taskDir: join(root, 'tasks'),
    approvalDir: join(root, 'approvals'),
    analyticsDir: join(root, 'analytics'),
    deliverablesDir: join(root, 'deliverables'),
  };
}

function readEventLines(root: string, agent: string): Record<string, unknown>[] {
  const today = new Date().toISOString().split('T')[0];
  const file = join(root, 'analytics', 'events', agent, `${today}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .trim().split('\n').filter(Boolean)
    .map(l => JSON.parse(l) as Record<string, unknown>);
}

describe('codex-fallback smoke — 429 long_lock path', () => {
  let tmpDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'codex-fallback-smoke-'));
    mkdirSync(join(tmpDir, 'analytics'), { recursive: true });
    paths = makePaths(tmpDir);
    mockSpawnSync.mockClear();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('429 with no Retry-After → classifies as long_lock', () => {
    const r = parseCodexLimit('exceeded retry limit\n429 Too Many Requests', 1);
    expect(r.limitClass).toBe('long_lock');
    expect(r.retryAfterSecs).toBeNull();
  });

  it('long_lock + autoFallback=true → spawns worker, returns dispatched=true + workerName', async () => {
    const r = await handleCodexFallback(
      { stderr: '429 rate limit exceeded', exitCode: 1 },
      {
        prompt: 'implement the feature',
        dir: '/tmp/task-dir',
        parentAgent: 'orchestrator',
        taskId: 'smoke-task-1',
        autoFallback: true,
      },
      paths, 'dev', 'revops-global',
    );

    expect(r.dispatched).toBe(true);
    expect(r.limitClass).toBe('long_lock');
    expect(r.workerName).toMatch(/^codex-spillover-\d+$/);

    // Verify spawn-worker was called with correct arguments
    expect(mockSpawnSync).toHaveBeenCalledOnce();
    const [cmd, args] = mockSpawnSync.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('cortextos');
    expect(args).toContain('spawn-worker');
    expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-4-7');
    expect(args[args.indexOf('--dir') + 1]).toBe('/tmp/task-dir');
    expect(args[args.indexOf('--parent') + 1]).toBe('orchestrator');

    // Worker prompt must include the original task and terminate-worker lifecycle instruction
    const promptArg = args[args.indexOf('--prompt') + 1];
    expect(promptArg).toContain('implement the feature');
    expect(promptArg).toContain('terminate-worker');
    expect(promptArg).toContain('send-message orchestrator');
    expect(promptArg).toContain(r.workerName!);

    // Both events must be emitted
    const events = readEventLines(tmpDir, 'dev');
    const hitEvent = events.find(e => e.event === 'codex_limit_hit');
    const dispatchEvent = events.find(e => e.event === 'codex_failover_dispatched');
    expect(hitEvent).toBeDefined();
    expect(dispatchEvent).toBeDefined();

    const hitMeta = hitEvent!.metadata as Record<string, unknown>;
    expect(hitMeta.limit_class).toBe('long_lock');
    expect(hitMeta.task_id).toBe('smoke-task-1');

    const dispMeta = dispatchEvent!.metadata as Record<string, unknown>;
    expect(dispMeta.worker_name).toBe(r.workerName);
    expect(dispMeta.task_id).toBe('smoke-task-1');
    expect(dispMeta.parent_agent).toBe('orchestrator');
  });

  it('long_lock + autoFallback=false → emits codex_limit_hit but does not spawn', async () => {
    const r = await handleCodexFallback(
      { stderr: '429 rate limit exceeded', exitCode: 1 },
      { prompt: 'implement the feature', dir: '/tmp/task-dir', parentAgent: 'orchestrator', autoFallback: false },
      paths, 'dev', 'revops-global',
    );

    expect(r.dispatched).toBe(false);
    expect(r.limitClass).toBe('long_lock');
    expect(r.workerName).toBeUndefined();
    expect(mockSpawnSync).not.toHaveBeenCalled();

    const events = readEventLines(tmpDir, 'dev');
    expect(events.some(e => e.event === 'codex_limit_hit')).toBe(true);
    expect(events.some(e => e.event === 'codex_failover_dispatched')).toBe(false);
  });

  it('short_throttle + autoFallback=true → emits codex_limit_hit but does not spawn', async () => {
    const r = await handleCodexFallback(
      { stderr: '429\nRetry-After: 600', exitCode: 1 },
      { prompt: 'do work', dir: '/tmp', parentAgent: 'orchestrator', autoFallback: true },
      paths, 'dev', 'revops-global',
    );

    expect(r.dispatched).toBe(false);
    expect(r.limitClass).toBe('short_throttle');
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it('auth_expired → emits codex_limit_hit, no spawn regardless of autoFallback', async () => {
    const r = await handleCodexFallback(
      { stderr: '401 unauthorized', exitCode: 1 },
      { prompt: 'do work', dir: '/tmp', parentAgent: 'orchestrator', autoFallback: true },
      paths, 'dev', 'revops-global',
    );

    expect(r.dispatched).toBe(false);
    expect(r.limitClass).toBe('auth_expired');
    expect(mockSpawnSync).not.toHaveBeenCalled();

    const events = readEventLines(tmpDir, 'dev');
    expect(events.some(e => e.event === 'codex_limit_hit')).toBe(true);
  });
});
