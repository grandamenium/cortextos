// Fleet box-side supabase-sync — row shapes the collectors emit (the box's natural keys: org
// slug + agent name). push.ts resolves slug/name -> the org_id/agent_id uuids in Supabase, per
// Sage's canonical schema (fleet-dashboard-m1-schema-spec.md). Keep these in lockstep with that doc.

export interface OrgRow {
  slug: string;            // = cortextos org dir name, e.g. 'zeusbot'
  name: string;
  description: string | null;
  industry: string | null;
  timezone: string | null;
  orchestrator: string | null;
}

export interface AgentRow {
  org_slug: string;
  name: string;
  display_name: string | null;
  role: string | null;
  enabled: boolean;
  runtime: string | null;
  model: string | null;
  timezone: string | null;
}

export interface HeartbeatRow {
  org_slug: string;
  agent_name: string;
  status: string | null;
  current_task: string | null;
  mode: string | null;
  last_heartbeat: string | null;   // ISO
  loop_interval: string | null;
  // runtime health signals (0024): null until reader deploys (graceful-absent on monitor side)
  launch_path_canonical: boolean | null;  // true=cwd==agents/<name>; false=stranded; null=unknown
  session_mb: number | null;              // largest active .jsonl MB; null=unknown
}

export interface CrashRow {
  org_slug: string;
  agent_name: string;
  ts: string;                       // ISO
  type: string | null;
  reason: string | null;
  session_id: string | null;
  last_task: string | null;
}

export type CronHealthState = 'healthy' | 'warning' | 'failure' | 'never_fired';

export interface CronHealthRow {
  org_slug: string;
  agent_name: string;
  cron_name: string;
  health_state: CronHealthState;
  last_fired_at: string | null;
  next_fire_at: string | null;
  gap_ms: number | null;
  success_rate_24h: number | null;
}

export interface SyncCounts {
  orgs: number;
  agents: number;
  heartbeats: number;
  crashes: number;
  cron_health: number;
}
