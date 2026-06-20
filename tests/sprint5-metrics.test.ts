import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  collectMetrics,
  parseUsageOutput,
  storeUsageData,
  collectTelegramCommands,
  detectCronCollisions,
  appendCollisionHistory,
  loadCollisionHistory,
  type CronCollisionDetector,
} from '../src/bus/metrics.js';
import {
  defaultRoleType,
  defaultRoleConfig,
  resolveRoleConfig,
} from '../src/bus/role-config.js';

describe('Sprint 5: Observability & Metrics', () => {
  const testDir = join(tmpdir(), `cortextos-sprint5-${Date.now()}`);
  const ctxRoot = join(testDir, 'ctx');

  beforeEach(() => {
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    mkdirSync(join(ctxRoot, 'state'), { recursive: true });
    mkdirSync(join(ctxRoot, 'tasks'), { recursive: true });
    mkdirSync(join(ctxRoot, 'approvals', 'pending'), { recursive: true });
    mkdirSync(join(ctxRoot, 'analytics', 'events'), { recursive: true });
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  describe('collectMetrics', () => {
    it('returns empty report with no agents', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), '{}', 'utf-8');
      const report = collectMetrics(ctxRoot);
      expect(report.timestamp).toBeTruthy();
      expect(report.system.agents_total).toBe(0);
      expect(report.system.agents_healthy).toBe(0);
      expect(report.system.total_tasks_completed).toBe(0);
      expect(report.system.approvals_pending).toBe(0);
    });

    it('counts tasks per agent by status', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({ bot1: { enabled: true } }), 'utf-8');
      mkdirSync(join(ctxRoot, 'state', 'bot1'), { recursive: true });

      // Create tasks
      writeFileSync(join(ctxRoot, 'tasks', 'task1.json'), JSON.stringify({ assigned_to: 'bot1', status: 'completed' }), 'utf-8');
      writeFileSync(join(ctxRoot, 'tasks', 'task2.json'), JSON.stringify({ assigned_to: 'bot1', status: 'pending' }), 'utf-8');
      writeFileSync(join(ctxRoot, 'tasks', 'task3.json'), JSON.stringify({ assigned_to: 'bot1', status: 'in_progress' }), 'utf-8');
      writeFileSync(join(ctxRoot, 'tasks', 'task4.json'), JSON.stringify({ assigned_to: 'other', status: 'completed' }), 'utf-8');

      const report = collectMetrics(ctxRoot);
      expect(report.agents.bot1.tasks_completed).toBe(1);
      expect(report.agents.bot1.tasks_pending).toBe(1);
      expect(report.agents.bot1.tasks_in_progress).toBe(1);
      expect(report.system.total_tasks_completed).toBe(1);
    });

    it('detects healthy heartbeats', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({ bot1: { enabled: true } }), 'utf-8');
      const stateDir = join(ctxRoot, 'state', 'bot1');
      mkdirSync(stateDir, { recursive: true });

      // Fresh heartbeat
      writeFileSync(join(stateDir, 'heartbeat.json'), JSON.stringify({
        last_heartbeat: new Date().toISOString(),
      }), 'utf-8');

      const report = collectMetrics(ctxRoot);
      expect(report.agents.bot1.heartbeat_stale).toBe(false);
      expect(report.system.agents_healthy).toBe(1);
    });

    it('detects stale heartbeats', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({ bot1: { enabled: true } }), 'utf-8');
      const stateDir = join(ctxRoot, 'state', 'bot1');
      mkdirSync(stateDir, { recursive: true });

      // Old heartbeat (6 hours ago)
      const oldTime = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
      writeFileSync(join(stateDir, 'heartbeat.json'), JSON.stringify({
        last_heartbeat: oldTime,
      }), 'utf-8');

      const report = collectMetrics(ctxRoot);
      expect(report.agents.bot1.heartbeat_stale).toBe(true);
      expect(report.system.agents_healthy).toBe(0);
    });

    it('counts pending approvals', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), '{}', 'utf-8');
      writeFileSync(join(ctxRoot, 'approvals', 'pending', 'ap1.json'), '{}', 'utf-8');
      writeFileSync(join(ctxRoot, 'approvals', 'pending', 'ap2.json'), '{}', 'utf-8');

      const report = collectMetrics(ctxRoot);
      expect(report.system.approvals_pending).toBe(2);
    });

    // Regression: METRICS-ACCURACY-01. Archived tasks were counted into
    // tasks_pending/tasks_completed but excluded by listTasks, so the metric
    // overstated the live workload. Mirror listTasks: skip archived.
    it('skips archived tasks (matches listTasks)', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({ bot1: { enabled: true } }), 'utf-8');
      mkdirSync(join(ctxRoot, 'state', 'bot1'), { recursive: true });

      writeFileSync(join(ctxRoot, 'tasks', 'live.json'), JSON.stringify({ assigned_to: 'bot1', status: 'pending' }), 'utf-8');
      writeFileSync(join(ctxRoot, 'tasks', 'archived.json'), JSON.stringify({ assigned_to: 'bot1', status: 'pending', archived: true }), 'utf-8');
      writeFileSync(join(ctxRoot, 'tasks', 'archived_done.json'), JSON.stringify({ assigned_to: 'bot1', status: 'completed', archived: true }), 'utf-8');

      const report = collectMetrics(ctxRoot);
      expect(report.agents.bot1.tasks_pending).toBe(1);
      expect(report.agents.bot1.tasks_completed).toBe(0);
    });

    // Regression: METRICS-ACCURACY-01. Per-agent counts conflated cross-org
    // populations because the loop walked root + every orgs/*/tasks dir.
    // From an org-context call, only that org's tasks should be counted.
    it('scopes task aggregation to caller org only', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({ bot1: { enabled: true } }), 'utf-8');
      mkdirSync(join(ctxRoot, 'state', 'bot1'), { recursive: true });

      mkdirSync(join(ctxRoot, 'orgs', 'phytomedic', 'tasks'), { recursive: true });
      mkdirSync(join(ctxRoot, 'orgs', 'other', 'tasks'), { recursive: true });

      // Mis-routed default-pool task — must NOT count for an org-scoped run.
      writeFileSync(join(ctxRoot, 'tasks', 'orphan.json'), JSON.stringify({ assigned_to: 'bot1', status: 'pending' }), 'utf-8');
      // Cross-org task — must NOT count for phytomedic.
      writeFileSync(join(ctxRoot, 'orgs', 'other', 'tasks', 't.json'), JSON.stringify({ assigned_to: 'bot1', status: 'pending' }), 'utf-8');
      // Phytomedic's own — MUST count.
      writeFileSync(join(ctxRoot, 'orgs', 'phytomedic', 'tasks', 't.json'), JSON.stringify({ assigned_to: 'bot1', status: 'pending' }), 'utf-8');

      const phyto = collectMetrics(ctxRoot, 'phytomedic');
      expect(phyto.agents.bot1.tasks_pending).toBe(1);
    });

    // Same scoping rule for approvals — an org-scoped report shouldn't roll
    // up sibling-org approval queues.
    it('scopes approval count to caller org only', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), '{}', 'utf-8');
      mkdirSync(join(ctxRoot, 'orgs', 'phytomedic', 'approvals', 'pending'), { recursive: true });
      mkdirSync(join(ctxRoot, 'orgs', 'other', 'approvals', 'pending'), { recursive: true });

      writeFileSync(join(ctxRoot, 'approvals', 'pending', 'root.json'), '{}', 'utf-8');
      writeFileSync(join(ctxRoot, 'orgs', 'other', 'approvals', 'pending', 'a.json'), '{}', 'utf-8');
      writeFileSync(join(ctxRoot, 'orgs', 'phytomedic', 'approvals', 'pending', 'a.json'), '{}', 'utf-8');
      writeFileSync(join(ctxRoot, 'orgs', 'phytomedic', 'approvals', 'pending', 'b.json'), '{}', 'utf-8');

      const phyto = collectMetrics(ctxRoot, 'phytomedic');
      expect(phyto.system.approvals_pending).toBe(2);
    });

    it('writes report to analytics/reports/latest.json', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), '{}', 'utf-8');
      collectMetrics(ctxRoot);
      const reportPath = join(ctxRoot, 'analytics', 'reports', 'latest.json');
      expect(existsSync(reportPath)).toBe(true);
      const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
      expect(report.timestamp).toBeTruthy();
      expect(report.system).toBeDefined();
    });

    it('writes to org-scoped and system-wide reports when org specified', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), '{}', 'utf-8');
      mkdirSync(join(ctxRoot, 'orgs', 'testorg', 'analytics'), { recursive: true });
      collectMetrics(ctxRoot, 'testorg');

      expect(existsSync(join(ctxRoot, 'orgs', 'testorg', 'analytics', 'reports', 'latest.json'))).toBe(true);
      expect(existsSync(join(ctxRoot, 'analytics', 'reports', 'latest.json'))).toBe(true);
    });

    it('counts errors from event logs (severity-filtered)', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({ bot1: { enabled: true } }), 'utf-8');
      mkdirSync(join(ctxRoot, 'state', 'bot1'), { recursive: true });

      const today = new Date().toISOString().split('T')[0];
      const eventDir = join(ctxRoot, 'analytics', 'events', 'bot1');
      mkdirSync(eventDir, { recursive: true });
      writeFileSync(join(eventDir, `${today}.jsonl`), [
        '{"category":"error","event":"crash","severity":"error"}',
        '{"category":"info","event":"heartbeat","severity":"info"}',
        '{"category":"error","event":"timeout","severity":"error"}',
      ].join('\n'), 'utf-8');

      const report = collectMetrics(ctxRoot);
      expect(report.agents.bot1.errors_today).toBe(2);
    });

    it('does NOT count info-severity events even when category=error (Frank false-positive case)', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({ bot1: { enabled: true } }), 'utf-8');
      mkdirSync(join(ctxRoot, 'state', 'bot1'), { recursive: true });

      const today = new Date().toISOString().split('T')[0];
      const eventDir = join(ctxRoot, 'analytics', 'events', 'bot1');
      mkdirSync(eventDir, { recursive: true });
      // The exact pattern that polluted Frank's metrics: 7 info-severity
      // gap_detector_false_positive events emitted under category=error.
      const lines: string[] = [];
      for (let i = 0; i < 7; i++) {
        lines.push(`{"category":"error","event":"gap_detector_false_positive","severity":"info","metadata":{"i":${i}}}`);
      }
      // Plus one real error
      lines.push('{"category":"error","event":"actual_failure","severity":"error"}');
      writeFileSync(join(eventDir, `${today}.jsonl`), lines.join('\n'), 'utf-8');

      const report = collectMetrics(ctxRoot);
      expect(report.agents.bot1.errors_today).toBe(1);
    });

    it('counts critical-severity events as errors', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({ bot1: { enabled: true } }), 'utf-8');
      mkdirSync(join(ctxRoot, 'state', 'bot1'), { recursive: true });

      const today = new Date().toISOString().split('T')[0];
      const eventDir = join(ctxRoot, 'analytics', 'events', 'bot1');
      mkdirSync(eventDir, { recursive: true });
      writeFileSync(join(eventDir, `${today}.jsonl`), [
        '{"category":"error","event":"oom","severity":"critical"}',
        '{"category":"error","event":"crash","severity":"error"}',
      ].join('\n'), 'utf-8');

      const report = collectMetrics(ctxRoot);
      expect(report.agents.bot1.errors_today).toBe(2);
    });

    it('does NOT count warning-severity category=error events', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({ bot1: { enabled: true } }), 'utf-8');
      mkdirSync(join(ctxRoot, 'state', 'bot1'), { recursive: true });

      const today = new Date().toISOString().split('T')[0];
      const eventDir = join(ctxRoot, 'analytics', 'events', 'bot1');
      mkdirSync(eventDir, { recursive: true });
      writeFileSync(join(eventDir, `${today}.jsonl`), [
        '{"category":"error","event":"degraded","severity":"warning"}',
      ].join('\n'), 'utf-8');

      const report = collectMetrics(ctxRoot);
      expect(report.agents.bot1.errors_today).toBe(0);
    });

    it('ignores false positives where "category":"error" appears inside a metadata payload', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({ bot1: { enabled: true } }), 'utf-8');
      mkdirSync(join(ctxRoot, 'state', 'bot1'), { recursive: true });

      const today = new Date().toISOString().split('T')[0];
      const eventDir = join(ctxRoot, 'analytics', 'events', 'bot1');
      mkdirSync(eventDir, { recursive: true });
      // The substring `"category":"error"` is embedded in metadata, but the
      // actual top-level category is 'task'. The previous substring check
      // would have miscounted this; the parsed-JSON path correctly skips it.
      writeFileSync(join(eventDir, `${today}.jsonl`), [
        '{"category":"task","event":"taxonomy","severity":"info","metadata":{"taxonomy":"\\"category\\":\\"error\\""}}',
      ].join('\n'), 'utf-8');

      const report = collectMetrics(ctxRoot);
      expect(report.agents.bot1.errors_today).toBe(0);
    });

    it('skips malformed JSON lines without crashing', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({ bot1: { enabled: true } }), 'utf-8');
      mkdirSync(join(ctxRoot, 'state', 'bot1'), { recursive: true });

      const today = new Date().toISOString().split('T')[0];
      const eventDir = join(ctxRoot, 'analytics', 'events', 'bot1');
      mkdirSync(eventDir, { recursive: true });
      writeFileSync(join(eventDir, `${today}.jsonl`), [
        '{"category":"error","event":"real","severity":"error"}',
        'not-valid-json-at-all',
        '{broken json',
      ].join('\n'), 'utf-8');

      const report = collectMetrics(ctxRoot);
      expect(report.agents.bot1.errors_today).toBe(1);
    });
  });

  // --- Role-typed metrics (SYS-MET-01) ---
  describe('role-typed metrics', () => {
    it('emits a role block with sensible defaults for unknown agents (coding-assignee)', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({ randomBot: { enabled: true } }), 'utf-8');

      const report = collectMetrics(ctxRoot);
      expect(report.agents.randomBot.role.role_type).toBe('coding-assignee');
      expect(report.agents.randomBot.role.primary_kpi).toBe('assignee_completion_ratio');
      expect(report.agents.randomBot.role.anomalies).toEqual([]);
    });

    it('uses NAME_DEFAULTS to assign role_type without an explicit role.json', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({
        'frontend-dev': { enabled: true },
        'product-owner': { enabled: true },
        'devops-monitor': { enabled: true },
        'systems-analyst': { enabled: true },
      }), 'utf-8');

      const report = collectMetrics(ctxRoot);
      expect(report.agents['frontend-dev'].role.role_type).toBe('coding-assignee');
      expect(report.agents['product-owner'].role.role_type).toBe('authoring');
      expect(report.agents['devops-monitor'].role.role_type).toBe('inbox-triage');
      expect(report.agents['systems-analyst'].role.role_type).toBe('analyst-hybrid');
    });

    it('respects an explicit agents/<name>/role.json override', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({ 'frontend-dev': { enabled: true } }), 'utf-8');
      const agentDir = join(ctxRoot, 'agents', 'frontend-dev');
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(agentDir, 'role.json'), JSON.stringify({
        role_type: 'authoring',
        anomaly_thresholds: { pending_dispatch_age_p95_max_ms: 3_600_000 },
      }), 'utf-8');

      const report = collectMetrics(ctxRoot);
      expect(report.agents['frontend-dev'].role.role_type).toBe('authoring');
      // Partial override merges with type defaults
      expect(report.agents['frontend-dev'].role.primary_kpi).toBe('pending_dispatch_age_p95_ms');
    });

    it('falls back to name-default when role.json is malformed', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({ 'product-owner': { enabled: true } }), 'utf-8');
      const agentDir = join(ctxRoot, 'agents', 'product-owner');
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(agentDir, 'role.json'), 'not json at all', 'utf-8');

      const report = collectMetrics(ctxRoot);
      expect(report.agents['product-owner'].role.role_type).toBe('authoring');
    });

    it('falls back to name-default when role_type is invalid', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({ 'product-owner': { enabled: true } }), 'utf-8');
      const agentDir = join(ctxRoot, 'agents', 'product-owner');
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(agentDir, 'role.json'), JSON.stringify({ role_type: 'nonsense' }), 'utf-8');

      const report = collectMetrics(ctxRoot);
      expect(report.agents['product-owner'].role.role_type).toBe('authoring');
    });

    it('computes assignee completion_ratio from assigned tasks', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({ 'frontend-dev': { enabled: true } }), 'utf-8');
      writeFileSync(join(ctxRoot, 'tasks', 't1.json'), JSON.stringify({ assigned_to: 'frontend-dev', status: 'completed' }), 'utf-8');
      writeFileSync(join(ctxRoot, 'tasks', 't2.json'), JSON.stringify({ assigned_to: 'frontend-dev', status: 'completed' }), 'utf-8');
      writeFileSync(join(ctxRoot, 'tasks', 't3.json'), JSON.stringify({ assigned_to: 'frontend-dev', status: 'pending' }), 'utf-8');

      const report = collectMetrics(ctxRoot);
      const a = report.agents['frontend-dev'].role.assignee;
      expect(a.completed).toBe(2);
      expect(a.pending).toBe(1);
      expect(a.completion_ratio).toBeCloseTo(2 / 3, 5);
    });

    it('returns null completion_ratio when there is no work to ratio', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({ 'frontend-dev': { enabled: true } }), 'utf-8');

      const report = collectMetrics(ctxRoot);
      expect(report.agents['frontend-dev'].role.assignee.completion_ratio).toBeNull();
      // No anomaly should fire on null — the previous false-positive guard
      expect(report.agents['frontend-dev'].role.anomalies).not.toContain('assignee_low_completion_ratio');
    });

    it('counts authored tasks and pending_dispatch via created_by', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({ 'product-owner': { enabled: true } }), 'utf-8');
      const recent = new Date(Date.now() - 1000).toISOString();
      writeFileSync(join(ctxRoot, 'tasks', 't1.json'), JSON.stringify({
        created_by: 'product-owner', assigned_to: 'product-owner', status: 'pending', created_at: recent,
      }), 'utf-8');
      writeFileSync(join(ctxRoot, 'tasks', 't2.json'), JSON.stringify({
        created_by: 'product-owner', status: 'pending', created_at: recent,
      }), 'utf-8');
      writeFileSync(join(ctxRoot, 'tasks', 't3.json'), JSON.stringify({
        created_by: 'product-owner', assigned_to: 'frontend-dev', status: 'in_progress', created_at: recent,
      }), 'utf-8');

      const a = collectMetrics(ctxRoot).agents['product-owner'].role.authoring;
      expect(a.authored_total).toBe(3);
      // Self-assigned + unassigned both count as undispatched; assigned-to-other does not
      expect(a.pending_dispatch).toBe(2);
    });

    // SYS-MET-03: the trigger is now (pending_dispatch >= 3 AND p50 age > 3d) —
    // a genuinely BROAD + OLD backlog. p95 is info-only, not a trigger.
    it('fires authoring_dispatch_backlog on a broad old backlog (count>=3 AND p50>3d)', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({ 'product-owner': { enabled: true } }), 'utf-8');
      // 4 tasks, all 5 days old — median (p50) age well past the 3d floor.
      const old = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
      for (let i = 0; i < 4; i++) {
        writeFileSync(join(ctxRoot, 'tasks', `t${i}.json`), JSON.stringify({
          created_by: 'product-owner', status: 'pending', created_at: old,
        }), 'utf-8');
      }

      const role = collectMetrics(ctxRoot).agents['product-owner'].role;
      expect(role.authoring.pending_dispatch).toBe(4);
      expect(role.authoring.pending_dispatch_age_p50_ms).toBeGreaterThan(259_200_000);
      expect(role.anomalies).toContain('authoring_dispatch_backlog');
    });

    it('does NOT fire dispatch backlog on a 1-hour-old pending task', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({ 'product-owner': { enabled: true } }), 'utf-8');
      const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      writeFileSync(join(ctxRoot, 'tasks', 't1.json'), JSON.stringify({
        created_by: 'product-owner', status: 'pending', created_at: recent,
      }), 'utf-8');

      const role = collectMetrics(ctxRoot).agents['product-owner'].role;
      expect(role.anomalies).not.toContain('authoring_dispatch_backlog');
    });

    // SYS-MET-03 false-positive class 1 — p95 outlier with a fresh median.
    // The product-owner snapshot: p50≈0.1d (median fresh) but a single task
    // just over the 2d line drove p95≈2.1d. Under the old p95 trigger this fired;
    // under the count+p50 trigger it must not.
    it('does NOT fire on a single old outlier when the median is fresh (p95-outlier class)', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({ 'product-owner': { enabled: true } }), 'utf-8');
      const fresh = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h
      const old = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(); // 5d outlier
      for (let i = 0; i < 4; i++) {
        writeFileSync(join(ctxRoot, 'tasks', `fresh${i}.json`), JSON.stringify({
          created_by: 'product-owner', status: 'pending', created_at: fresh,
        }), 'utf-8');
      }
      writeFileSync(join(ctxRoot, 'tasks', 'outlier.json'), JSON.stringify({
        created_by: 'product-owner', status: 'pending', created_at: old,
      }), 'utf-8');

      const role = collectMetrics(ctxRoot).agents['product-owner'].role;
      expect(role.authoring.pending_dispatch).toBe(5); // count gate passes
      // p50 (median of 4 fresh + 1 old) is fresh → trigger must not fire
      expect(role.authoring.pending_dispatch_age_p50_ms).toBeLessThan(259_200_000);
      expect(role.anomalies).not.toContain('authoring_dispatch_backlog');
    });

    // SYS-MET-03: a lone stale task (count below min) must not fire either —
    // this is the old single-old-task behaviour, now correctly suppressed.
    it('does NOT fire on a single old task (count below min_count)', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({ 'product-owner': { enabled: true } }), 'utf-8');
      const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      writeFileSync(join(ctxRoot, 'tasks', 't1.json'), JSON.stringify({
        created_by: 'product-owner', status: 'pending', created_at: old,
      }), 'utf-8');

      const role = collectMetrics(ctxRoot).agents['product-owner'].role;
      expect(role.authoring.pending_dispatch).toBe(1);
      expect(role.anomalies).not.toContain('authoring_dispatch_backlog');
    });

    // SYS-MET-03 false-positive class 2 — SAT-FREEZE-held tasks. They are
    // genuinely old but intentionally held (held_reason set), so they must be
    // excluded from pending_dispatch + the percentiles and never fire — even
    // though, unmarked, they would be a broad old backlog.
    it('does NOT fire on intentionally-held tasks (held_reason set)', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({ 'product-owner': { enabled: true } }), 'utf-8');
      const old = new Date(Date.now() - 19 * 24 * 60 * 60 * 1000).toISOString();
      for (let i = 0; i < 4; i++) {
        writeFileSync(join(ctxRoot, 'tasks', `held${i}.json`), JSON.stringify({
          created_by: 'product-owner', status: 'pending', created_at: old,
          held_reason: 'saturation', held_note: 'FE queue > 30',
        }), 'utf-8');
      }

      const role = collectMetrics(ctxRoot).agents['product-owner'].role;
      // Excluded from pending_dispatch + ages, but still counted in authored_total.
      expect(role.authoring.authored_total).toBe(4);
      expect(role.authoring.pending_dispatch).toBe(0);
      expect(role.authoring.pending_dispatch_age_p50_ms).toBeNull();
      expect(role.anomalies).not.toContain('authoring_dispatch_backlog');
    });

    // SYS-MET-03 false-positive class 3 — [HUMAN]-parked tasks (awaiting a
    // human, not agent-routable) are held with held_reason='human' and excluded.
    it('excludes [HUMAN]-parked tasks (held_reason=human) from dispatch backlog', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({ 'product-owner': { enabled: true } }), 'utf-8');
      const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      // 3 human-parked (held) + 1 genuinely-routable old task → only 1 counts,
      // below min_count, so no fire. Proves held items don't pad the count.
      for (let i = 0; i < 3; i++) {
        writeFileSync(join(ctxRoot, 'tasks', `human${i}.json`), JSON.stringify({
          created_by: 'product-owner', status: 'pending', created_at: old, held_reason: 'human',
        }), 'utf-8');
      }
      writeFileSync(join(ctxRoot, 'tasks', 'routable.json'), JSON.stringify({
        created_by: 'product-owner', status: 'pending', created_at: old,
      }), 'utf-8');

      const role = collectMetrics(ctxRoot).agents['product-owner'].role;
      expect(role.authoring.pending_dispatch).toBe(1);
      expect(role.anomalies).not.toContain('authoring_dispatch_backlog');
    });

    it('does NOT fire low-completion-ratio on authoring roles (the original PO false-positive)', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({ 'product-owner': { enabled: true } }), 'utf-8');
      // 5 completed assignee, 22 pending assignee → ratio = 5/27 = 0.185, < 0.3 threshold.
      // But product-owner is `authoring`, so the assignee threshold must NOT apply.
      for (let i = 0; i < 5; i++) {
        writeFileSync(join(ctxRoot, 'tasks', `c${i}.json`), JSON.stringify({ assigned_to: 'product-owner', status: 'completed' }), 'utf-8');
      }
      for (let i = 0; i < 22; i++) {
        writeFileSync(join(ctxRoot, 'tasks', `p${i}.json`), JSON.stringify({ assigned_to: 'product-owner', status: 'pending' }), 'utf-8');
      }

      const role = collectMetrics(ctxRoot).agents['product-owner'].role;
      expect(role.anomalies).not.toContain('assignee_low_completion_ratio');
    });

    it('fires wip_cap_breach on coding-assignee with too many in_progress', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({ 'frontend-dev': { enabled: true } }), 'utf-8');
      for (let i = 0; i < 7; i++) {
        writeFileSync(join(ctxRoot, 'tasks', `ip${i}.json`), JSON.stringify({ assigned_to: 'frontend-dev', status: 'in_progress' }), 'utf-8');
      }

      const role = collectMetrics(ctxRoot).agents['frontend-dev'].role;
      expect(role.anomalies).toContain('assignee_wip_cap_breach');
      // Untitled tasks have no bundle key, so each counts standalone.
      expect(role.assignee.in_progress).toBe(7);
      expect(role.assignee.in_progress_effective).toBe(7);
    });

    it('bundle-collapses in_progress titles into 1 effort for wip_cap', () => {
      // PD calibration ask 2026-06-14: 7 `[OVERNIGHT-CRON-HEALTH ...]` tasks are
      // one coordinated effort, not seven. Raw count is preserved for transparency;
      // the threshold compares against the bundle-collapsed count.
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({ 'frontend-dev': { enabled: true } }), 'utf-8');
      const bundleTitles = [
        '[OVERNIGHT-CRON-HEALTH] Generic cron-silent-fail detector',
        '[OVERNIGHT-CRON-HEALTH PHASE-B-2] Retrofit remaining ~37 crons',
        '[OVERNIGHT-CRON-HEALTH] Variant retrofit pass 2',
        '[OVERNIGHT-CRON-HEALTH] Variant retrofit pass 3',
        '[OVERNIGHT-CRON-HEALTH] Variant retrofit pass 4',
        '[OVERNIGHT-CRON-HEALTH] Variant retrofit pass 5',
        '[OVERNIGHT-CRON-HEALTH] Variant retrofit pass 6',
      ];
      bundleTitles.forEach((title, i) => {
        writeFileSync(join(ctxRoot, 'tasks', `bundle${i}.json`), JSON.stringify({
          assigned_to: 'frontend-dev', status: 'in_progress', title,
        }), 'utf-8');
      });

      const role = collectMetrics(ctxRoot).agents['frontend-dev'].role;
      expect(role.assignee.in_progress).toBe(7); // raw preserved
      expect(role.assignee.in_progress_effective).toBe(1); // collapsed
      expect(role.anomalies).not.toContain('assignee_wip_cap_breach');
    });

    it('counts bundle + standalone tasks correctly for effective_wip', () => {
      // Realistic snapshot: one bundle of 4 + 3 standalone titled tasks =
      // 1 + 3 = 4 effective efforts. Default cap is 5 so no breach.
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({ 'frontend-dev': { enabled: true } }), 'utf-8');
      const titles = [
        '[B-2.x] Variant a',
        '[B-2.x] Variant b',
        '[B-2.x] Variant c',
        '[B-2.x] Variant d',
        '[CI-CALIBRATION-FIX] lint-rules-enforcement.yml',
        '[GAP-HERSTELLER-SPONSORING-STRIPE] Stripe Checkout Wire-Up',
        '[STRAIN-DI-3] upsertStrainFields FK validation',
      ];
      titles.forEach((title, i) => {
        writeFileSync(join(ctxRoot, 'tasks', `mix${i}.json`), JSON.stringify({
          assigned_to: 'frontend-dev', status: 'in_progress', title,
        }), 'utf-8');
      });

      const role = collectMetrics(ctxRoot).agents['frontend-dev'].role;
      expect(role.assignee.in_progress).toBe(7);
      expect(role.assignee.in_progress_effective).toBe(4);
      expect(role.anomalies).not.toContain('assignee_wip_cap_breach');
    });

    it('still breaches wip_cap when effective count exceeds threshold', () => {
      // 6 distinct bundles → effective_wip=6 > cap=5 → breach fires even though
      // every task is bracketed.
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({ 'frontend-dev': { enabled: true } }), 'utf-8');
      const titles = [
        '[ALPHA] one', '[BETA] two', '[GAMMA] three',
        '[DELTA] four', '[EPSILON] five', '[ZETA] six',
      ];
      titles.forEach((title, i) => {
        writeFileSync(join(ctxRoot, 'tasks', `dist${i}.json`), JSON.stringify({
          assigned_to: 'frontend-dev', status: 'in_progress', title,
        }), 'utf-8');
      });

      const role = collectMetrics(ctxRoot).agents['frontend-dev'].role;
      expect(role.assignee.in_progress).toBe(6);
      expect(role.assignee.in_progress_effective).toBe(6);
      expect(role.anomalies).toContain('assignee_wip_cap_breach');
    });

    it('suppresses wip_cap_breach when all excess tasks share the same bundle_id (healthy bundling)', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({ 'frontend-dev': { enabled: true } }), 'utf-8');
      // 7 in_progress, all sharing bundle_id='t-sequence' → largest group = 7
      // wip_cap=5, nonBundleCount = 7-7 = 0 < 5 → suppress
      for (let i = 0; i < 7; i++) {
        writeFileSync(join(ctxRoot, 'tasks', `ip${i}.json`), JSON.stringify({
          assigned_to: 'frontend-dev', status: 'in_progress', bundle_id: 't-sequence',
        }), 'utf-8');
      }

      const role = collectMetrics(ctxRoot).agents['frontend-dev'].role;
      expect(role.assignee.in_progress_bundle_max).toBe(7);
      expect(role.anomalies).not.toContain('assignee_wip_cap_breach');
    });

    it('suppresses wip_cap_breach when excess tasks share a common title prefix (≥3)', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({ 'frontend-dev': { enabled: true } }), 'utf-8');
      // 7 in_progress: 5 share [T-A..T-E] prefix, 2 are unrelated → bundleMax=5, nonBundle=2 < 5 → suppress
      for (let i = 0; i < 5; i++) {
        writeFileSync(join(ctxRoot, 'tasks', `bundle${i}.json`), JSON.stringify({
          assigned_to: 'frontend-dev', status: 'in_progress',
          title: `[AVL-FIX] task variant ${i}`,
        }), 'utf-8');
      }
      for (let i = 0; i < 2; i++) {
        writeFileSync(join(ctxRoot, 'tasks', `other${i}.json`), JSON.stringify({
          assigned_to: 'frontend-dev', status: 'in_progress',
          title: `[UNRELATED-${i}] standalone task`,
        }), 'utf-8');
      }

      const role = collectMetrics(ctxRoot).agents['frontend-dev'].role;
      expect(role.assignee.in_progress_bundle_max).toBe(5);
      expect(role.anomalies).not.toContain('assignee_wip_cap_breach');
    });

    it('fires wip_cap_breach when 7 in_progress tasks have 7 distinct bundle groups (scattered)', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({ 'frontend-dev': { enabled: true } }), 'utf-8');
      // 7 tasks, all with distinct title prefixes → bundleMax=1 (<3) → no suppression
      for (let i = 0; i < 7; i++) {
        writeFileSync(join(ctxRoot, 'tasks', `ip${i}.json`), JSON.stringify({
          assigned_to: 'frontend-dev', status: 'in_progress',
          title: `[TASK-${i}] unrelated work item`,
        }), 'utf-8');
      }

      const role = collectMetrics(ctxRoot).agents['frontend-dev'].role;
      expect(role.assignee.in_progress_bundle_max).toBe(1);
      expect(role.anomalies).toContain('assignee_wip_cap_breach');
    });

    it('analyst-hybrid carries BOTH assignee and authoring thresholds', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({ 'systems-analyst': { enabled: true } }), 'utf-8');
      // 6 in_progress (> 5 cap) AS assignee
      for (let i = 0; i < 6; i++) {
        writeFileSync(join(ctxRoot, 'tasks', `ip${i}.json`), JSON.stringify({ assigned_to: 'systems-analyst', status: 'in_progress' }), 'utf-8');
      }
      // 3 stale authored tasks (broad + old: count>=3 AND p50>3d) — SYS-MET-03
      const old = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
      for (let i = 0; i < 3; i++) {
        writeFileSync(join(ctxRoot, 'tasks', `auth${i}.json`), JSON.stringify({
          created_by: 'systems-analyst', status: 'pending', created_at: old,
        }), 'utf-8');
      }

      const role = collectMetrics(ctxRoot).agents['systems-analyst'].role;
      expect(role.role_type).toBe('analyst-hybrid');
      expect(role.anomalies).toContain('assignee_wip_cap_breach');
      expect(role.anomalies).toContain('authoring_dispatch_backlog');
    });

    it('inbox-triage counts category=inbox and inbox_*/request_* events', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({ 'devops-monitor': { enabled: true } }), 'utf-8');
      const today = new Date().toISOString().split('T')[0];
      const eventDir = join(ctxRoot, 'analytics', 'events', 'devops-monitor');
      mkdirSync(eventDir, { recursive: true });
      writeFileSync(join(eventDir, `${today}.jsonl`), [
        '{"category":"inbox","event":"telegram_message","severity":"info"}',
        '{"category":"action","event":"inbox_message_received","severity":"info"}',
        '{"category":"action","event":"request_received","severity":"info"}',
        '{"category":"action","event":"heartbeat","severity":"info"}',
      ].join('\n'), 'utf-8');

      const role = collectMetrics(ctxRoot).agents['devops-monitor'].role;
      expect(role.role_type).toBe('inbox-triage');
      expect(role.inbox_triage.requests_today).toBe(3);
      // p50 and classification_accuracy stay null pending the backfill pipeline
      expect(role.inbox_triage.response_p50_ms).toBeNull();
      expect(role.inbox_triage.classification_accuracy).toBeNull();
    });

    it('keeps legacy fields (tasks_completed/pending/in_progress) alongside the role block', () => {
      // Backwards-compat for existing dashboards reading the unified counters.
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({ bot1: { enabled: true } }), 'utf-8');
      writeFileSync(join(ctxRoot, 'tasks', 't1.json'), JSON.stringify({ assigned_to: 'bot1', status: 'completed' }), 'utf-8');
      writeFileSync(join(ctxRoot, 'tasks', 't2.json'), JSON.stringify({ assigned_to: 'bot1', status: 'pending' }), 'utf-8');

      const a = collectMetrics(ctxRoot).agents.bot1;
      expect(a.tasks_completed).toBe(1);
      expect(a.tasks_pending).toBe(1);
      expect(a.role.assignee.completed).toBe(1);
      expect(a.role.assignee.pending).toBe(1);
    });
  });

  describe('resolveRoleConfig', () => {
    it('returns name-default config when no role.json exists', () => {
      expect(defaultRoleType('frontend-dev')).toBe('coding-assignee');
      expect(defaultRoleType('product-owner')).toBe('authoring');
      expect(defaultRoleType('systems-analyst')).toBe('analyst-hybrid');
      expect(defaultRoleType('some-future-agent')).toBe('coding-assignee');
    });

    it('defaultRoleConfig returns a deep copy (mutating one does not bleed into another)', () => {
      const a = defaultRoleConfig('coding-assignee');
      a.anomaly_thresholds.assignee_completion_ratio_min = 0.99;
      const b = defaultRoleConfig('coding-assignee');
      expect(b.anomaly_thresholds.assignee_completion_ratio_min).toBe(0.3);
    });

    it('resolveRoleConfig prefers org-scoped role.json over root role.json', () => {
      const agent = 'frontend-dev';
      const rootDir = join(ctxRoot, 'agents', agent);
      mkdirSync(rootDir, { recursive: true });
      writeFileSync(join(rootDir, 'role.json'), JSON.stringify({ role_type: 'inbox-triage' }), 'utf-8');

      const orgDir = join(ctxRoot, 'orgs', 'myorg', 'agents', agent);
      mkdirSync(orgDir, { recursive: true });
      writeFileSync(join(orgDir, 'role.json'), JSON.stringify({ role_type: 'authoring' }), 'utf-8');

      expect(resolveRoleConfig(ctxRoot, agent).role_type).toBe('inbox-triage');
      expect(resolveRoleConfig(ctxRoot, agent, 'myorg').role_type).toBe('authoring');
    });
  });

  describe('parseUsageOutput', () => {
    it('parses session percentage', () => {
      const output = 'Current session\n  42%\n  Resets in 3h';
      const result = parseUsageOutput(output, 'testbot');
      expect(result.session.used_pct).toBe(42);
      expect(result.agent).toBe('testbot');
    });

    it('defaults to 0 when no match', () => {
      const result = parseUsageOutput('no usage data', 'testbot');
      expect(result.session.used_pct).toBe(0);
      expect(result.week_all_models.used_pct).toBe(0);
      expect(result.week_sonnet.used_pct).toBe(0);
    });

    it('includes timestamp', () => {
      const result = parseUsageOutput('', 'testbot');
      expect(result.timestamp).toBeTruthy();
      expect(new Date(result.timestamp).getTime()).toBeGreaterThan(0);
    });
  });

  describe('storeUsageData', () => {
    it('writes latest.json', () => {
      const data = {
        agent: 'testbot',
        timestamp: new Date().toISOString(),
        session: { used_pct: 50, resets: '3h' },
        week_all_models: { used_pct: 30, resets: '4d' },
        week_sonnet: { used_pct: 20 },
      };
      storeUsageData(ctxRoot, data);

      const latestPath = join(ctxRoot, 'state', 'usage', 'latest.json');
      expect(existsSync(latestPath)).toBe(true);
      const stored = JSON.parse(readFileSync(latestPath, 'utf-8'));
      expect(stored.agent).toBe('testbot');
      expect(stored.session.used_pct).toBe(50);
    });

    it('appends to daily JSONL', () => {
      const today = new Date().toISOString().split('T')[0];
      const data = {
        agent: 'testbot',
        timestamp: new Date().toISOString(),
        session: { used_pct: 50, resets: '' },
        week_all_models: { used_pct: 30, resets: '' },
        week_sonnet: { used_pct: 20 },
      };
      storeUsageData(ctxRoot, data);
      storeUsageData(ctxRoot, data); // second write

      const dailyPath = join(ctxRoot, 'state', 'usage', `${today}.jsonl`);
      expect(existsSync(dailyPath)).toBe(true);
      const lines = readFileSync(dailyPath, 'utf-8').trim().split('\n');
      expect(lines.length).toBe(2);
    });
  });

  describe('collectTelegramCommands', () => {
    it('collects commands from skills directory', () => {
      const scanDir = join(testDir, 'agent');
      const skillDir = join(scanDir, 'skills', 'autoresearch');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), [
        '---',
        'name: autoresearch',
        'description: Automated web research',
        '---',
        'Content',
      ].join('\n'), 'utf-8');

      const commands = collectTelegramCommands([scanDir]);
      expect(commands.length).toBe(1);
      expect(commands[0].command).toBe('autoresearch');
      expect(commands[0].description).toBe('Automated web research');
    });

    it('sanitizes command names', () => {
      const scanDir = join(testDir, 'agent2');
      const skillDir = join(scanDir, 'skills', 'cron-management');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: cron-management\ndescription: Manage crons\n---\n', 'utf-8');

      const commands = collectTelegramCommands([scanDir]);
      expect(commands[0].command).toBe('cron_management');
    });

    it('skips non-invocable skills', () => {
      const scanDir = join(testDir, 'agent3');
      const skillDir = join(scanDir, 'skills', 'internal');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: internal\ndescription: Internal only\nuser-invocable: false\n---\n', 'utf-8');

      const commands = collectTelegramCommands([scanDir]);
      expect(commands.length).toBe(0);
    });

    it('deduplicates commands across directories', () => {
      const dir1 = join(testDir, 'dir1');
      const dir2 = join(testDir, 'dir2');
      mkdirSync(join(dir1, 'skills', 'test-skill'), { recursive: true });
      mkdirSync(join(dir2, 'skills', 'test-skill'), { recursive: true });
      writeFileSync(join(dir1, 'skills', 'test-skill', 'SKILL.md'), '---\nname: test-skill\ndescription: First\n---\n', 'utf-8');
      writeFileSync(join(dir2, 'skills', 'test-skill', 'SKILL.md'), '---\nname: test-skill\ndescription: Second\n---\n', 'utf-8');

      const commands = collectTelegramCommands([dir1, dir2]);
      expect(commands.length).toBe(1);
      expect(commands[0].description).toBe('First'); // first wins
    });

    it('collects from .claude/commands/', () => {
      const scanDir = join(testDir, 'agent4');
      const cmdDir = join(scanDir, '.claude', 'commands');
      mkdirSync(cmdDir, { recursive: true });
      writeFileSync(join(cmdDir, 'deploy.md'), '---\nname: deploy\ndescription: Deploy the app\n---\n', 'utf-8');

      const commands = collectTelegramCommands([scanDir]);
      expect(commands.length).toBe(1);
      expect(commands[0].command).toBe('deploy');
    });

    it('handles missing directories gracefully', () => {
      const commands = collectTelegramCommands(['/nonexistent']);
      expect(commands.length).toBe(0);
    });

    it('truncates description to 256 chars', () => {
      const scanDir = join(testDir, 'agent5');
      const skillDir = join(scanDir, 'skills', 'verbose');
      mkdirSync(skillDir, { recursive: true });
      const longDesc = 'A'.repeat(300);
      writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: verbose\ndescription: ${longDesc}\n---\n`, 'utf-8');

      const commands = collectTelegramCommands([scanDir]);
      expect(commands[0].description.length).toBe(256);
    });

    // Issue #329: codex-runtime agents store slash commands under .codex/, not
    // .claude/. Without these scan paths, registerTelegramCommands sees zero
    // commands for codex agents and the Telegram setMyCommands call no-ops,
    // leaving codex bots with an empty slash menu.
    it('collects from .codex/prompts/ (issue #329)', () => {
      const scanDir = join(testDir, 'codex-agent-prompts');
      const promptsDir = join(scanDir, '.codex', 'prompts');
      mkdirSync(promptsDir, { recursive: true });
      writeFileSync(
        join(promptsDir, 'review.md'),
        '---\nname: review\ndescription: Review the staged diff\n---\n',
        'utf-8',
      );

      const commands = collectTelegramCommands([scanDir]);
      expect(commands.length).toBe(1);
      expect(commands[0].command).toBe('review');
      expect(commands[0].description).toBe('Review the staged diff');
    });

    it('collects from .codex/commands/ (issue #329)', () => {
      const scanDir = join(testDir, 'codex-agent-commands');
      const cmdDir = join(scanDir, '.codex', 'commands');
      mkdirSync(cmdDir, { recursive: true });
      writeFileSync(
        join(cmdDir, 'plan.md'),
        '---\nname: plan\ndescription: Draft a plan\n---\n',
        'utf-8',
      );

      const commands = collectTelegramCommands([scanDir]);
      expect(commands.length).toBe(1);
      expect(commands[0].command).toBe('plan');
    });

    it('merges codex + claude commands across both layouts (issue #329)', () => {
      const scanDir = join(testDir, 'mixed-agent');
      const codexDir = join(scanDir, '.codex', 'prompts');
      const claudeDir = join(scanDir, '.claude', 'commands');
      mkdirSync(codexDir, { recursive: true });
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(
        join(codexDir, 'codex-only.md'),
        '---\nname: codex_only\ndescription: Codex prompt\n---\n',
        'utf-8',
      );
      writeFileSync(
        join(claudeDir, 'claude-only.md'),
        '---\nname: claude_only\ndescription: Claude command\n---\n',
        'utf-8',
      );

      const cmds = collectTelegramCommands([scanDir]);
      const names = cmds.map((c) => c.command).sort();
      expect(names).toEqual(['claude_only', 'codex_only']);
    });
  });

  describe('detectCronCollisions (SYS-CRON-STAMPEDE-DETECTOR)', () => {
    // Anchor "now" so window filtering is deterministic.
    const NOW = Date.parse('2026-06-14T19:00:00Z');

    function writeCronState(agent: string, fires: Array<{ name: string; last_fire: string; interval?: string }>) {
      const stateAgent = join(ctxRoot, 'state', agent);
      mkdirSync(stateAgent, { recursive: true });
      writeFileSync(
        join(stateAgent, 'cron-state.json'),
        JSON.stringify({ updated_at: '2026-06-14T19:00:00Z', crons: fires }),
        'utf-8',
      );
    }

    it('returns empty detector with no state dir', () => {
      const det = detectCronCollisions(ctxRoot, { now: NOW });
      expect(det.source).toBe('cron-state-snapshot');
      expect(det.top_buckets).toEqual([]);
      expect(det.warn_buckets).toEqual([]);
      expect(det.alert_buckets).toEqual([]);
      expect(det.per_agent_stampedes).toEqual([]);
      expect(det.max_per_agent_fires).toBeNull();
      expect(det.anomalies).toEqual([]);
    });

    it('truncates to ISO minute bucket and aggregates fleet-wide', () => {
      writeCronState('agent-a', [
        { name: 'c1', last_fire: '2026-06-14T18:40:13.231Z' },
        { name: 'c2', last_fire: '2026-06-14T18:40:45.946Z' },
      ]);
      writeCronState('agent-b', [
        { name: 'c3', last_fire: '2026-06-14T18:40:02.398Z' },
      ]);

      const det = detectCronCollisions(ctxRoot, { now: NOW });
      const xx40 = det.top_buckets.find(b => b.minute_bucket === '2026-06-14T18:40Z');
      expect(xx40).toBeTruthy();
      expect(xx40!.fire_count).toBe(3);
      expect(xx40!.agent_breakdown).toEqual({ 'agent-a': 2, 'agent-b': 1 });
      expect(xx40!.cron_name_breakdown).toEqual({ c1: 1, c2: 1, c3: 1 });
    });

    it('reproduces 2026-06-14 xx:40Z 9-fire stampede as cron_stampede_agent', () => {
      // Faithful to the incident: 9 crons all firing at 18:40:xx on a single agent.
      const fires = [
        { name: 'upstream-watch',                last_fire: '2026-06-14T18:40:13.231Z' },
        { name: 'heartbeat',                     last_fire: '2026-06-14T18:40:02.398Z' },
        { name: 'cron-drift-watchdog',           last_fire: '2026-06-14T18:40:45.946Z' },
        { name: 'coding-standards-realtime-poll',last_fire: '2026-06-14T18:40:25.251Z' },
        { name: 'vault-sweep-hourly',            last_fire: '2026-06-14T18:40:31.000Z' },
        { name: 'pattern-graduator',             last_fire: '2026-06-14T18:40:08.000Z' },
        { name: 'morning-briefing',              last_fire: '2026-06-14T18:40:11.000Z' },
        { name: 'dashboard-sync',                last_fire: '2026-06-14T18:40:50.000Z' },
        { name: 'feedback-extractor',            last_fire: '2026-06-14T18:40:55.000Z' },
      ];
      writeCronState('cortextos-improver', fires);

      const det = detectCronCollisions(ctxRoot, { now: NOW });
      expect(det.anomalies).toContain('cron_stampede_agent');
      expect(det.anomalies).toContain('cron_stampede_fleet');     // 9 > fleet_alert (8)
      expect(det.alert_buckets.length).toBe(1);
      expect(det.alert_buckets[0].minute_bucket).toBe('2026-06-14T18:40Z');
      expect(det.alert_buckets[0].fire_count).toBe(9);
      expect(det.max_per_agent_fires?.agent).toBe('cortextos-improver');
      expect(det.max_per_agent_fires?.count).toBe(9);
      expect(det.max_per_agent_fires?.cron_names).toEqual(fires.map(f => f.name).sort());
    });

    it('fires fleet warn (>5) but not alert (>8) at exactly 6 fleet fires', () => {
      // 3 agents × 2 crons each at 18:40 → 6 fleet fires, 2/agent (not per-agent stampede).
      ['a','b','c'].forEach(a => writeCronState(`agent-${a}`, [
        { name: 'c1', last_fire: '2026-06-14T18:40:01.000Z' },
        { name: 'c2', last_fire: '2026-06-14T18:40:02.000Z' },
      ]));
      const det = detectCronCollisions(ctxRoot, { now: NOW });
      expect(det.warn_buckets.length).toBe(1);
      expect(det.warn_buckets[0].fire_count).toBe(6);
      expect(det.alert_buckets.length).toBe(0);
      expect(det.anomalies).toContain('cron_stampede_fleet');
      expect(det.anomalies).not.toContain('cron_stampede_agent');     // each agent fired 2 — exactly at warn (>2 required)
    });

    it('per-agent threshold uses strict inequality: count must exceed per_agent_warn', () => {
      writeCronState('agent-a', [
        { name: 'c1', last_fire: '2026-06-14T18:40:01.000Z' },
        { name: 'c2', last_fire: '2026-06-14T18:40:02.000Z' },
      ]);
      const det = detectCronCollisions(ctxRoot, { now: NOW, perAgentWarn: 2 });
      expect(det.per_agent_stampedes).toEqual([]);
      expect(det.anomalies).not.toContain('cron_stampede_agent');

      writeCronState('agent-a', [
        { name: 'c1', last_fire: '2026-06-14T18:40:01.000Z' },
        { name: 'c2', last_fire: '2026-06-14T18:40:02.000Z' },
        { name: 'c3', last_fire: '2026-06-14T18:40:03.000Z' },
      ]);
      const det2 = detectCronCollisions(ctxRoot, { now: NOW, perAgentWarn: 2 });
      expect(det2.per_agent_stampedes).toHaveLength(1);
      expect(det2.per_agent_stampedes[0].count).toBe(3);
    });

    it('ignores fires older than the window', () => {
      writeCronState('agent-a', [
        { name: 'old', last_fire: '2026-06-12T18:40:00.000Z' },     // 48h+ before NOW
        { name: 'recent', last_fire: '2026-06-14T18:40:00.000Z' },
      ]);
      const det = detectCronCollisions(ctxRoot, { now: NOW, windowHours: 24 });
      const bucketNames = det.top_buckets.flatMap(b => Object.keys(b.cron_name_breakdown));
      expect(bucketNames).toContain('recent');
      expect(bucketNames).not.toContain('old');
    });

    it('ignores future-dated fires (clock-skew defensive)', () => {
      writeCronState('agent-a', [
        { name: 'future', last_fire: '2026-06-14T19:30:00.000Z' },     // 30min after NOW
        { name: 'past', last_fire: '2026-06-14T18:40:00.000Z' },
      ]);
      const det = detectCronCollisions(ctxRoot, { now: NOW });
      const bucketNames = det.top_buckets.flatMap(b => Object.keys(b.cron_name_breakdown));
      expect(bucketNames).toContain('past');
      expect(bucketNames).not.toContain('future');
    });

    it('survives malformed cron-state.json files', () => {
      const stateAgent = join(ctxRoot, 'state', 'broken-agent');
      mkdirSync(stateAgent, { recursive: true });
      writeFileSync(join(stateAgent, 'cron-state.json'), '{not json', 'utf-8');

      writeCronState('healthy-agent', [
        { name: 'c1', last_fire: '2026-06-14T18:40:00.000Z' },
      ]);
      const det = detectCronCollisions(ctxRoot, { now: NOW });
      expect(det.top_buckets[0].cron_name_breakdown).toEqual({ c1: 1 });
    });

    it('is included in collectMetrics report under cron_collision_detector', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({ bot1: { enabled: true } }), 'utf-8');
      writeCronState('bot1', [
        { name: 'c1', last_fire: new Date(Date.now() - 60_000).toISOString() },
      ]);
      const report = collectMetrics(ctxRoot);
      expect(report.cron_collision_detector).toBeTruthy();
      expect(report.cron_collision_detector.source).toBe('cron-state-snapshot');
      expect(report.cron_collision_detector.thresholds.fleet_warn).toBe(5);
      expect(report.cron_collision_detector.thresholds.fleet_alert).toBe(8);
      expect(report.cron_collision_detector.thresholds.per_agent_warn).toBe(2);
    });
  });

  describe('cron-collision history persistence (SYS-CRON-STAMPEDE-DETECTOR-02)', () => {
    const NOW = Date.parse('2026-06-14T19:00:00Z');
    const histPath = () => join(ctxRoot, 'analytics', 'cron-collision-history.jsonl');

    function detector(over: Partial<CronCollisionDetector> = {}): CronCollisionDetector {
      return {
        collected_at: new Date(NOW).toISOString(),
        source: 'cron-state-snapshot',
        window_hours: 24,
        thresholds: { fleet_warn: 5, fleet_alert: 8, per_agent_warn: 2 },
        top_buckets: [{
          minute_bucket: '2026-06-14T18:40Z',
          fire_count: 9,
          agent_breakdown: { 'cortextos-improver': 9 },
          cron_name_breakdown: { heartbeat: 1, 'upstream-watch': 1 },
        }],
        warn_buckets: [],
        alert_buckets: [],
        per_agent_stampedes: [{
          agent: 'cortextos-improver', minute_bucket: '2026-06-14T18:40Z', count: 9, cron_names: ['heartbeat'],
        }],
        max_per_agent_fires: null,
        anomalies: ['cron_stampede_agent', 'cron_stampede_fleet'],
        ...over,
      };
    }

    function lines(): string[] {
      return readFileSync(histPath(), 'utf-8').split('\n').filter(l => l.trim());
    }

    it('materializes a slim NDJSON entry with the spec shape', () => {
      appendCollisionHistory(ctxRoot, detector(), undefined, { now: NOW });
      expect(existsSync(histPath())).toBe(true);
      const recs = lines().map(l => JSON.parse(l));
      expect(recs).toHaveLength(1);
      expect(recs[0]).toEqual({
        collected_at: '2026-06-14T19:00:00.000Z',
        source: 'collectMetrics',
        top_buckets: detector().top_buckets,
        per_agent_stampedes: detector().per_agent_stampedes,
        anomalies: detector().anomalies,
      });
    });

    it('appends without dedup — same minute twice yields two lines', () => {
      appendCollisionHistory(ctxRoot, detector(), undefined, { now: NOW });
      appendCollisionHistory(ctxRoot, detector(), undefined, { now: NOW });
      expect(lines()).toHaveLength(2);
    });

    it('prunes entries older than the retention window on write', () => {
      const old = detector({ collected_at: '2026-04-01T00:00:00.000Z' }); // ~74d before NOW
      appendCollisionHistory(ctxRoot, old, undefined, { now: NOW });
      expect(lines()).toHaveLength(1);
      // Next write prunes the stale entry, keeping only the fresh one.
      appendCollisionHistory(ctxRoot, detector(), undefined, { now: NOW, retentionDays: 30 });
      const recs = lines().map(l => JSON.parse(l));
      expect(recs).toHaveLength(1);
      expect(recs[0].collected_at).toBe('2026-06-14T19:00:00.000Z');
    });

    it('keeps an entry exactly at the 30d boundary', () => {
      const boundary = new Date(NOW - 30 * 86_400_000).toISOString();
      appendCollisionHistory(ctxRoot, detector({ collected_at: boundary }), undefined, { now: NOW });
      // Re-write at NOW: boundary entry is exactly 30d old → kept (prune is strict >).
      appendCollisionHistory(ctxRoot, detector(), undefined, { now: NOW, retentionDays: 30 });
      const stamps = lines().map(l => JSON.parse(l).collected_at);
      expect(stamps).toContain(boundary);
      expect(stamps).toHaveLength(2);
    });

    it('survives malformed pre-existing lines (skip-not-throw)', () => {
      mkdirSync(join(ctxRoot, 'analytics'), { recursive: true });
      writeFileSync(histPath(), '{not json\n' + JSON.stringify({ collected_at: new Date(NOW).toISOString(), source: 'collectMetrics' }) + '\n', 'utf-8');
      expect(() => appendCollisionHistory(ctxRoot, detector(), undefined, { now: NOW })).not.toThrow();
      // Malformed line dropped; valid old line + new entry remain.
      expect(lines()).toHaveLength(2);
    });

    it('loadCollisionHistory returns entries and filters by sinceMs', () => {
      appendCollisionHistory(ctxRoot, detector({ collected_at: '2026-06-10T00:00:00.000Z' }), undefined, { now: NOW });
      appendCollisionHistory(ctxRoot, detector({ collected_at: '2026-06-14T00:00:00.000Z' }), undefined, { now: NOW });

      const all = loadCollisionHistory(ctxRoot);
      expect(all).toHaveLength(2);

      const recent = loadCollisionHistory(ctxRoot, { sinceMs: Date.parse('2026-06-12T00:00:00Z') });
      expect(recent).toHaveLength(1);
      expect(recent[0].collected_at).toBe('2026-06-14T00:00:00.000Z');
    });

    it('loadCollisionHistory returns [] when no history file exists', () => {
      expect(loadCollisionHistory(ctxRoot)).toEqual([]);
    });

    it('loadCollisionHistory skips malformed lines', () => {
      mkdirSync(join(ctxRoot, 'analytics'), { recursive: true });
      writeFileSync(histPath(), 'garbage\n' + JSON.stringify({ collected_at: '2026-06-14T00:00:00.000Z', source: 'collectMetrics', top_buckets: [], per_agent_stampedes: [], anomalies: [] }) + '\n', 'utf-8');
      const recs = loadCollisionHistory(ctxRoot);
      expect(recs).toHaveLength(1);
      expect(recs[0].collected_at).toBe('2026-06-14T00:00:00.000Z');
    });

    it('collectMetrics writes the history file with >=1 entry (DONE-WHEN)', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({ bot1: { enabled: true } }), 'utf-8');
      const stateAgent = join(ctxRoot, 'state', 'bot1');
      mkdirSync(stateAgent, { recursive: true });
      writeFileSync(join(stateAgent, 'cron-state.json'), JSON.stringify({
        crons: [{ name: 'c1', last_fire: new Date(Date.now() - 60_000).toISOString() }],
      }), 'utf-8');

      collectMetrics(ctxRoot);
      expect(existsSync(histPath())).toBe(true);
      const recs = loadCollisionHistory(ctxRoot);
      expect(recs.length).toBeGreaterThanOrEqual(1);
      expect(recs[0].source).toBe('collectMetrics');
    });
  });
});
