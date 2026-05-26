import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { BusPaths } from '../../../src/types/index.js';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('../../../src/bus/rgos-mirror.js', () => ({
  mirrorEventToRgos: vi.fn().mockResolvedValue(undefined),
}));

import { execFileSync } from 'child_process';
import { runPrStuckWatcher } from '../../../src/bus/pr-stuck-watcher.js';

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

describe('pr-stuck-watcher', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cortextos-pr-stuck-'));
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('watches upstream grandamenium cortextos by default', () => {
    vi.mocked(execFileSync).mockReturnValue('[]');

    const result = runPrStuckWatcher(makePaths(root), 'codex', 'revops-global', {
      stuckHours: 1,
      alertHours: 1,
    });

    expect(result.watchedRepos).toContain('grandamenium/cortextos');
    expect(vi.mocked(execFileSync)).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['--repo', 'grandamenium/cortextos']),
      expect.any(Object),
    );
  });

  it('reports upstream grandamenium PRs without marking them auto-merge eligible', () => {
    vi.mocked(execFileSync).mockReturnValue(JSON.stringify([
      {
        number: 540,
        title: 'fix(agentops): artifact-back theta wave cron',
        url: 'https://github.com/grandamenium/cortextos/pull/540',
        createdAt: '2026-05-01T00:00:00Z',
        updatedAt: '2026-05-01T00:00:00Z',
        author: { login: 'revopsglobal' },
        reviewDecision: null,
        mergeStateStatus: 'CLEAN',
        statusCheckRollup: [{ conclusion: 'SUCCESS' }],
        labels: [],
        reviews: [],
      },
    ]));

    const result = runPrStuckWatcher(makePaths(root), 'codex', 'revops-global', {
      repos: ['grandamenium/cortextos'],
      stuckHours: 1,
      alertHours: 1,
    });

    expect(result.stuckPrs).toHaveLength(1);
    expect(result.stuckPrs[0]).toMatchObject({
      repo: 'grandamenium/cortextos',
      number: 540,
      autoMergeEligible: false,
    });
  });

  it('keeps awaiting-Greg PRs in the report but suppresses alerts', () => {
    vi.mocked(execFileSync).mockReturnValue(JSON.stringify([
      {
        number: 10,
        title: 'Blocked until product decision',
        url: 'https://github.com/acme/repo/pull/10',
        createdAt: '2026-05-01T00:00:00Z',
        updatedAt: '2026-05-01T00:00:00Z',
        author: { login: 'dev' },
        reviewDecision: null,
        mergeStateStatus: 'CLEAN',
        statusCheckRollup: [{ conclusion: 'SUCCESS' }],
        labels: [{ name: 'awaiting Greg' }],
        reviews: [],
      },
      {
        number: 11,
        title: 'Normal stuck PR',
        url: 'https://github.com/acme/repo/pull/11',
        createdAt: '2026-05-01T00:00:00Z',
        updatedAt: '2026-05-01T00:00:00Z',
        author: { login: 'dev' },
        reviewDecision: null,
        mergeStateStatus: 'CLEAN',
        statusCheckRollup: [{ conclusion: 'SUCCESS' }],
        labels: [],
        reviews: [],
      },
    ]));

    const outputDir = join(root, 'output');
    const result = runPrStuckWatcher(makePaths(root), 'codex', 'revops-global', {
      repos: ['acme/repo'],
      stuckHours: 1,
      alertHours: 1,
      outputDir,
    });

    expect(result.stuckPrs.map(pr => pr.number)).toEqual([10, 11]);
    expect(result.stuckPrs.find(pr => pr.number === 10)).toMatchObject({
      awaitingGreg: true,
      alertSuppressedReason: 'awaiting Greg',
    });
    expect(result.alertPrs.map(pr => pr.number)).toEqual([11]);

    const report = readFileSync(result.reportPath!, 'utf-8');
    expect(report).toContain('awaiting Greg');
    expect(report).toContain('Normal stuck PR');
  });
});
