import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Path-aware fs mocks. existsSync is the one we actually drive per-test:
// it returns true for any path EXCEPT the MMRAG_CONFIG one (when the test
// wants to simulate a missing config) so loadSecretsEnv and other path
// lookups still work normally inside the module under test.
const fsMocks = {
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  mkdirSync: vi.fn(),
};

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: (...args: Parameters<typeof fsMocks.existsSync>) => fsMocks.existsSync(...args),
    readFileSync: (...args: Parameters<typeof fsMocks.readFileSync>) => fsMocks.readFileSync(...args),
    mkdirSync: (...args: Parameters<typeof fsMocks.mkdirSync>) => fsMocks.mkdirSync(...args),
  };
});

// Mock execFileSync so we can assert whether it was called (and optionally
// simulate a successful python response).
const execFileSyncMock = vi.fn();
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
  };
});

// Mock normalizeOrgName to a passthrough identity — we are not testing org
// normalization here, that has its own dedicated test file.
vi.mock('../../../src/utils/org.js', () => ({
  normalizeOrgName: (_root: string, org: string) => org,
}));

const { queryKnowledgeBase, ingestKnowledgeBase, reindexKnowledgeBase } = await import('../../../src/bus/knowledge-base.js');

// Minimal BusPaths stub — knowledge-base.ts doesn't actually USE the paths
// object at call time, just the options/env it constructs.
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
let originalWarn: typeof console.warn;
let logLog: string[] = [];
let originalLog: typeof console.log;

beforeEach(() => {
  fsMocks.existsSync.mockReset();
  fsMocks.readFileSync.mockReset().mockReturnValue('');
  fsMocks.mkdirSync.mockReset();
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

/**
 * Helper: make existsSync return false ONLY for paths that end with
 * knowledge-base/config.json (i.e. the MMRAG_CONFIG file), true for everything
 * else. Simulates a freshly-created agent with no KB configured yet.
 */
function mockMissingKbConfig(): void {
  fsMocks.existsSync.mockImplementation((p: any) => {
    const path = String(p);
    if (path.endsWith('/knowledge-base/config.json')) return false;
    return true;
  });
}

/**
 * Helper: make existsSync return true for everything, simulating a fully
 * configured KB with config.json present on disk.
 */
function mockConfiguredKb(): void {
  fsMocks.existsSync.mockImplementation(() => true);
}

describe('ingestKnowledgeBase — graceful missing-config', () => {
  it('missing config: warn + return cleanly, execFileSync NEVER called', () => {
    mockMissingKbConfig();

    // Must NOT throw. Previously this path threw an unhandled execFileSync
    // error that dumped a Node stack trace on top of the python stderr.
    expect(() =>
      ingestKnowledgeBase(['/some/file.md'], baseOptions),
    ).not.toThrow();

    expect(execFileSyncMock).not.toHaveBeenCalled();
    // Warn must include the org name AND an actionable hint ("run setup").
    expect(warnLog.some((m) => m.includes('TestOrg') && /run setup/i.test(m))).toBe(true);
    // Warn must carry the [kb] prefix so operators can filter log lines.
    expect(warnLog.some((m) => m.includes('[kb]'))).toBe(true);
  });

  it('config present: execFileSync IS called with the mmrag ingest args', () => {
    mockConfiguredKb();
    execFileSyncMock.mockReturnValue('');

    ingestKnowledgeBase(['/some/file.md'], baseOptions);

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    // First positional arg is the python path, second is the argv array.
    const [pythonPath, argv] = execFileSyncMock.mock.calls[0] as [string, string[], object];
    expect(String(pythonPath)).toMatch(/python/);
    expect(argv).toEqual(expect.arrayContaining(['ingest', '/some/file.md']));
    // Happy path emits no [kb] warning.
    expect(warnLog.filter((m) => m.includes('[kb]'))).toHaveLength(0);
  });
});

describe('queryKnowledgeBase — graceful missing-config', () => {
  it('missing config: warn + return empty KBQueryResponse, execFileSync NEVER called', () => {
    mockMissingKbConfig();

    const result = queryKnowledgeBase(dummyPaths, 'what is cortextos?', baseOptions);

    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      results: [],
      total: 0,
      query: 'what is cortextos?',
      collection: 'shared-TestOrg',
    });
    expect(warnLog.some((m) => m.includes('TestOrg') && /run setup/i.test(m))).toBe(true);
    expect(warnLog.some((m) => m.includes('[kb]'))).toBe(true);
  });

  it('config present: execFileSync IS called, happy-path query returns results', () => {
    mockConfiguredKb();
    // Mock mmrag.py --json output: a JSON blob with one result.
    execFileSyncMock.mockReturnValue(
      JSON.stringify({
        results: [
          { content: 'hit', similarity: 0.9, source: 'foo.md', type: 'markdown' },
        ],
      }),
    );

    const result = queryKnowledgeBase(dummyPaths, 'test query', baseOptions);

    expect(execFileSyncMock).toHaveBeenCalled();
    expect(result.total).toBeGreaterThan(0);
    expect(result.results[0].content).toBe('hit');
    // Happy path emits no [kb] warning.
    expect(warnLog.filter((m) => m.includes('[kb]'))).toHaveLength(0);
  });
});

