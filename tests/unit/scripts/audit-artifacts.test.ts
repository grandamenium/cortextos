import { describe, expect, it } from 'vitest';

import {
  buildScanRoots,
  collectRecentCandidates,
  collectVaultBasenames,
  findUnsavedArtifacts,
  runArtifactAudit,
  type ReadonlyFs,
  type ReadonlyStat,
} from '../../../scripts/audit-artifacts';

type Entry =
  | { type: 'dir' }
  | { type: 'file'; mtimeMs: number };

class MockStat implements ReadonlyStat {
  constructor(
    private readonly type: 'dir' | 'file',
    readonly mtimeMs: number,
  ) {}

  isDirectory(): boolean {
    return this.type === 'dir';
  }

  isFile(): boolean {
    return this.type === 'file';
  }
}

function createMockFs(entries: Record<string, Entry>): ReadonlyFs {
  return {
    existsSync(path: string): boolean {
      return path in entries;
    },
    readdirSync(path: string): string[] {
      const prefix = path.endsWith('/') ? path : `${path}/`;
      const names = new Set<string>();
      for (const entryPath of Object.keys(entries)) {
        if (!entryPath.startsWith(prefix)) continue;
        const remainder = entryPath.slice(prefix.length);
        if (!remainder) continue;
        const next = remainder.split('/')[0];
        if (next) names.add(next);
      }
      return [...names].sort();
    },
    statSync(path: string): ReadonlyStat {
      const entry = entries[path];
      if (!entry) throw new Error(`ENOENT: ${path}`);
      return new MockStat(entry.type, entry.type === 'file' ? entry.mtimeMs : 0);
    },
  };
}

