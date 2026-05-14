/**
 * Unit tests for the codebase-scan bus module.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execSync: vi.fn() };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    readFileSync: vi.fn(),
    statSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

const { execSync } = await import('child_process');
const { existsSync, readdirSync, readFileSync, statSync, writeFileSync } = await import('fs');
const { scanTodoMarkers, findLargeFiles, deriveTopActionable, runCodebaseScan } = await import('../../../src/bus/codebase-scan.js');

const mockExecSync = vi.mocked(execSync);
const mockExistsSync = vi.mocked(existsSync);
const mockReaddirSync = vi.mocked(readdirSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockStatSync = vi.mocked(statSync);
const mockWriteFileSync = vi.mocked(writeFileSync);

beforeEach(() => {
  vi.resetAllMocks();
  mockExistsSync.mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('scanTodoMarkers', () => {
  it('returns empty array when srcDir does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    expect(scanTodoMarkers('/nonexistent')).toEqual([]);
  });

  it('parses grep output into CodebaseHit entries', () => {
    mockExecSync.mockReturnValue(
      'src/foo.ts:10:  // TODO: fix this later\nsrc/bar.ts:42:  // FIXME: broken edge case\n',
    );
    const hits = scanTodoMarkers('/fake/src');
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ line: 10, tag: 'TODO' });
    expect(hits[0].file).toContain('foo.ts');
    expect(hits[1]).toMatchObject({ line: 42, tag: 'FIXME' });
    expect(hits[1].file).toContain('bar.ts');
  });

  it('returns empty array when grep output is empty', () => {
    mockExecSync.mockReturnValue('');
    expect(scanTodoMarkers('/fake/src')).toEqual([]);
  });

  it('returns empty array when execSync throws', () => {
    mockExecSync.mockImplementation(() => { throw new Error('grep failed'); });
    expect(scanTodoMarkers('/fake/src')).toEqual([]);
  });
});

describe('findLargeFiles', () => {
  it('returns empty array when srcDir does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    expect(findLargeFiles('/nonexistent')).toEqual([]);
  });

  it('identifies files exceeding threshold', () => {
    mockReaddirSync.mockReturnValue(['big.ts', 'small.ts'] as ReturnType<typeof readdirSync>);
    mockStatSync.mockImplementation((p: unknown) => ({
      isDirectory: () => false,
    }) as ReturnType<typeof statSync>);
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (p!.toString().includes('big.ts')) return 'x\n'.repeat(600);
      return 'y\n'.repeat(10);
    });

    const result = findLargeFiles('/fake/src', 500);
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe('big.ts');
    expect(result[0].lines).toBeGreaterThan(500);
  });
});

describe('deriveTopActionable', () => {
  it('returns empty array when no hits and no large files', () => {
    expect(deriveTopActionable([], [])).toEqual([]);
  });

  it('flags FIXME as first item', () => {
    const hits = [{ file: 'a.ts', line: 1, tag: 'FIXME', text: '// FIXME: urgent' }];
    const items = deriveTopActionable(hits, []);
    expect(items[0]).toContain('FIXME');
  });

  it('flags large files', () => {
    const items = deriveTopActionable([], [{ file: 'bus.ts', lines: 800 }]);
    expect(items[0]).toContain('bus.ts');
    expect(items[0]).toContain('800');
  });

  it('returns at most 3 items', () => {
    const hits = [
      { file: 'a.ts', line: 1, tag: 'FIXME', text: '// FIXME' },
      { file: 'b.ts', line: 1, tag: 'TODO', text: '// TODO' },
      { file: 'b.ts', line: 2, tag: 'TODO', text: '// TODO 2' },
    ];
    const items = deriveTopActionable(hits, [{ file: 'c.ts', lines: 900 }]);
    expect(items.length).toBeLessThanOrEqual(3);
  });
});

describe('runCodebaseScan', () => {
  it('writes a markdown file and returns result with hits and largeFiles', () => {
    mockExecSync.mockReturnValue('src/x.ts:5:  // TODO: test\n');
    mockReaddirSync.mockReturnValue([] as ReturnType<typeof readdirSync>);

    const result = runCodebaseScan('/fake/framework', '/fake/output/2026-01-01-codebase-scan.md');

    expect(mockWriteFileSync).toHaveBeenCalledOnce();
    const [outPath, content] = mockWriteFileSync.mock.calls[0];
    expect(outPath).toBe('/fake/output/2026-01-01-codebase-scan.md');
    expect(typeof content).toBe('string');
    expect((content as string)).toContain('# Codebase Scan');
    expect(result.hits.length).toBeGreaterThan(0);
  });
});
