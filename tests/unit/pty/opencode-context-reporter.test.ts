import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFileSyncMock = vi.fn();
const atomicWriteSyncMock = vi.fn();

vi.mock('child_process', () => ({
  execFileSync: execFileSyncMock,
}));

vi.mock('../../../src/utils/atomic.js', () => ({
  atomicWriteSync: atomicWriteSyncMock,
}));

const { OpencodeContextReporter } = await import('../../../src/pty/opencode-context-reporter.js');

function makeRoot(): { root: string; stateDir: string; agentDir: string; opencodeRoot: string; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'opencode-context-reporter-'));
  const stateDir = join(root, 'state', 'opencode-agent');
  const agentDir = join(root, 'orgs', 'acme', 'agents', 'opencode-agent');
  const opencodeRoot = join(stateDir, 'opencode');
  const dbPath = join(opencodeRoot, 'data', 'opencode', 'opencode.db');
  mkdirSync(join(opencodeRoot, 'data', 'opencode'), { recursive: true });
  writeFileSync(dbPath, '');
  return { root, stateDir, agentDir, opencodeRoot, dbPath };
}

function writeModels(opencodeRoot: string, context: number): void {
  const modelsPath = join(opencodeRoot, 'cache', 'opencode', 'models.json');
  mkdirSync(join(opencodeRoot, 'cache', 'opencode'), { recursive: true });
  writeFileSync(modelsPath, JSON.stringify({
    'opencode-go': {
      models: {
        'deepseek-v4-pro': {
          limit: { context },
        },
      },
    },
  }));
}

function makeReporter(paths = makeRoot(), config = {}, startedAtMs?: number) {
  return new OpencodeContextReporter({
    stateDir: paths.stateDir,
    agentDir: paths.agentDir,
    workingDir: paths.agentDir,
    opencodeStateRoot: paths.opencodeRoot,
    config,
    startedAtMs,
  });
}

function lastPayload(): Record<string, unknown> {
  const [, payload] = atomicWriteSyncMock.mock.calls.at(-1) as [string, string];
  return JSON.parse(payload) as Record<string, unknown>;
}

beforeEach(() => {
  execFileSyncMock.mockReset();
  atomicWriteSyncMock.mockReset();
});