describe('queryKnowledgeBase — rerank wiring', () => {
  it('default: does NOT pass --no-rerank or --threshold (config decides)', () => {
    mockConfiguredKb();
    execFileSyncMock.mockReturnValue('{"results": []}');

    queryKnowledgeBase(dummyPaths, 'q', baseOptions);

    const [, argv] = execFileSyncMock.mock.calls[0] as [string, string[], object];
    expect(argv).not.toContain('--no-rerank');
    expect(argv).not.toContain('--threshold');
  });

  it('rerank: false passes --no-rerank without forcing a threshold (org config owns the default)', () => {
    mockConfiguredKb();
    execFileSyncMock.mockReturnValue('{"results": []}');

    queryKnowledgeBase(dummyPaths, 'q', { ...baseOptions, rerank: false });

    const [, argv] = execFileSyncMock.mock.calls[0] as [string, string[], object];
    expect(argv).toContain('--no-rerank');
    // The wrapper must NOT override the org's configured similarity_threshold
    expect(argv).not.toContain('--threshold');
  });

  it('scope=all merged results are sorted by score, best first', () => {
    mockConfiguredKb();
    // Two collections (shared + agent): shared returns a low-scoring hit,
    // the agent collection returns a high-scoring one.
    execFileSyncMock
      .mockReturnValueOnce(JSON.stringify({
        results: [{ content: 'low', similarity: 0.2, source: 'low.md', type: 'text' }],
      }))
      .mockReturnValueOnce(JSON.stringify({
        reranked: true,
        results: [{ content: 'high', similarity: 0.4, rerank_score: 0.9, source: 'high.md', type: 'text' }],
      }));

    const result = queryKnowledgeBase(dummyPaths, 'q', { ...baseOptions, scope: 'all' });

    expect(result.results.map((r) => r.source_file)).toEqual(['high.md', 'low.md']);
    expect(result.results[0].score).toBe(0.9);
  });

  it('explicit threshold IS passed through', () => {
    mockConfiguredKb();
    execFileSyncMock.mockReturnValue('{"results": []}');

    queryKnowledgeBase(dummyPaths, 'q', { ...baseOptions, threshold: 0.42 });

    const [, argv] = execFileSyncMock.mock.calls[0] as [string, string[], object];
    const idx = (argv as string[]).indexOf('--threshold');
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe('0.42');
  });

  it('rerank_score is preferred over cosine similarity as the result score', () => {
    mockConfiguredKb();
    execFileSyncMock.mockReturnValue(
      JSON.stringify({
        reranked: true,
        results: [
          { content: 'hit', similarity: 0.3, rerank_score: 0.95, source: 'GOALS.md', type: 'text' },
        ],
      }),
    );

    const result = queryKnowledgeBase(dummyPaths, 'agent goals', baseOptions);

    expect(result.results[0].score).toBe(0.95);
    expect(result.results[0].rerank_score).toBe(0.95);
    expect(result.reranked).toBe(true);
  });

  it('without rerank, cosine similarity remains the score', () => {
    mockConfiguredKb();
    execFileSyncMock.mockReturnValue(
      JSON.stringify({
        reranked: false,
        results: [
          { content: 'hit', similarity: 0.68, source: 'GOALS.md', type: 'text' },
        ],
      }),
    );

    const result = queryKnowledgeBase(dummyPaths, 'agent goals', baseOptions);

    expect(result.results[0].score).toBe(0.68);
    expect(result.results[0].rerank_score).toBeUndefined();
    expect(result.reranked).toBe(false);
  });
});

describe('reindexKnowledgeBase — provider migration', () => {
  it('missing config: warn + return cleanly, execFileSync NEVER called', () => {
    mockMissingKbConfig();

    expect(() =>
      reindexKnowledgeBase(baseOptions),
    ).not.toThrow();

    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(warnLog.some((m) => m.includes('TestOrg') && /run setup/i.test(m))).toBe(true);
    expect(warnLog.some((m) => m.includes('[kb]'))).toBe(true);
  });

  it('config present: execFileSync called with mmrag reindex args', () => {
    mockConfiguredKb();
    execFileSyncMock.mockReturnValue('');

    reindexKnowledgeBase(baseOptions);

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    const [pythonPath, argv] = execFileSyncMock.mock.calls[0] as [string, string[], object];
    expect(String(pythonPath)).toMatch(/python/);
    expect(argv).toEqual(expect.arrayContaining(['reindex']));
    expect(argv).not.toContain('--collection');
  });

  it('specific collection: passes --collection to mmrag.py', () => {
    mockConfiguredKb();
    execFileSyncMock.mockReturnValue('');

    reindexKnowledgeBase({ ...baseOptions, collection: 'agent-james' });

    const [, argv] = execFileSyncMock.mock.calls[0] as [string, string[], object];
    expect(argv).toEqual(expect.arrayContaining(['reindex', '--collection', 'agent-james']));
  });
});

describe('kb warn messages — UX invariants', () => {
  it('both warn messages name the org and suggest "run setup"', () => {
    // Drive ingest path
    mockMissingKbConfig();
    ingestKnowledgeBase(['/f.md'], { ...baseOptions, org: 'SpecificOrg' });
    // Drive query path
    mockMissingKbConfig();
    queryKnowledgeBase(dummyPaths, 'q', { ...baseOptions, org: 'SpecificOrg' });

    // At least one warn per call site, each containing the org name + hint
    const specificOrgWarns = warnLog.filter((m) => m.includes('SpecificOrg'));
    expect(specificOrgWarns.length).toBeGreaterThanOrEqual(2);
    expect(specificOrgWarns.every((m) => /run setup/i.test(m))).toBe(true);
  });
});
