import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseBundleManifest, decomposeBundle } from '../../../src/bus/bundle';
import { listTasks } from '../../../src/bus/task';
import type { BusPaths } from '../../../src/types';

const MANIFEST = [
  'bundle: B-rezept-flow',
  'goal: Patient orders a prescribed product end-to-end across all roles',
  '',
  '- role: manufacturer | assignee: backend-architect | title: createProduct sets draftStatus=pending',
  '- role: admin | assignee: backend-architect | title: approveProductDraft flips atomically | after: manufacturer',
  '- role: pharmacy | assignee: frontend-dev | title: einkauf uses the gated query | after: admin',
  '- role: patient | assignee: frontend-dev | title: catalog filters draftStatus=approved | after: admin',
  '- role: doctor | assignee: frontend-dev | title: review-only impact | after: admin',
].join('\n');

describe('bundle manifest parse + decompose', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-bundle-dec-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'agent1'),
      inflight: join(testDir, 'inflight', 'agent1'),
      processed: join(testDir, 'processed', 'agent1'),
      logDir: join(testDir, 'logs', 'agent1'),
      stateDir: join(testDir, 'state', 'agent1'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
  });
  afterEach(() => rmSync(testDir, { recursive: true, force: true }));

  it('parses bundle id, goal, and role sub-tasks with after deps', () => {
    const m = parseBundleManifest(MANIFEST);
    expect(m.bundle).toBe('B-rezept-flow');
    expect(m.goal).toMatch(/end-to-end/);
    expect(m.subtasks).toHaveLength(5);
    const admin = m.subtasks.find((s) => s.role === 'admin');
    expect(admin?.assignee).toBe('backend-architect');
    expect(admin?.after).toEqual(['manufacturer']);
    expect(m.subtasks.find((s) => s.role === 'manufacturer')?.after).toEqual([]);
  });

  it('decomposes into 5 tasks sharing the bundle_id, each with its role', () => {
    const res = decomposeBundle(paths, 'platform-director', 'phytomedic', MANIFEST);
    expect(res.skipped).toBe(false);
    expect(res.created).toHaveLength(5);

    const tasks = listTasks(paths, { bundle: 'B-rezept-flow' });
    expect(tasks).toHaveLength(5);
    expect(new Set(tasks.map((t) => t.role))).toEqual(
      new Set(['manufacturer', 'admin', 'pharmacy', 'patient', 'doctor']),
    );
    for (const t of tasks) expect(t.bundle_id).toBe('B-rezept-flow');
  });

  it('wires cross-role dependency edges (admin blocked_by manufacturer; pharmacy blocked_by admin)', () => {
    decomposeBundle(paths, 'platform-director', 'phytomedic', MANIFEST);
    const tasks = listTasks(paths, { bundle: 'B-rezept-flow' });
    const byRole = (r: string) => tasks.find((t) => t.role === r)!;
    const mfr = byRole('manufacturer');
    const admin = byRole('admin');
    const pharmacy = byRole('pharmacy');
    expect(mfr.blocked_by ?? []).toEqual([]);
    expect(admin.blocked_by).toEqual([mfr.id]);
    expect(pharmacy.blocked_by).toEqual([admin.id]);
    // symmetric reverse edge maintained
    expect(mfr.blocks).toContain(admin.id);
  });

  it('is idempotent — re-running creates nothing more', () => {
    const first = decomposeBundle(paths, 'platform-director', 'phytomedic', MANIFEST);
    expect(first.created).toHaveLength(5);
    const second = decomposeBundle(paths, 'platform-director', 'phytomedic', MANIFEST);
    expect(second.skipped).toBe(true);
    expect(second.existingCount).toBe(5);
    expect(listTasks(paths, { bundle: 'B-rezept-flow' })).toHaveLength(5);
  });

  it('throws when an after: references a role not in the manifest', () => {
    const bad = [
      'bundle: B-bad',
      '- role: pharmacy | title: depends on ghost | after: ghostrole',
    ].join('\n');
    expect(() => decomposeBundle(paths, 'a', 'phytomedic', bad)).toThrow(/missing role or forms a cycle|could not order/i);
  });

  it('throws on a manifest with no bundle id or no sub-tasks', () => {
    expect(() => decomposeBundle(paths, 'a', 'phytomedic', 'goal: nothing')).toThrow(/no .*bundle.* id/i);
    expect(() => decomposeBundle(paths, 'a', 'phytomedic', 'bundle: B-empty')).toThrow(/no role sub-tasks/i);
  });
});
