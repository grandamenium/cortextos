/**
 * tests/unit/bus/approval-count-consistency.test.ts — regression guard for #193.
 *
 * `collect-metrics` reported `approvals_pending` by naively counting *.json
 * files across the root + every org `approvals/pending` dir, while
 * `list-approvals` parsed a single org's dir. Neither filtered on the internal
 * `status` field, so a resolved-but-unmoved approval (or the same id appearing
 * under two scanned dirs) inflated the metric — producing a stale backlog count
 * that no `list-approvals` invocation could reconcile, triggering false alerts.
 *
 * The fix routes both surfaces through a single `collectAllPendingApprovals`
 * helper that scans the same locations, keeps only `status === 'pending'`, and
 * dedups by id — so the two commands agree by construction.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { collectAllPendingApprovals } from '../../../src/bus/approval';
import { collectMetrics } from '../../../src/bus/metrics';
import type { Approval, ApprovalStatus } from '../../../src/types';

let ctxRoot: string;

function approval(id: string, org: string, status: ApprovalStatus): Approval {
  return {
    id, title: `t-${id}`, requesting_agent: 'agent-x', org,
    category: 'other', status,
    description: 'd', created_at: '2026-04-20T09:00:00Z',
    updated_at: '2026-04-20T09:00:00Z', resolved_at: null, resolved_by: null,
  };
}

/** Drop an approval json into <ctxRoot>/<orgPath>/approvals/pending/. */
function dropPending(orgRelDir: string, a: Approval): void {
  const dir = join(ctxRoot, orgRelDir, 'approvals', 'pending');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${a.id}.json`), JSON.stringify(a));
}

beforeEach(() => {
  ctxRoot = mkdtempSync(join(tmpdir(), 'approval-count-'));
});

afterEach(() => {
  try { rmSync(ctxRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('approval count consistency (#193)', () => {
  it('counts only genuinely-pending approvals across root + all orgs', () => {
    dropPending('.', approval('a1', '', 'pending'));            // root, pending
    dropPending('orgs/alpha', approval('a2', 'alpha', 'pending'));
    dropPending('orgs/alpha', approval('a3', 'alpha', 'pending'));
    dropPending('orgs/beta', approval('a4', 'beta', 'pending'));

    const pending = collectAllPendingApprovals(ctxRoot);
    expect(pending.length).toBe(4);
  });

  it('excludes resolved-but-unmoved approvals lingering in pending/', () => {
    dropPending('orgs/alpha', approval('a1', 'alpha', 'pending'));
    dropPending('orgs/alpha', approval('a2', 'alpha', 'approved')); // stale leftover
    dropPending('orgs/alpha', approval('a3', 'alpha', 'rejected')); // stale leftover

    const pending = collectAllPendingApprovals(ctxRoot);
    expect(pending.map(a => a.id)).toEqual(['a1']);
  });

  it('dedups the same approval id appearing under multiple scanned dirs', () => {
    dropPending('.', approval('dup', '', 'pending'));
    dropPending('orgs/alpha', approval('dup', 'alpha', 'pending')); // same id, two dirs

    const pending = collectAllPendingApprovals(ctxRoot);
    expect(pending.length).toBe(1);
  });

  it('collect-metrics approvals_pending agrees with collectAllPendingApprovals', () => {
    dropPending('.', approval('a1', '', 'pending'));
    dropPending('orgs/alpha', approval('a2', 'alpha', 'pending'));
    dropPending('orgs/beta', approval('a3', 'beta', 'approved')); // stale, must not count

    const expected = collectAllPendingApprovals(ctxRoot).length;
    const report = collectMetrics(ctxRoot);
    expect(report.system.approvals_pending).toBe(expected);
    expect(report.system.approvals_pending).toBe(2);
  });

  it('returns empty (not error) when no approvals dirs exist', () => {
    expect(collectAllPendingApprovals(ctxRoot)).toEqual([]);
  });

  it('returns empty when org dirs exist but hold no pending approvals', () => {
    mkdirSync(join(ctxRoot, 'orgs', 'alpha', 'tasks'), { recursive: true }); // org present, no approvals/
    mkdirSync(join(ctxRoot, 'orgs', 'beta', 'approvals', 'pending'), { recursive: true }); // empty pending dir
    expect(collectAllPendingApprovals(ctxRoot)).toEqual([]);
  });

  it('does not throw and counts correctly when an approval has a malformed created_at', () => {
    const bad = approval('a1', 'alpha', 'pending');
    bad.created_at = 'not-a-date';
    dropPending('orgs/alpha', bad);
    dropPending('orgs/alpha', approval('a2', 'alpha', 'pending'));
    const pending = collectAllPendingApprovals(ctxRoot);
    expect(pending.length).toBe(2);
  });
});
