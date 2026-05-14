/**
 * Unit tests for Chroma-deprecated kb-query behaviour.
 *
 * queryKnowledgeBase should use wiki-grep directly and never invoke the
 * retired MMRAG/Chroma/Python path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFileSync: vi.fn(), execSync: vi.fn() };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

const { execFileSync, execSync } = await import('child_process');
const { existsSync, readFileSync } = await import('fs');
const { queryKnowledgeBase } = await import('../../../src/bus/knowledge-base.js');

const mockExecFileSync = vi.mocked(execFileSync);
const mockExecSync = vi.mocked(execSync);
const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

const BASE_OPTS = {
  org: 'test-org',
  frameworkRoot: '/fake/framework',
  instanceId: 'test-instance',
  topK: 3,
};

const FAKE_PATHS = {} as Parameters<typeof queryKnowledgeBase>[0];

describe('queryKnowledgeBase — wiki-grep only', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses wiki-grep and does not call the retired embedding provider', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('git grep')) {
        return 'docs/kb.md:10:matching line\ndocs/kb.md:11-context line\n';
      }
      return '';
    });

    const result = queryKnowledgeBase(FAKE_PATHS, 'test query', BASE_OPTS);

    expect(result.collection).toBe('wiki-grep');
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0].doc_type).toBe('wiki-grep');
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('tags Open Brain thought mirror matches distinctly', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('git grep')) {
        return 'wiki/sources/thoughts/thought.md:5:the answer\n';
      }
      return '';
    });

    const result = queryKnowledgeBase(FAKE_PATHS, 'answer', BASE_OPTS);

    expect(result.results[0].doc_type).toBe('open-brain-thought');
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('returns empty when wiki dir does not exist', () => {
    mockExistsSync.mockReturnValue(false);

    const result = queryKnowledgeBase(FAKE_PATHS, 'anything', BASE_OPTS);

    expect(result.results).toHaveLength(0);
    expect(mockExecSync).not.toHaveBeenCalled();
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });
});
