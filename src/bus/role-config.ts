/**
 * Role configuration for role-typed metrics (SYS-MET-01).
 *
 * Each agent has a role-type that drives which KPIs are emitted and which
 * anomaly thresholds apply. The single legacy `tasks_completed/pending` ratio
 * was a false-positive engine for authoring and inbox-triage roles — see
 * commit notes from 2026-05-20 for the PO measurement-artifact incident.
 *
 * Resolution order:
 *   1. orgs/<org>/agents/<agent>/role.json
 *   2. agents/<agent>/role.json
 *   3. Built-in NAME_DEFAULTS lookup
 *   4. Fallback: coding-assignee
 *
 * A partial role.json (e.g. only role_type) merges with the default config
 * so agents can override one threshold without restating the whole shape.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export type RoleType = 'coding-assignee' | 'authoring' | 'inbox-triage' | 'analyst-hybrid';

export interface RoleConfig {
  role_type: RoleType;
  primary_kpi: string;
  secondary_kpis: string[];
  anomaly_thresholds: Record<string, number>;
}

/**
 * Default thresholds per role-type. Tuned conservatively — see addendum
 * (task_1779298649590) for the 48h dispatch-latency rationale.
 */
const DEFAULT_CONFIGS: Record<RoleType, RoleConfig> = {
  'coding-assignee': {
    role_type: 'coding-assignee',
    primary_kpi: 'assignee_completion_ratio',
    secondary_kpis: ['in_progress_count', 'wip_cap_breach'],
    anomaly_thresholds: {
      assignee_completion_ratio_min: 0.3,
      wip_cap_max: 5,
    },
  },
  'authoring': {
    role_type: 'authoring',
    primary_kpi: 'pending_dispatch_age_p95_ms',
    secondary_kpis: ['authored_pending_dispatch', 'authored_total'],
    anomaly_thresholds: {
      // 48h: most user requests should reach a coding agent within 2 working days
      pending_dispatch_age_p95_max_ms: 172_800_000,
    },
  },
  'inbox-triage': {
    role_type: 'inbox-triage',
    primary_kpi: 'requests_today',
    secondary_kpis: ['response_p50_ms', 'classification_accuracy'],
    anomaly_thresholds: {
      // response_p50_max_ms left unset until we have a baseline; same for
      // classification_accuracy_min (waits for ground-truth backfill pipeline)
    },
  },
  'analyst-hybrid': {
    role_type: 'analyst-hybrid',
    primary_kpi: 'assignee_completion_ratio',
    secondary_kpis: ['authored_pending_dispatch', 'pending_dispatch_age_p95_ms', 'wip_cap_breach'],
    anomaly_thresholds: {
      assignee_completion_ratio_min: 0.3,
      wip_cap_max: 5,
      pending_dispatch_age_p95_max_ms: 172_800_000,
    },
  },
};

/**
 * Known agent → role-type assignments. New agents fall through to
 * coding-assignee (the most common role) unless they ship their own role.json.
 */
const NAME_DEFAULTS: Record<string, RoleType> = {
  'frontend-dev': 'coding-assignee',
  'backend-architect': 'coding-assignee',
  'cortextos-improver': 'coding-assignee',
  'cannametrics-data': 'coding-assignee',
  'integrations-routing': 'coding-assignee',
  'product-owner': 'authoring',
  'platform-director': 'authoring',
  'devops-monitor': 'inbox-triage',
  'user-proxy': 'inbox-triage',
  'systems-analyst': 'analyst-hybrid',
};

export function defaultRoleType(agent: string): RoleType {
  return NAME_DEFAULTS[agent] ?? 'coding-assignee';
}

export function defaultRoleConfig(roleType: RoleType): RoleConfig {
  const base = DEFAULT_CONFIGS[roleType];
  return {
    role_type: base.role_type,
    primary_kpi: base.primary_kpi,
    secondary_kpis: [...base.secondary_kpis],
    anomaly_thresholds: { ...base.anomaly_thresholds },
  };
}

function isRoleType(v: unknown): v is RoleType {
  return v === 'coding-assignee' || v === 'authoring'
      || v === 'inbox-triage' || v === 'analyst-hybrid';
}

/**
 * Resolve an agent's role config. Always returns a usable config — falls
 * through to name-default then coding-assignee. A partial role.json overrides
 * only the fields it specifies; the rest inherits from the type's default.
 */
export function resolveRoleConfig(
  ctxRoot: string,
  agent: string,
  org?: string,
): RoleConfig {
  const candidates: string[] = [];
  if (org) candidates.push(join(ctxRoot, 'orgs', org, 'agents', agent, 'role.json'));
  candidates.push(join(ctxRoot, 'agents', agent, 'role.json'));

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<RoleConfig> & { role_type?: unknown };
      if (!isRoleType(raw.role_type)) continue;
      const base = DEFAULT_CONFIGS[raw.role_type];
      return {
        role_type: raw.role_type,
        primary_kpi: typeof raw.primary_kpi === 'string' ? raw.primary_kpi : base.primary_kpi,
        secondary_kpis: Array.isArray(raw.secondary_kpis) ? raw.secondary_kpis : [...base.secondary_kpis],
        anomaly_thresholds: { ...base.anomaly_thresholds, ...(raw.anomaly_thresholds || {}) },
      };
    } catch {
      // Malformed role.json → fall through to next candidate
    }
  }

  return defaultRoleConfig(defaultRoleType(agent));
}