describe('audit-artifacts', () => {
  const nowMs = Date.UTC(2026, 5, 9, 0, 0, 0);
  const recent = nowMs - 2 * 60 * 60 * 1000;
  const old = nowMs - 30 * 60 * 60 * 1000;
  const frameworkRoot = '/framework';
  const knowledgeSyncRoot = '/knowledge-sync';
  const tmpRoot = '/tmp';

  it('builds scan roots for /tmp, agent state/drafts, and knowledge-sync drafts/proposals', () => {
    const fs = createMockFs({
      '/framework': { type: 'dir' },
      '/framework/orgs': { type: 'dir' },
      '/framework/orgs/clearworksai': { type: 'dir' },
      '/framework/orgs/clearworksai/agents': { type: 'dir' },
      '/framework/orgs/clearworksai/agents/frank2': { type: 'dir' },
      '/framework/orgs/clearworksai/agents/codexer': { type: 'dir' },
      '/knowledge-sync': { type: 'dir' },
      '/knowledge-sync/raw': { type: 'dir' },
      '/knowledge-sync/raw/areas': { type: 'dir' },
      '/knowledge-sync/raw/areas/clearworks': { type: 'dir' },
      '/knowledge-sync/raw/areas/personal': { type: 'dir' },
    });

    const roots = buildScanRoots({ frameworkRoot, knowledgeSyncRoot, tmpRoot }, fs);
    const rootPaths = roots.map(root => root.path);

    expect(rootPaths).toContain('/tmp');
    expect(rootPaths).toContain('/framework/orgs/clearworksai/agents/frank2/state');
    expect(rootPaths).toContain('/framework/orgs/clearworksai/agents/frank2/drafts');
    expect(rootPaths).toContain('/framework/orgs/clearworksai/agents/codexer/state');
    expect(rootPaths).toContain('/framework/orgs/clearworksai/agents/codexer/drafts');
    expect(rootPaths).toContain('/knowledge-sync/raw/areas/clearworks/drafts');
    expect(rootPaths).toContain('/knowledge-sync/raw/areas/clearworks/proposals');
    expect(rootPaths).toContain('/knowledge-sync/raw/areas/personal/drafts');
    expect(rootPaths).toContain('/knowledge-sync/raw/areas/personal/proposals');
  });

  it('flags recent artifact-shaped files whose basenames never landed in raw/', () => {
    const fs = createMockFs({
      '/tmp': { type: 'dir' },
      '/tmp/report.pdf': { type: 'file', mtimeMs: recent },
      '/tmp/old-note.md': { type: 'file', mtimeMs: old },
      '/tmp/ignore.txt': { type: 'file', mtimeMs: recent },
      '/framework': { type: 'dir' },
      '/framework/orgs': { type: 'dir' },
      '/framework/orgs/clearworksai': { type: 'dir' },
      '/framework/orgs/clearworksai/agents': { type: 'dir' },
      '/framework/orgs/clearworksai/agents/frank2': { type: 'dir' },
      '/framework/orgs/clearworksai/agents/frank2/state': { type: 'dir' },
      '/framework/orgs/clearworksai/agents/frank2/state/nested': { type: 'dir' },
      '/framework/orgs/clearworksai/agents/frank2/state/nested/plan.md': { type: 'file', mtimeMs: recent },
      '/framework/orgs/clearworksai/agents/frank2/drafts': { type: 'dir' },
      '/framework/orgs/clearworksai/agents/frank2/drafts/landing.html': { type: 'file', mtimeMs: recent },
      '/knowledge-sync': { type: 'dir' },
      '/knowledge-sync/raw': { type: 'dir' },
      '/knowledge-sync/raw/areas': { type: 'dir' },
      '/knowledge-sync/raw/areas/clearworks': { type: 'dir' },
      '/knowledge-sync/raw/areas/clearworks/drafts': { type: 'dir' },
      '/knowledge-sync/raw/areas/clearworks/drafts/report.pdf': { type: 'file', mtimeMs: recent },
      '/knowledge-sync/raw/areas/clearworks/proposals': { type: 'dir' },
      '/knowledge-sync/raw/areas/clearworks/proposals/plan.md': { type: 'file', mtimeMs: recent },
    });

    const result = runArtifactAudit(
      { frameworkRoot, knowledgeSyncRoot, tmpRoot },
      nowMs,
      24,
      fs,
    );

    expect(result.candidates.map(candidate => candidate.basename)).toEqual([
      'landing.html',
      'plan.md',
      'report.pdf',
      'plan.md',
      'report.pdf',
    ]);
    expect([...result.vaultBasenames].sort()).toEqual(['plan.md', 'report.pdf']);
    expect(result.unsavedArtifacts.map(candidate => candidate.basename)).toEqual([
      'landing.html',
    ]);
    expect(result.unsavedArtifacts[0]?.path).toBe(
      '/framework/orgs/clearworksai/agents/frank2/drafts/landing.html',
    );
  });

  it('can be composed from candidate scan + vault match helpers', () => {
    const fs = createMockFs({
      '/tmp': { type: 'dir' },
      '/tmp/demo.md': { type: 'file', mtimeMs: recent },
      '/knowledge-sync': { type: 'dir' },
      '/knowledge-sync/raw': { type: 'dir' },
      '/knowledge-sync/raw/areas': { type: 'dir' },
      '/knowledge-sync/raw/areas/clearworks': { type: 'dir' },
      '/knowledge-sync/raw/areas/clearworks/proposals': { type: 'dir' },
      '/knowledge-sync/raw/areas/clearworks/proposals/demo.md': { type: 'file', mtimeMs: recent },
    });

    const candidates = collectRecentCandidates([{ path: '/tmp', recursive: false }], nowMs - 24 * 60 * 60 * 1000, fs);
    const vaultBasenames = collectVaultBasenames('/knowledge-sync/raw', fs);
    const unsaved = findUnsavedArtifacts(candidates, vaultBasenames);

    expect(candidates).toHaveLength(1);
    expect(vaultBasenames.has('demo.md')).toBe(true);
    expect(unsaved).toHaveLength(0);
  });
});
