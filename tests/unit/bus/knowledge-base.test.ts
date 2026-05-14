import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const fsMocks = {
  existsSync: vi.fn(),
};

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: (...args: Parameters<typeof fsMocks.existsSync>) => fsMocks.existsSync(...args),
  };
});

const execSyncMock = vi.fn();
const execFileSyncMock = vi.fn();
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execSync: (...args: unknown[]) => execSyncMock(...args),
    execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
  };
});

vi.mock('../../../src/utils/org.js', () => ({
  normalizeOrgName: (_root: string, org: string) => org,
}));

const { queryKnowledgeBase, ingestKnowledgeBase } = await import('../../../src/bus/knowledge-base.js');

const dummyPaths = {
  stateDir: '/tmp/agent/state',
  logDir: '/tmp/agent/logs',
  ctxRoot: '/tmp/agent',
  instanceId: 'test',
  agentName: 'tester',
  org: 'TestOrg',
  inboxDir: '/tmp/agent/inbox',
  inflightDir: '/tmp/agent/inflight',
  processedDir: '/tmp/agent/processed',
  outboxDir: '/tmp/agent/outbox',
} as any;

const baseOptions = {
  org: 'TestOrg',
  agent: 'tester',
  frameworkRoot: '/home/test/cortextOS',
  instanceId: 'test',
};

let warnLog: string[] = [];
let logLog: string[] = [];
let originalWarn: typeof console.warn;
let originalLog: typeof console.log;

beforeEach(() => {
  fsMocks.existsSync.mockReset().mockReturnValue(true);
  execSyncMock.mockReset();
  execFileSyncMock.mockReset();

  warnLog = [];
  logLog = [];
  originalWarn = console.warn;
  originalLog = console.log;
  console.warn = (...args: unknown[]) => {
    warnLog.push(args.map((a) => String(a)).join(' '));
  };
  console.log = (...args: unknown[]) => {
    logLog.push(args.map((a) => String(a)).join(' '));
  };
});

afterEach(() => {
  console.warn = originalWarn;
  console.log = originalLog;
});

describe('ingestKnowledgeBase — Chroma deprecation', () => {
  it('warns and skips without invoking retired Python/Chroma path', () => {
    ingestKnowledgeBase(['/some/file.md'], baseOptions);

    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(warnLog.some((m) => m.includes('Chroma/MMRAG ingestion is deprecated'))).toBe(true);
    expect(logLog.some((m) => m.includes('/some/file.md'))).toBe(true);
  });
});

describe('queryKnowledgeBase — file-backed retrieval', () => {
  it('uses wiki-grep and returns matching docs', () => {
    execSyncMock.mockReturnValue('docs/kb.md:1:hit\n');

    const result = queryKnowledgeBase(dummyPaths, 'test query', baseOptions);

    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(execSyncMock).toHaveBeenCalled();
    expect(result.collection).toBe('wiki-grep');
    expect(result.results[0].content).toContain('hit');
  });

  it('returns empty if the wiki checkout is absent', () => {
    fsMocks.existsSync.mockReturnValue(false);

    const result = queryKnowledgeBase(dummyPaths, 'test query', baseOptions);

    expect(execSyncMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      results: [],
      total: 0,
      query: 'test query',
      collection: 'wiki-grep',
    });
  });
});
