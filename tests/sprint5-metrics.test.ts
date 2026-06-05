import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  collectMetrics,
  parseUsageOutput,
  storeUsageData,
  collectTelegramCommands,
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

    it('fires authoring_dispatch_backlog when p95 age > 48h', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({ 'product-owner': { enabled: true } }), 'utf-8');
      // 5 days ago — well past 48h
      const old = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
      writeFileSync(join(ctxRoot, 'tasks', 't1.json'), JSON.stringify({
        created_by: 'product-owner', status: 'pending', created_at: old,
      }), 'utf-8');

      const report = collectMetrics(ctxRoot);
      const role = report.agents['product-owner'].role;
      expect(role.authoring.pending_dispatch_age_p95_ms).toBeGreaterThan(172_800_000);
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
    });

    it('analyst-hybrid carries BOTH assignee and authoring thresholds', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({ 'systems-analyst': { enabled: true } }), 'utf-8');
      // 6 in_progress (> 5 cap) AS assignee
      for (let i = 0; i < 6; i++) {
        writeFileSync(join(ctxRoot, 'tasks', `ip${i}.json`), JSON.stringify({ assigned_to: 'systems-analyst', status: 'in_progress' }), 'utf-8');
      }
      // 1 stale authored task (> 48h)
      const old = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
      writeFileSync(join(ctxRoot, 'tasks', 'auth.json'), JSON.stringify({
        created_by: 'systems-analyst', status: 'pending', created_at: old,
      }), 'utf-8');

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
});