describe('OpencodeContextReporter', () => {
  it('writes context_status.json from the latest step-finish tokens and model cache cap', () => {
    const paths = makeRoot();
    writeModels(paths.opencodeRoot, 1_000_000);
    execFileSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      const sql = args.at(-1) ?? '';
      if (sql.includes('from session')) {
        return JSON.stringify([{
          id: 'ses-1',
          model: JSON.stringify({ providerID: 'opencode-go', id: 'deepseek-v4-pro' }),
        }]);
      }
      if (sql.includes('from part')) {
        return JSON.stringify([{
          total: 450665,
          input: 25,
          output: 5,
          reasoning: 75,
          cache_read: 450560,
          cache_write: 0,
          time_created: 100,
        }]);
      }
      return '[]';
    });

    const reporter = makeReporter(paths);
    expect(reporter.reportOnce()).toBe(true);

    expect(execFileSyncMock).toHaveBeenCalledWith('sqlite3', [
      '-readonly',
      '-json',
      paths.dbPath,
      expect.stringContaining('from session'),
    ], expect.any(Object));
    expect(atomicWriteSyncMock).toHaveBeenCalledWith(
      join(paths.stateDir, 'context_status.json'),
      expect.any(String),
    );
    expect(lastPayload()).toMatchObject({
      used_percentage: 45.0665,
      context_window_size: 1_000_000,
      exceeds_200k_tokens: true,
      current_usage: {
        input_tokens: 25,
        output_tokens: 5,
        cache_read_input_tokens: 450560,
        cache_creation_input_tokens: 0,
      },
      session_id: 'ses-1',
    });
  });

  it('falls back to message token rows when step-finish rows are absent', () => {
    const paths = makeRoot();
    writeModels(paths.opencodeRoot, 200_000);
    execFileSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      const sql = args.at(-1) ?? '';
      if (sql.includes('from session')) {
        return JSON.stringify([{
          id: 'ses-1',
          model: JSON.stringify({ providerID: 'opencode-go', id: 'deepseek-v4-pro' }),
        }]);
      }
      if (sql.includes('from part')) return '[]';
      if (sql.includes('from message')) {
        return JSON.stringify([{
          total: 50000,
          input: 30000,
          output: 2000,
          cache_read: 18000,
          cache_write: 0,
          time_created: 101,
        }]);
      }
      return '[]';
    });

    expect(makeReporter(paths).reportOnce()).toBe(true);
    expect(lastPayload()).toMatchObject({
      used_percentage: 25,
      context_window_size: 200_000,
      session_id: 'ses-1',
    });
  });

  it('uses opencode_context_cap when the model cache has no context limit', () => {
    const paths = makeRoot();
    execFileSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      const sql = args.at(-1) ?? '';
      if (sql.includes('from session')) {
        return JSON.stringify([{ id: 'ses-1', model: JSON.stringify({ providerID: 'missing', id: 'model' }) }]);
      }
      if (sql.includes('from part')) {
        return JSON.stringify([{ total: 40_000, input: 10, output: 20, cache_read: 30, cache_write: 40, time_created: 1 }]);
      }
      return '[]';
    });

    expect(makeReporter(paths, { opencode_context_cap: 100_000 }).reportOnce()).toBe(true);
    expect(lastPayload()).toMatchObject({
      used_percentage: 40,
      context_window_size: 100_000,
    });
  });

  it('skips duplicate writes for the same latest step', () => {
    const paths = makeRoot();
    writeModels(paths.opencodeRoot, 100_000);
    execFileSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      const sql = args.at(-1) ?? '';
      if (sql.includes('from session')) {
        return JSON.stringify([{
          id: 'ses-1',
          model: JSON.stringify({ providerID: 'opencode-go', id: 'deepseek-v4-pro' }),
        }]);
      }
      if (sql.includes('from part')) {
        return JSON.stringify([{ total: 10_000, input: 1, output: 2, cache_read: 3, cache_write: 4, time_created: 1 }]);
      }
      return '[]';
    });

    const reporter = makeReporter(paths);
    expect(reporter.reportOnce()).toBe(true);
    expect(reporter.reportOnce()).toBe(false);
    expect(atomicWriteSyncMock).toHaveBeenCalledTimes(1);
  });

  it('does not write when the database is missing or has no token rows', () => {
    const paths = makeRoot();
    execFileSyncMock.mockReturnValue('[]');

    expect(makeReporter(paths).reportOnce()).toBe(false);
    expect(atomicWriteSyncMock).not.toHaveBeenCalled();
  });

  it('can clear a stale high reading at fresh OpenCode startup before tokens exist', () => {
    const paths = makeRoot();
    const reporter = makeReporter(paths, { opencode_context_cap: 1_000_000 }, 2000);

    expect(reporter.resetContextStatus()).toBe(true);
    expect(lastPayload()).toMatchObject({
      used_percentage: 0,
      context_window_size: 1_000_000,
      exceeds_200k_tokens: false,
      current_usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      session_id: 'opencode-fresh-2000',
    });
  });

  it('does not fall back to an older high-token session after a fresh restart', () => {
    const paths = makeRoot();
    execFileSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      const sql = String(args.at(-1) ?? '');
      expect(sql).toContain('time_updated >= 2000');
      return '[]';
    });

    const reporter = makeReporter(paths, { opencode_context_cap: 1_000_000 }, 2000);
    expect(reporter.resetContextStatus()).toBe(true);
    expect(reporter.reportOnce()).toBe(false);
    expect(atomicWriteSyncMock).toHaveBeenCalledTimes(1);
    expect(lastPayload()).toMatchObject({
      used_percentage: 0,
      session_id: 'opencode-fresh-2000',
    });
  });

  it('overwrites stale context with a neutral active-session status before the first token row', () => {
    const paths = makeRoot();
    execFileSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      const sql = String(args.at(-1) ?? '');
      if (sql.includes('from session')) {
        return JSON.stringify([{ id: 'ses-fresh', model: null }]);
      }
      if (sql.includes('from part') || sql.includes('from message')) {
        return '[]';
      }
      return '[]';
    });

    const reporter = makeReporter(paths, { opencode_context_cap: 1_000_000 }, 2000);
    expect(reporter.reportOnce()).toBe(true);
    expect(lastPayload()).toMatchObject({
      used_percentage: 0,
      context_window_size: 1_000_000,
      exceeds_200k_tokens: false,
      session_id: 'ses-fresh',
    });
  });
});
