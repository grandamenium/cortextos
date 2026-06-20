import { describe, it, expect } from 'vitest';
import { parseBundlePlan, computeBundleProgress, renderBundleSummary, renderBundleDetail } from '../../../src/bus/bundle-status';
import type { Task } from '../../../src/types';

/**
 * Bundle-status parses sprint-plan markdown and aggregates per-bundle task progress.
 *
 * The killer test case is mixed task-id matching: plan-doc lists 18-char prefixes,
 * bus stores full IDs with a _xxxxxxxx suffix. Without prefix-match support the
 * coordination-cascade #2 incident (2026-05-23) repeats. These tests pin that down.
 */
describe('bundle-status parser', () => {
  it('parses bundle headings and member task-ids', () => {
    const md = `
## Bundle 1 — INFRASTRUCTURE FOUNDATION 🏗️
**Owner**: backend-architect (dedicated)
**Sequenz**: strikt sequenziell

| # | Task | Was |
|---|---|---|
| 1 | \`task_1779317833003\` | **B2B-SCHEMA-1** manufacturerPharmacyContracts |
| 2 | \`task_1779317833130\` | **B2B-SCHEMA-3** pharmacyPlatformAgreements |

## Bundle 2 — DOCTOR-FLOW
**Owner**: backend-architect (50%) + frontend-dev (50%)

| # | Task | Was |
|---|---|---|
| 1 | \`task_1779317342596\` | **CRITICAL** Doctor-Verification 5 Bugs |
`;
    const bundles = parseBundlePlan(md);
    expect(bundles).toHaveLength(2);
    expect(bundles[0].number).toBe(1);
    expect(bundles[0].title).toContain('INFRASTRUCTURE FOUNDATION');
    expect(bundles[0].owner).toContain('backend-architect');
    expect(bundles[0].members).toHaveLength(2);
    expect(bundles[0].members[0].taskIdPrefix).toBe('task_1779317833003');
    expect(bundles[1].members[0].taskIdPrefix).toBe('task_1779317342596');
  });

  it('skips deferred members marked with -- in the first cell', () => {
    const md = `
## Bundle 1 — FOO
**Owner**: ba

| # | Task | Was |
|---|---|---|
| 1 | \`task_1234567890\` | active |
| -- | \`task_9999999999\` | VERSCHOBEN |
`;
    const bundles = parseBundlePlan(md);
    expect(bundles[0].members).toHaveLength(1);
    expect(bundles[0].members[0].taskIdPrefix).toBe('task_1234567890');
  });

  it('resolves prefix-match against full task IDs (cascade-#2 regression test)', () => {
    const bundles = [
      {
        number: 1,
        title: 'Test',
        owner: 'ba',
        members: [
          { taskIdPrefix: 'task_1779317833003', fullId: null, title: 'a', status: 'missing' as const },
          { taskIdPrefix: 'task_1779317833130', fullId: null, title: 'b', status: 'missing' as const },
          { taskIdPrefix: 'task_NEVER_EXISTS', fullId: null, title: 'c', status: 'missing' as const },
        ],
      },
    ];

    const tasks: Task[] = [
      makeTask('task_1779317833003_53366610', 'completed'),
      makeTask('task_1779317833130_30067683', 'in_progress'),
      makeTask('task_unrelated_99999', 'pending'),
    ];

    const progress = computeBundleProgress(bundles, tasks);
    expect(progress).toHaveLength(1);
    expect(progress[0].members[0].fullId).toBe('task_1779317833003_53366610');
    expect(progress[0].members[0].status).toBe('completed');
    expect(progress[0].members[1].fullId).toBe('task_1779317833130_30067683');
    expect(progress[0].members[1].status).toBe('in_progress');
    expect(progress[0].members[2].fullId).toBeNull();
    expect(progress[0].members[2].status).toBe('missing');

    expect(progress[0].totals.done).toBe(1);
    expect(progress[0].totals.inProgress).toBe(1);
    expect(progress[0].totals.missing).toBe(1);
    expect(progress[0].totals.total).toBe(3);
    expect(progress[0].percentDone).toBe(33);
  });

  it('renders a compact summary table', () => {
    const bundles = [{ number: 1, title: 'Foundation', owner: 'ba', members: [] }];
    const tasks: Task[] = [];
    const progress = computeBundleProgress(bundles, tasks);
    const out = renderBundleSummary(progress);
    expect(out).toContain('Bundle-Status (1 bundles)');
    expect(out).toContain('Foundation');
    expect(out).toContain('Totals: 0/0 done');
  });

  it('renders per-bundle detail with status icons', () => {
    const bundles = [
      {
        number: 1,
        title: 'Foundation',
        owner: 'ba',
        members: [{ taskIdPrefix: 'task_aaa', fullId: null, title: 'thing', status: 'missing' as const }],
      },
    ];
    const tasks: Task[] = [makeTask('task_aaa_111', 'completed')];
    const progress = computeBundleProgress(bundles, tasks);
    const out = renderBundleDetail(progress, 1);
    expect(out).toContain('Bundle 1 — Foundation');
    expect(out).toContain('✓');
    expect(out).toContain('task_aaa_111');
  });

  it('returns empty result for unknown bundle in detail view', () => {
    const out = renderBundleDetail([], 99);
    expect(out).toContain('No bundle #99 found');
  });
});

function makeTask(id: string, status: Task['status']): Task {
  return {
    id,
    title: 'test',
    description: '',
    priority: 'normal',
    status,
    assigned_to: 'ba',
    created_at: new Date().toISOString(),
    created_by: 'test',
    updated_at: new Date().toISOString(),
  } as Task;
}
