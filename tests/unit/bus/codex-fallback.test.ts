import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { BusPaths } from '../../../src/types/index';
import type { CodexFallbackInput } from '../../../src/bus/codex-fallback';

vi.mock('../../../src/bus/rgos-mirror.js', () => ({
  mirrorEventToRgos: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawnSync: vi.fn().mockReturnValue({ status: 0 }) };
});

const { spawnSync } = await import('child_process');
const { parseCodexLimit, handleCodexFallback } = await import('../../../src/bus/codex-fallback.js');

const mockSpawnSync = vi.mocked(spawnSync);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeInput(overrides: Partial<CodexFallbackInput> = {}): CodexFallbackInput {
  return { stderr: '', exitCode: 1, ...overrides };
}

function readEventLines(root: string, agentName: string): Record<string, unknown>[] {
  const today = new Date().toISOString().split('T')[0];
  const file = join(root, 'analytics', 'events', agentName, `${today}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// parseCodexLimit
// ---------------------------------------------------------------------------

describe('parseCodexLimit', () => {
  it('429 with Retry-After: 900 → short_throttle, retryAfterSecs=900', () => {
    const r = parseCodexLimit('exceeded retry limit\n429\nRetry-After: 900', 1);
    expect(r.limitClass).toBe('short_throttle');
    expect(r.retryAfterSecs).toBe(900);
  });

  it('429 with Retry-After: 7200 → long_lock, retryAfterSecs=7200', () => {
    const r = parseCodexLimit('rate limit exceeded\n429\nRetry-After: 7200', 1);
    expect(r.limitClass).toBe('long_lock');
    expect(r.retryAfterSecs).toBe(7200);
  });

  it('429 with "try again in 5m" → short_throttle, retryAfterSecs=300', () => {
    const r = parseCodexLimit('429 exceeded retry limit try again in 5min', 1);
    expect(r.limitClass).toBe('short_throttle');
    expect(r.retryAfterSecs).toBe(300);
  });

  it('429 with no Retry-After → long_lock, retryAfterSecs=null', () => {
    const r = parseCodexLimit('429 rate limit exceeded', 1);
    expect(r.limitClass).toBe('long_lock');
    expect(r.retryAfterSecs).toBeNull();
  });

  it('401 → auth_expired', () => {
    const r = parseCodexLimit('401 unauthorized', 1);
    expect(r.limitClass).toBe('auth_expired');
    expect(r.retryAfterSecs).toBeNull();
  });

  it('exit 0 → none regardless of stderr', () => {
    const r = parseCodexLimit('429 rate limit exceeded', 0);
    expect(r.limitClass).toBe('none');
    expect(r.retryAfterSecs).toBeNull();
  });

  it('non-rate-limit error → none', () => {
    const r = parseCodexLimit('internal server error', 1);
    expect(r.limitClass).toBe('none');
    expect(r.retryAfterSecs).toBeNull();
  });

  it('Retry-After exactly 1800 → short_throttle', () => {
    const r = parseCodexLimit('429\nRetry-After: 1800', 1);
    expect(r.limitClass).toBe('short_throttle');
    expect(r.retryAfterSecs).toBe(1800);
  });

  it('Retry-After 1801 → long_lock', () => {
    const r = parseCodexLimit('429\nRetry-After: 1801', 1);
    expect(r.limitClass).toBe('long_lock');
    expect(r.retryAfterSecs).toBe(1801);
  });

  it('"try again in 2h" → long_lock, retryAfterSecs=7200', () => {
    const r = parseCodexLimit('rate limit 429 try again in 2h', 1);
    expect(r.limitClass).toBe('long_lock');
    expect(r.retryAfterSecs).toBe(7200);
  });

  it('null exitCode with 429 stderr → classifies as long_lock (not treated as success)', () => {
    const r = parseCodexLimit('429 rate limit exceeded', null);
    expect(r.limitClass).toBe('long_lock');
    expect(r.retryAfterSecs).toBeNull();
  });

  it('null exitCode with non-rate-limit stderr → none', () => {
    const r = parseCodexLimit('process killed', null);
    expect(r.limitClass).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// handleCodexFallback
// ---------------------------------------------------------------------------

describe('handleCodexFallback', () => {
  let tmpDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'codex-fallback-test-'));
    mkdirSync(join(tmpDir, 'analytics'), { recursive: true });
    paths = makePaths(tmpDir);
    mockSpawnSync.mockClear();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does nothing when limit class is none (exit 0)', async () => {
    const result = makeInput({ exitCode: 0, stderr: '' });
    const r = await handleCodexFallback(
      result,
      { prompt: 'do work', dir: '/tmp', parentAgent: 'orchestrator' },
      paths, 'dev', 'revops-global',
    );
    expect(mockSpawnSync).not.toHaveBeenCalled();
    expect(readEventLines(tmpDir, 'dev')).toHaveLength(0);
    expect(r.dispatched).toBe(false);
    expect(r.limitClass).toBe('none');
  });

  it('emits codex_auth_expired error event (not codex_limit_hit) on 401', async () => {
    const result = makeInput({ exitCode: 1, stderr: '401 unauthorized' });
    const r = await handleCodexFallback(
      result,
      { prompt: 'do work', dir: '/tmp', parentAgent: 'orchestrator', taskId: 'task-auth' },
      paths, 'dev', 'revops-global',
    );
    expect(r.dispatched).toBe(false);
    expect(r.limitClass).toBe('auth_expired');
    expect(mockSpawnSync).not.toHaveBeenCalled();
    const events = readEventLines(tmpDir, 'dev');
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('codex_auth_expired');
    expect((events[0] as Record<string, unknown>).severity).toBe('error');
    expect((events[0].metadata as Record<string, unknown>).task_id).toBe('task-auth');
    expect((events[0].metadata as Record<string, unknown>).parent_agent).toBe('orchestrator');
  });

  it('emits codex_limit_hit on short_throttle', async () => {
    const result = makeInput({ exitCode: 1, stderr: 'exceeded retry limit\n429\nRetry-After: 900' });
    await handleCodexFallback(
      result,
      { prompt: 'do work', dir: '/tmp', parentAgent: 'orchestrator', autoFallback: false },
      paths, 'dev', 'revops-global',
    );
    const events = readEventLines(tmpDir, 'dev');
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('codex_limit_hit');
    expect((events[0].metadata as Record<string, unknown>).limit_class).toBe('short_throttle');
    expect((events[0].metadata as Record<string, unknown>).retry_after_secs).toBe(900);
  });

  it('does not spawn-worker when autoFallback is false on long_lock', async () => {
    const result = makeInput({ exitCode: 1, stderr: '429 rate limit exceeded' });
    await handleCodexFallback(
      result,
      { prompt: 'do work', dir: '/tmp', parentAgent: 'orchestrator', autoFallback: false },
      paths, 'dev', 'revops-global',
    );
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it('does not spawn-worker for short_throttle even with autoFallback true', async () => {
    const result = makeInput({ exitCode: 1, stderr: '429\nRetry-After: 900' });
    await handleCodexFallback(
      result,
      { prompt: 'do work', dir: '/tmp', parentAgent: 'orchestrator', autoFallback: true },
      paths, 'dev', 'revops-global',
    );
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it('spawns worker and emits codex_failover_dispatched on long_lock + autoFallback', async () => {
    const result = makeInput({ exitCode: 1, stderr: '429 rate limit exceeded' });
    const r = await handleCodexFallback(
      result,
      { prompt: 'do work', dir: '/tmp/workdir', parentAgent: 'orchestrator', autoFallback: true, taskId: 'task-123' },
      paths, 'dev', 'revops-global',
    );

    expect(r.dispatched).toBe(true);
    expect(r.workerName).toMatch(/^codex-spillover-1-\d+$/);
    expect(r.limitClass).toBe('long_lock');

    expect(mockSpawnSync).toHaveBeenCalledOnce();
    const [cmd, args] = mockSpawnSync.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('cortextos');
    expect(args[0]).toBe('bus');
    expect(args[1]).toBe('spawn-worker');
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-4-7');
    expect(args).toContain('--parent');
    expect(args[args.indexOf('--parent') + 1]).toBe('orchestrator');
    expect(args).toContain('--dir');
    expect(args[args.indexOf('--dir') + 1]).toBe('/tmp/workdir');

    const events = readEventLines(tmpDir, 'dev');
    expect(events.some(e => e.event === 'codex_limit_hit')).toBe(true);
    expect(events.some(e => e.event === 'codex_failover_dispatched')).toBe(true);

    const dispatched = events.find(e => e.event === 'codex_failover_dispatched')!;
    const meta = dispatched.metadata as Record<string, unknown>;
    expect(meta.task_id).toBe('task-123');
    expect(meta.parent_agent).toBe('orchestrator');
    expect(meta.worker_name).toBe(r.workerName);
  });

  it('worker prompt includes terminate-worker and send-message instructions', async () => {
    const result = makeInput({ exitCode: 1, stderr: '429 exceeded retry limit' });
    await handleCodexFallback(
      result,
      { prompt: 'build the feature', dir: '/tmp', parentAgent: 'orchestrator', autoFallback: true },
      paths, 'dev', 'revops-global',
    );

    const [, args] = mockSpawnSync.mock.calls[0] as [string, string[]];
    const promptArg = args[args.indexOf('--prompt') + 1];
    expect(promptArg).toContain('build the feature');
    expect(promptArg).toContain('terminate-worker');
    expect(promptArg).toContain('send-message orchestrator');
  });

  it('dispatches spillover-2 with --home flag when claudeTeamHome is set', async () => {
    const result = makeInput({ exitCode: 1, stderr: '429 rate limit exceeded' });
    const r = await handleCodexFallback(
      result,
      { prompt: 'do work', dir: '/tmp/workdir', parentAgent: 'orchestrator', autoFallback: true, claudeTeamHome: '/home/user/.claude-team' },
      paths, 'dev', 'revops-global',
    );

    expect(r.dispatched).toBe(true);
    expect(mockSpawnSync).toHaveBeenCalledTimes(2);

    const calls = mockSpawnSync.mock.calls as [string, string[]][];
    const spillover1Args = calls[0][1];
    const spillover2Args = calls[1][1];

    // spillover-1: no --home flag
    expect(spillover1Args[2]).toMatch(/^codex-spillover-1-\d+$/);
    expect(spillover1Args).not.toContain('--home');

    // spillover-2: has --home flag pointing to team home
    expect(spillover2Args[2]).toMatch(/^codex-spillover-2-\d+$/);
    expect(spillover2Args).toContain('--home');
    expect(spillover2Args[spillover2Args.indexOf('--home') + 1]).toBe('/home/user/.claude-team');
  });

  it('spillover-2 emits codex_failover_dispatched with tier=spillover-2', async () => {
    const result = makeInput({ exitCode: 1, stderr: '429 rate limit exceeded' });
    await handleCodexFallback(
      result,
      { prompt: 'do work', dir: '/tmp', parentAgent: 'orchestrator', autoFallback: true, claudeTeamHome: '/home/user/.claude-team' },
      paths, 'dev', 'revops-global',
    );

    const events = readEventLines(tmpDir, 'dev');
    const dispatches = events.filter(e => e.event === 'codex_failover_dispatched');
    expect(dispatches).toHaveLength(2);
    expect(dispatches.some(e => (e.metadata as Record<string, unknown>).tier === 'spillover-1')).toBe(true);
    expect(dispatches.some(e => (e.metadata as Record<string, unknown>).tier === 'spillover-2')).toBe(true);

    const s2 = dispatches.find(e => (e.metadata as Record<string, unknown>).tier === 'spillover-2')!;
    expect((s2.metadata as Record<string, unknown>).claude_team_home).toBe('/home/user/.claude-team');
  });

  it('does not dispatch spillover-2 when claudeTeamHome is not set', async () => {
    const result = makeInput({ exitCode: 1, stderr: '429 rate limit exceeded' });
    await handleCodexFallback(
      result,
      { prompt: 'do work', dir: '/tmp', parentAgent: 'orchestrator', autoFallback: true },
      paths, 'dev', 'revops-global',
    );
    expect(mockSpawnSync).toHaveBeenCalledOnce();
  });

  it('dedup guard: second call with same taskId skips dispatch and emits codex_failover_dedup_skip', async () => {
    const result = makeInput({ exitCode: 1, stderr: '429 rate limit exceeded' });
    const opts = { prompt: 'do work', dir: '/tmp', parentAgent: 'orchestrator', autoFallback: true, taskId: 'task-dedup' };

    const r1 = await handleCodexFallback(result, opts, paths, 'dev', 'revops-global');
    expect(r1.dispatched).toBe(true);
    expect(mockSpawnSync).toHaveBeenCalledOnce();

    mockSpawnSync.mockClear();
    const r2 = await handleCodexFallback(result, opts, paths, 'dev', 'revops-global');
    expect(r2.dispatched).toBe(false);
    expect(mockSpawnSync).not.toHaveBeenCalled();

    const events = readEventLines(tmpDir, 'dev');
    expect(events.some(e => e.event === 'codex_failover_dedup_skip')).toBe(true);
  });

  it('dedup guard: different taskIds each get their own worker', async () => {
    const result = makeInput({ exitCode: 1, stderr: '429 rate limit exceeded' });

    await handleCodexFallback(result, { prompt: 'p', dir: '/tmp', parentAgent: 'orch', autoFallback: true, taskId: 'task-a' }, paths, 'dev', 'revops-global');
    await handleCodexFallback(result, { prompt: 'p', dir: '/tmp', parentAgent: 'orch', autoFallback: true, taskId: 'task-b' }, paths, 'dev', 'revops-global');

    expect(mockSpawnSync).toHaveBeenCalledTimes(2);
  });

  it('dedup guard: calls without taskId are not deduplicated', async () => {
    const result = makeInput({ exitCode: 1, stderr: '429 rate limit exceeded' });
    const opts = { prompt: 'do work', dir: '/tmp', parentAgent: 'orchestrator', autoFallback: true };

    await handleCodexFallback(result, opts, paths, 'dev', 'revops-global');
    await handleCodexFallback(result, opts, paths, 'dev', 'revops-global');

    expect(mockSpawnSync).toHaveBeenCalledTimes(2);
  });

  it('returns dispatched=false and emits dispatch_failed when spawn-worker exits non-zero', async () => {
    mockSpawnSync.mockReturnValueOnce({ status: 1 } as ReturnType<typeof import('child_process').spawnSync>);
    const result = makeInput({ exitCode: 1, stderr: '429 rate limit exceeded' });
    const r = await handleCodexFallback(
      result,
      { prompt: 'do work', dir: '/tmp', parentAgent: 'orchestrator', autoFallback: true, taskId: 'task-fail' },
      paths, 'dev', 'revops-global',
    );

    expect(r.dispatched).toBe(false);
    expect(r.limitClass).toBe('long_lock');

    const events = readEventLines(tmpDir, 'dev');
    expect(events.some(e => e.event === 'codex_limit_hit')).toBe(true);
    expect(events.some(e => e.event === 'codex_failover_dispatch_failed')).toBe(true);
    expect(events.some(e => e.event === 'codex_failover_dispatched')).toBe(false);

    const failed = events.find(e => e.event === 'codex_failover_dispatch_failed')!;
    const meta = failed.metadata as Record<string, unknown>;
    expect(meta.tier).toBe('spillover-1');
    expect(meta.task_id).toBe('task-fail');
  });
});
