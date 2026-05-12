// Shared types for token-audit pipeline.

export type Runtime = 'claude' | 'codex';

export type TriggerKind = 'cron' | 'user' | 'bus' | 'hook' | 'unknown';

export interface ToolUse {
  name: string;
  file_path?: string;
  command?: string;
  subagent_type?: string;
  pattern?: string;
  input_chars: number;
}

export interface TurnFact {
  turn_id: string;                  // composite "agent::session_id::message_uuid"
  agent: string;
  runtime: Runtime;
  session_id: string;
  ts: string;                       // ISO 8601
  model: string;

  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;

  usd_input: number;
  usd_output: number;
  usd_cache_read: number;
  usd_cache_write: number;
  usd_total: number;

  is_sidechain: boolean;

  // WHY chain (filled by trigger-resolution; may be null/'unknown' in Phase 1)
  trigger_kind: TriggerKind;
  trigger_name: string | null;
  trigger_prompt: string | null;    // truncated
  session_opener: string | null;    // truncated
  parent_session: string | null;

  // WHAT chain (per-turn attribution)
  tools_used: ToolUse[];
  files_touched: string[];          // canonical absolute paths
  bash_verbs: string[];
  subagents_spawned: string[];

  audit_run_id: string;
  source_file: string;
}

export interface SessionFact {
  session_id: string;
  agent: string;
  runtime: Runtime;
  started_at: string;
  ended_at: string;
  turn_count: number;
  usd_total: number;
  trigger_kind: TriggerKind;
  trigger_name: string | null;
}

export type AnomalyKind =
  | 'outlier_session'
  | 'cache_runaway'
  | 'compact_candidate'
  | 'idle_burn'
  | 'trigger_addiction'   // Phase 2
  | 'model_mismatch';     // Phase 2

export type AnomalySeverity = 'info' | 'warning' | 'critical';

export interface Anomaly {
  anomaly_id: string;
  audit_run_id: string;
  kind: AnomalyKind;
  severity: AnomalySeverity;
  agent: string;
  session_id: string | null;
  evidence_turn_ids: string[];
  usd_impact: number;
  why_text: string;
  detected_at: string;
  status: 'open' | 'acknowledged' | 'resolved';
}

export interface IdleBurnRow {
  snapshot_date: string;            // YYYY-MM-DD
  agent: string;
  window_hours: number;
  usd_spent: number;
  tasks_completed: number;
  usd_per_task: number;             // Infinity-safe: tasks=0 → usd_spent itself
  verdict: 'ok' | 'idle_burn' | 'no_data';
}

export interface AuditRun {
  run_id: string;
  started_at: string;
  completed_at: string | null;
  since: string;
  until: string;
  scanned_files: number;
  turns_ingested: number;
  anomalies_detected: number;
  error: string | null;
}
