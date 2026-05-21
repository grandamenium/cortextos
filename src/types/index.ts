// cortextOS Node.js - Core Type Definitions
// These types match the bash version's JSON formats exactly for backward compatibility

export type Priority = 'urgent' | 'high' | 'normal' | 'low';

export const PRIORITY_MAP: Record<Priority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

export const VALID_PRIORITIES: Priority[] = ['urgent', 'high', 'normal', 'low'];

// Message Bus Types

export interface InboxMessage {
  id: string;
  from: string;
  to: string;
  priority: Priority;
  timestamp: string; // ISO 8601
  text: string;
  reply_to: string | null;
  /** OTel-style trace ID for correlating messages across a multi-agent workflow. */
  trace_id?: string;
  sig?: string; // Security (H10): HMAC-SHA256 signature — optional for backwards compat
}

// Task Types

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'cancelled';

export interface TaskOutput {
  /** Output kind. "file" links to a saved deliverable; other shapes reserved. */
  type: 'file';
  /** For type:"file", the path to the file relative to CTX_ROOT (forward-slash separated). */
  value: string;
  /** Optional human-readable label shown in dashboard task detail. */
  label?: string;
}

/**
 * Blocker context — stored at `task.meta.blocker` on every task with
 * `status: "blocked"`. Both fields are required; use
 * `"field-not-applicable: <reason>"` when a field genuinely does not apply
 * so the Fleet Tasks UI can render a consistent view instead of "No blocking
 * reason recorded".
 */
export interface TaskBlockerContext {
  /** Human-readable explanation of what is preventing progress. */
  blocker_reason: string;
  /** Observable evidence or artifact that proves the blocker is resolved. */
  next_proof_required: string;
}

/**
 * Structured task brief — stored at `task.meta.brief`. All 9 fields are
 * required; use `"field-not-applicable: <reason>"` for fields not relevant
 * to a given task rather than omitting them, so the Fleet Tasks UI can
 * render a consistent contract view across all task types.
 */
export interface TaskBrief {
  /** What observable state proves this task is done. */
  success_criteria: string;
  /** What this task explicitly will NOT do. */
  out_of_scope: string;
  /** Conditions that should trigger escalation to a human. */
  escalation_triggers: string;
  /** Ordered list of authoritative sources (first = highest authority). */
  source_hierarchy: string | string[];
  /** Preferred agent runtime (e.g. "codex", "dev", "analyst"). */
  preferred_runtime: string;
  /** Agent capabilities this task requires. */
  required_capabilities: string | string[];
  /** Evidence that a fallback path exists if the primary path fails. */
  fallback_proof: string;
  /** Expected deliverable files or API responses. */
  artifact_expectations: string;
  /** Goal chain this task derives from (e.g. ["G1", "sprint objective"]). */
  goal_ancestry: string | string[];
}

export interface Task {
  id: string;
  title: string;
  description: string;
  type: 'agent' | 'human';
  needs_approval: boolean;
  status: TaskStatus;
  assigned_to: string;
  created_by: string;
  org: string;
  priority: Priority;
  project: string;
  kpi_key: string | null;
  created_at: string; // ISO 8601
  updated_at: string; // ISO 8601
  completed_at: string | null;
  due_date: string | null;
  archived: boolean;
  result?: string;
  /** Linked deliverables (files saved via `cortextos bus save-output`). */
  outputs?: TaskOutput[];
  /**
   * Dependency DAG edges (beads-inspired). Optional so existing task
   * files remain valid with these fields absent. `blocked_by` lists
   * task IDs that must reach `completed` before this task can
   * progress; `blocks` is the reverse view, maintained symmetrically
   * at create-time so queries in either direction are cheap.
   */
  blocks?: string[];
  blocked_by?: string[];
  /**
   * Free-form correlation metadata. Set at create-time via `--meta '<json>'`
   * so callers can attach context (e.g. originating cron name, source msg_id,
   * upstream request id) without polluting the strict schema. Opaque to the
   * bus — the dashboard surfaces it as-is.
   */
  meta?: Record<string, unknown>;
  /**
   * Machine-checkable condition proving this task is done. Promoted from
   * meta.brief.success_criteria to a top-level field so it is queryable
   * without parsing the opaque meta blob.  Required for all tasks (brief
   * contract field 1 of 4).
   */
  success_criteria?: string;
  /**
   * What this task explicitly will NOT do. Brief contract field 2 of 4.
   * Required at creation time via --out-of-scope.
   */
  out_of_scope?: string;
  /**
   * Conditions that should trigger escalation to a human. Brief contract
   * field 3 of 4. Required at creation time via --escalation-triggers.
   */
  escalation_triggers?: string;
  /**
   * Who assigned this task (e.g. "orchestrator", "greg", "self-directed").
   * Brief contract field 4 of 4. Required at creation time via --source-hierarchy.
   */
  source_hierarchy?: string;
  /**
   * Goal guard — auto-created when a high-stakes task has a
   * success_criteria. Lifecycle: active → met (task completes) or failed.
   */
  linked_goal?: LinkedGoal;
  /**
   * Loop config — auto-suggested when the task description implies polling
   * is needed. The executing agent creates the real session cron and
   * records the cron_id.
   */
  linked_loop?: LinkedLoop;
}

/**
 * Linked goal guard — auto-created on high-stakes tasks (priority=high/urgent
 * or needs_approval=true) when a success_criteria is present. Tracks whether
 * the observable success condition has been evaluated.
 */
export interface LinkedGoal {
  status: 'active' | 'met' | 'failed';
  created_at: string;
  deadline?: string;
  owner?: string;
}

/**
 * Linked loop — auto-created (as a suggestion) when task description
 * implies polling is needed (keywords: poll, check, every N min, until merged,
 * etc.). The executing agent creates the actual cron and records its ID.
 */
export interface LinkedLoop {
  cron: string;
  prompt: string;
  status: 'suggested' | 'active' | 'completed' | 'cancelled';
  created_at: string;
  cron_id?: string;
}

/**
 * One replay fixture for a feedback rule. Pairs the rule's check function
 * with the exact scenario from the original incident so the test suite can
 * prove the rule would have prevented it.
 */
export interface FeedbackRuleFixture {
  /** Slug matching the feedback memory file name (without .md). */
  ruleName: string;
  /** One-line description of the original incident. */
  incidentSummary: string;
  /**
   * The raw input from the original incident (PR body text, command string,
   * agent heartbeat message, etc.) that should be flagged by the rule.
   */
  originalInput: string;
  /**
   * Run the rule check against `input`. Returns a non-null violation message
   * if the input would have been flagged; null if the input is clean.
   */
  check: (input: string) => string | null;
}

// Event Types

export type EventCategory =
  | 'action'
  | 'error'
  | 'metric'
  | 'milestone'
  | 'heartbeat'
  | 'message'
  | 'task'
  | 'approval'
  | 'agent_activity';

export type EventSeverity = 'info' | 'warning' | 'error' | 'critical';

export interface Event {
  id: string;
  agent: string;
  org: string;
  timestamp: string; // ISO 8601
  category: EventCategory;
  event: string;
  severity: EventSeverity;
  metadata: Record<string, unknown>;
}

// Heartbeat Types

export interface Heartbeat {
  agent: string;
  org: string;
  display_name?: string; // user-configured name from IDENTITY.md (e.g. "Alpha", "Beta")
  status: string;
  current_task: string;
  mode: 'day' | 'night';
  last_heartbeat: string; // ISO 8601
  loop_interval: string;
  // Legacy field — sync.ts falls back to this if last_heartbeat absent
  timestamp?: string;
}

// Approval Types

export type ApprovalCategory =
  | 'external-comms'
  | 'financial'
  | 'deployment'
  | 'data-deletion'
  | 'other';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface EmailMeta {
  to: string;
  subject: string;
  body: string;
  reply_to?: string;
  cc?: string;
  from?: string;
}

export interface Approval {
  id: string;
  title: string;
  requesting_agent: string;
  org: string;
  category: ApprovalCategory;
  status: ApprovalStatus;
  description: string;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  email_meta?: EmailMeta;
}

// Agent Steer Types

export type AgentSteerActionClass =
  | 'guidance'
  | 'status_request'
  | 'artifact_request'
  | 'pause'
  | 'resume'
  | 'escalate'
  | 'stop';

export type AgentSteerApprovalClass = 'low_risk_direct' | 'high_risk_approval';

export type AgentSteerArtifactType = 'log' | 'diff' | 'screenshot' | 'report';

export interface AgentSteerPayload {
  instruction?: string;
  artifactType?: AgentSteerArtifactType;
  reason?: string;
  sourcePanel?: 'agent_work_panel';
  liveStatePath?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentSteerAction {
  actor: string;
  target_agent: string;
  action_class: AgentSteerActionClass;
  payload: AgentSteerPayload;
  task_id?: string | null;
}

export interface AgentSteerApprovalDecision {
  approval_class: AgentSteerApprovalClass;
  approval_required: boolean;
  approval_category: ApprovalCategory | null;
  reason: string;
}

// Agent Config Types (config.json)

export interface EcosystemFeatureConfig {
  enabled?: boolean;
}

export interface EcosystemConfig {
  /** Daily git snapshots of agent workspace. Agent stages safe files, reviews diff, commits. */
  local_version_control?: EcosystemFeatureConfig;
  /** 24h cron to check canonical repo for framework updates. Requires upstream git remote. */
  upstream_sync?: EcosystemFeatureConfig;
  /** Weekly cron to browse community catalog and surface new skills/templates to user. */
  catalog_browse?: EcosystemFeatureConfig;
  /** On-demand workflow to publish custom skills/templates to the community catalog. */
  community_publish?: EcosystemFeatureConfig;
}

export interface AgentConfig {
  startup_delay?: number;
  max_session_seconds?: number;
  max_crashes_per_day?: number;
  /**
   * Sliding-window crash-loop detector. When N crashes occur within the window,
   * the agent auto-pauses (status: 'halted') instead of retrying. Absent = legacy
   * daily counter only.
   */
  crash_window?: { seconds: number; max_crashes?: number };
  model?: string;
  /**
   * Cost tier for model routing: 'haiku' | 'sonnet' | 'opus'.
   * Ignored when `model` is set (explicit model takes precedence).
   * Resolved to a concrete model ID via model_tiers (or DEFAULT_MODEL_TIERS).
   */
  tier?: 'haiku' | 'sonnet' | 'opus';
  /**
   * Per-agent overrides for the tier→model ID mapping.
   * Merges on top of DEFAULT_MODEL_TIERS — only specify the tiers you want to override.
   */
  model_tiers?: { haiku?: string; sonnet?: string; opus?: string };
  /**
   * How long to pause (seconds) when an Anthropic rate-limit exit is detected,
   * before restarting the agent. Defaults to 18000 (5 hours) — the standard
   * Anthropic rolling rate-limit window. Rate-limit pauses do NOT count toward
   * max_crashes_per_day and do NOT trigger the git watchdog.
   */
  rate_limit_pause_seconds?: number;
  working_directory?: string;
  enabled?: boolean;
  crons?: CronEntry[];
  timezone?: string;
  day_mode_start?: string;
  day_mode_end?: string;
  communication_style?: string;
  /**
   * Display name for the business or team operating this agent.
   * When set, the dashboard sidebar and title show this name instead of "cortextOS".
   * Typically set by the onboarding wizard from the user's company name.
   */
  brand_name?: string;
  approval_rules?: {
    always_ask: string[];
    never_ask: string[];
  };
  ecosystem?: EcosystemConfig;
  /**
   * Gmail watch: when present, the fast-checker daemon polls Gmail every
   * `interval_ms` (default 15 min) using the `gws` CLI and writes an inbox
   * message to wake Claude if unread messages match the query.
   * Requires `gws` to be authenticated (see ~/.config/gws/).
   */
  gmail_watch?: {
    /** Gmail API query string (e.g. "from:example.com is:unread") */
    query: string;
    /** Poll interval in milliseconds. Default: 900000 (15 minutes) */
    interval_ms?: number;
  };
  /** Context window % at which to warn agent + user. Default: 70. Absent = observe-only. */
  ctx_warning_threshold?: number;
  /** Context window % at which to inject handoff prompt and hard-restart. Default: 80. */
  ctx_handoff_threshold?: number;
  /**
   * Context window % at which to snapshot memory and silently force-restart the agent,
   * BEFORE the graceful-handoff threshold. 0 or absent = disabled (no auto-reset).
   * Typical: 55. Never-Telegram, never-interactive, used to keep agents from hitting 80%+.
   */
  ctx_autoreset_threshold?: number;
  /**
   * Fallback context window cap (tokens) for codex-app-server agents when the
   * server's `thread/tokenUsage/updated` event reports `modelContextWindow=null`.
   * Defaults to 256000 when unset. Only applied to the codex-app-server runtime.
   */
  codex_context_cap?: number;
  /**
   * Transport used by the codex-app-server runtime. Defaults to a localhost
   * WebSocket listener in production because codex-cli 0.125.0 exposes a
   * responsive app-server over `ws://`; tests may force `unix` for mocks.
   */
  codex_app_server_transport?: 'ws' | 'unix';
  /** Optional fixed localhost port for codex-app-server when using ws transport. */
  codex_app_server_port?: number;
  /**
   * Agent runtime. Defaults to 'claude-code' when absent.
   * 'hermes' selects the HermesPTY spawn path (Python persistent REPL,
   * NousResearch/hermes-agent) with Hermes-specific bootstrap, session
   * continuity, and exit handling.
   */
  runtime?: 'claude-code' | 'hermes' | 'codex-app-server' | 'script';
  /**
   * Path to the Node.js script to run when runtime is 'script'.
   * May be absolute or relative to the framework root (cortextos repo root).
   */
  script_path?: string;
  /**
   * Whether this agent runs a Telegram poller. Defaults to true when absent
   * (preserves existing behaviour). Set to false on specialist agents that
   * should not own a Telegram bot — only the designated orchestrator agent
   * should poll. Requires BOT_TOKEN + CHAT_ID to already be unset or the
   * poller will be skipped regardless.
   */
  telegram_polling?: boolean;
}

export interface CronEntry {
  name: string;
  /** For recurring crons: how often to fire (e.g. "4h", "1d"). */
  interval?: string;
  /** For time-anchored crons: a cron expression (e.g. "0 8 * * *"). Takes precedence over interval. */
  cron?: string;
  /** For one-shot crons: ISO 8601 datetime when the cron should fire. */
  fire_at?: string;
  prompt: string;
  /** "recurring" (default) restores on every session start.
   *  "once" restores only if fire_at is still in the future; deleted after firing.
   *  "disabled" skips restoration entirely (cron is paused). */
  type?: 'recurring' | 'once' | 'disabled';
  /**
   * Optional shell command evaluated before each fire. If the command exits
   * with code 1, or exits 0 with stdout containing {"wake":false}, the cron
   * is skipped for this tick (last_fire is NOT updated so it retries next
   * tick). On error or timeout the gate is ignored and the cron fires
   * normally (fail-open). Useful for skipping context burn when there is
   * nothing actionable (e.g. inbox is empty).
   *
   * Example:
   *   "cortextos bus check-inbox --count-only | grep -q '^0$' && echo '{\"wake\":false}' || echo '{\"wake\":true}'"
   */
  wake_gate?: string;
}

// ---------------------------------------------------------------------------
// External Persistent Cron System — Subtask 1.1
// ---------------------------------------------------------------------------
//
// CronDefinition is the canonical record stored in per-agent crons.json files:
//   .cortextOS/state/agents/{agent_name}/crons.json
//
// The file is an array of CronDefinition objects.  The daemon reads it, schedules
// each enabled cron, and injects the prompt into the agent's PTY on schedule.
//
// Operators may edit crons.json by hand (it is intentionally human-readable).
// Keep all field names lowercase-snake-case and all times as ISO 8601 UTC.
//
// Example records
// ---------------
//
// Heartbeat — every 6 hours (interval shorthand):
// {
//   "name": "heartbeat",
//   "schedule": "6h",
//   "prompt": "Read HEARTBEAT.md and execute the heartbeat workflow.",
//   "enabled": true,
//   "created_at": "2026-04-01T00:00:00.000Z",
//   "description": "Periodic health check and status update."
// }
//
// Daily morning briefing — fixed local time via cron expression:
// {
//   "name": "morning-briefing",
//   "schedule": "0 13 * * *",
//   "prompt": "Prepare and send the morning briefing to James.",
//   "enabled": true,
//   "created_at": "2026-04-01T00:00:00.000Z",
//   "description": "Daily 09:00 ET briefing (UTC offset applied in schedule).",
//   "last_fired_at": "2026-04-28T13:00:01.042Z",
//   "fire_count": 14
// }
//
// Weekly report — cron expression with day-of-week restriction:
// {
//   "name": "weekly-report",
//   "schedule": "0 16 * * 1",
//   "prompt": "Compile and send the weekly performance report.",
//   "enabled": true,
//   "created_at": "2026-04-01T00:00:00.000Z",
//   "description": "Every Monday at 12:00 ET (16:00 UTC).",
//   "fire_count": 3
// }

/**
 * A single persistent cron definition stored in an agent's crons.json.
 *
 * Stored at: `.cortextOS/state/agents/{agent_name}/crons.json`
 *
 * The `schedule` field accepts two formats:
 *   - Interval shorthand: `"6h"`, `"30m"`, `"1d"`, `"2w"`
 *     Parsed by `parseDurationMs()` from `src/bus/cron-state.ts`.
 *   - Standard 5-field cron expression: `"0 8 * * *"`, `"0 0,6,12,18 * * *"` (every 6h)
 *     Evaluated by the daemon scheduler (Subtask 1.3).
 *
 * By default the daemon fires the cron by injecting `[CRON: {name}] {prompt}`
 * into the agent's PTY session. Crons with metadata.runner = "spawn-codex"
 * run a bounded Codex process instead and write an artifact + JSON sidecar.
 */
export interface CronDefinition {
  // ------------------------------------------------------------------
  // Required fields — must be present for the daemon to schedule this cron.
  // ------------------------------------------------------------------

  /**
   * Unique identifier for this cron within the agent.
   * Used as the key for lookups, updates, and deletions.
   * Must be unique per agent; slugs like "heartbeat" or "morning-briefing" are recommended.
   *
   * @example "heartbeat"
   * @example "morning-briefing"
   */
  name: string;

  /**
   * The prompt text injected into the agent PTY when the cron fires.
   * The daemon prepends `[CRON: {name}] ` automatically for traceability.
   *
   * @example "Read HEARTBEAT.md and execute the heartbeat workflow."
   */
  prompt: string;

  /**
   * When and how often this cron fires.
   *
   * Accepted formats:
   *   - Interval shorthand: `"6h"`, `"30m"`, `"1d"`, `"2w"`
   *     The cron fires every N units after its previous fire (or after daemon start
   *     if it has never fired).
   *   - 5-field cron expression: `"0 8 * * *"`, `"0 0,6,12,18 * * *"`, `"0 16 * * 1"`
   *     Evaluated against the daemon's wall clock (daemon timezone = server timezone).
   *
   * @example "6h"         — every six hours
   * @example "0 13 * * *" — daily at 13:00 UTC
   * @example "0 16 * * 1" — every Monday at 16:00 UTC
   */
  schedule: string;

  /**
   * Whether the daemon should fire this cron.
   * Set to `false` to pause a cron without deleting it.
   *
   * @default true
   */
  enabled: boolean;

  /**
   * ISO 8601 UTC timestamp of when this cron definition was created.
   * Set automatically by `cortextos bus add-cron`; operators should not modify this.
   *
   * @example "2026-04-01T00:00:00.000Z"
   */
  created_at: string;

  // ------------------------------------------------------------------
  // Optional fields — populated at runtime or by operators.
  // ------------------------------------------------------------------

  /**
   * ISO 8601 UTC timestamp of the most recent successful fire.
   * Updated by the daemon scheduler (Subtask 1.3) after each fire.
   * Absent when the cron has never fired.
   *
   * @example "2026-04-28T13:00:01.042Z"
   */
  last_fired_at?: string;

  /**
   * ISO 8601 UTC timestamp set by the scheduler IMMEDIATELY before it awaits
   * the onFire dispatch — i.e. before the agent has acked. On daemon crash
   * mid-fire, this lets `loadCrons` recompute `referenceMs` from the attempt
   * timestamp instead of the stale `last_fired_at`, preventing a double-fire
   * via the catch-up gate. Tradeoff: a fire whose dispatch genuinely failed
   * pre-crash will be skipped one window — preferable to guaranteed re-fire.
   */
  last_fire_attempted_at?: string;

  /**
   * Total number of times this cron has successfully fired.
   * Incremented by the daemon on each successful PTY injection.
   * Absent (or 0) when the cron has never fired.
   */
  fire_count?: number;

  /**
   * ISO 8601 UTC timestamp for one-shot crons — when the cron should fire once
   * and then be deleted. Mutually exclusive with recurring `schedule` semantics:
   * if `fire_at` is set, the daemon treats this as a one-shot regardless of
   * `schedule`. Used by `cron-health.ts` to flag never-fired one-shots that
   * are still inside their grace window as healthy rather than stale.
   *
   * @example "2026-05-15T14:00:00.000Z"
   */
  fire_at?: string;

  /**
   * Human-readable description of what this cron does.
   * Optional — for operator documentation and dashboard display.
   *
   * @example "Periodic health check and status update."
   */
  description?: string;

  /**
   * Arbitrary key-value pairs for agent-specific context.
   * Most metadata is only surfaced in dashboard + execution logs.
   * Daemon-supported keys:
   * - runner: "pty" | "spawn-codex"
   * - prompt_file: org-relative prompt path for spawn-codex runner
   * - workdir, agent, timeout_seconds, task_id, reply_to, model, effort, mcp_config, sandbox
   *
   * @example { "priority": "high", "source": "/loop" }
   */
  metadata?: Record<string, unknown>;

  /**
   * When true, the Test Fire button in the dashboard is disabled and the
   * IPC fire-cron handler refuses manual-trigger requests.
   *
   * Use this for crons that must only run on their schedule (e.g. crons
   * that do destructive operations or have strict rate-limit contracts).
   *
   * @default false (manual fire is allowed by default — opt-out model)
   */
  manualFireDisabled?: boolean;
}

// ---------------------------------------------------------------------------
// Cron Execution Log — Subtask 1.5
// ---------------------------------------------------------------------------

/**
 * A single entry in the per-agent cron execution log
 * (`$CTX_ROOT/.cortextOS/state/agents/{agent}/cron-execution.log`).
 *
 * The file is JSONL (one JSON object per line, newline-separated).
 * It is append-only; log rotation prunes to the last 1 000 lines.
 *
 * Status semantics:
 *   "fired"   — the fire attempt succeeded on this attempt.
 *   "retried" — this attempt failed but more retries remain (see `error`).
 *   "failed"  — final failure after exhausting all retries (see `error`).
 */
export interface CronExecutionLogEntry {
  /** ISO 8601 UTC timestamp of the fire attempt. */
  ts: string;
  /** Cron name (matches CronDefinition.name). */
  cron: string;
  /** Outcome of this attempt. */
  status: 'fired' | 'retried' | 'failed';
  /** Attempt index (1-based). */
  attempt: number;
  /** Wall-clock duration of the fire attempt in milliseconds. */
  duration_ms: number;
  /** Error message if status is "retried" or "failed"; null otherwise. */
  error: string | null;
  /** Optional phase marker for agent-reported results after scheduler injection. */
  phase?: 'fire' | 'result';
  /** Optional human-readable result summary for the run. */
  result?: string;
  /** Optional artifact path produced by the run. */
  artifact?: string;
}

export interface OrgContext {
  name?: string;
  description?: string;
  industry?: string;
  icp?: string;
  value_prop?: string;
  timezone?: string;
  orchestrator?: string;
  workingDir?: string;
  day_mode_start?: string;
  day_mode_end?: string;
  default_approval_categories?: string[];
  communication_style?: string;
  dashboard_url?: string;
  /** When true, agents are instructed at startup that every task submitted
   *  for review must have at least one file deliverable attached via
   *  save-output. The instruction is injected into the boot prompt
   *  dynamically — no agent markdown files are modified. */
  require_deliverables?: boolean;
}

// Telegram Types

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  message_reaction?: TelegramMessageReaction;
}

/**
 * One item in a Telegram message's reaction list. Telegram supports
 * `type: 'emoji'` (standard emoji, the only shape we handle today) and
 * `type: 'custom_emoji'` (premium custom emoji, carrying a `custom_emoji_id`
 * instead of an `emoji` character). Shaped as a tagged union so call sites
 * can narrow safely.
 */
export type TelegramReactionType =
  | { type: 'emoji'; emoji: string }
  | { type: 'custom_emoji'; custom_emoji_id: string };

/**
 * A `message_reaction` update fires when a user adds or removes an
 * emoji reaction on a chat message the bot can see. `old_reaction` and
 * `new_reaction` are the reaction state before/after — empty means "no
 * reaction", so the diff is (new) minus (old). Requires
 * `allowed_updates: ['message_reaction']` in the getUpdates call.
 */
export interface TelegramMessageReaction {
  chat: TelegramChat;
  user?: TelegramUser;
  message_id: number;
  date: number;
  old_reaction: TelegramReactionType[];
  new_reaction: TelegramReactionType[];
}

export interface TelegramMessage {
  message_id: number;
  date?: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  voice?: TelegramVoice;
  audio?: TelegramAudio;
  video?: TelegramVideo;
  video_note?: TelegramVideoNote;
  caption?: string;
  reply_to_message?: TelegramMessage;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
}

export interface TelegramPhotoSize {
  file_id: string;
  width: number;
  height: number;
}

export interface TelegramDocument {
  file_id: string;
  file_name?: string;
}

export interface TelegramVoice {
  file_id: string;
  duration: number;
}

export interface TelegramAudio {
  file_id: string;
  duration: number;
  file_name?: string;
}

export interface TelegramVideo {
  file_id: string;
  duration: number;
  file_name?: string;
}

export interface TelegramVideoNote {
  file_id: string;
  duration: number;
}

// Task Management Report Types

export interface StaleTaskReport {
  stale_in_progress: Task[];
  stale_pending: Task[];
  stale_human: Task[];
  overdue: Task[];
}

export interface ArchiveReport {
  archived: number;
  skipped: number;
  dry_run: boolean;
}

// Environment / Context Types

export interface CtxEnv {
  instanceId: string;
  ctxRoot: string;
  frameworkRoot: string;
  agentName: string;
  agentDir: string;
  org: string;
  projectRoot: string;
  timezone?: string;
  orchestrator?: string;
  workingDir?: string;
}

// Bus Path Types

export interface BusPaths {
  ctxRoot: string;
  inbox: string;
  inflight: string;
  processed: string;
  logDir: string;
  stateDir: string;
  taskDir: string;
  approvalDir: string;
  analyticsDir: string;
  /**
   * Per-org deliverables root: {ctxRoot}/orgs/{org}/deliverables/.
   * Files saved here are servable by the dashboard's /api/media route because
   * they live under CTX_ROOT.
   */
  deliverablesDir: string;
}

// IPC Types

export type IPCCommandType =
  | 'status'
  | 'start-agent'
  | 'stop-agent'
  | 'restart-agent'
  | 'wake'
  | 'list-agents'
  | 'spawn-worker'
  | 'terminate-worker'
  | 'list-workers'
  | 'inject-worker'
  | 'reload-crons'
  | 'fire-cron'
  | 'inject-agent'
  | 'list-all-crons'
  | 'list-cron-executions'
  | 'add-cron'
  | 'update-cron'
  | 'remove-cron'
  | 'fleet-health';

// ---------------------------------------------------------------------------
// Execution log pagination response — Subtask 4.3
// ---------------------------------------------------------------------------

/**
 * Paginated response for list-cron-executions IPC command.
 */
export interface CronExecutionLogPage {
  entries: CronExecutionLogEntry[];
  /** Total matching entries (after cronName + statusFilter applied). */
  total: number;
  /** True when there are more entries older than this page. */
  hasMore: boolean;
}

// ---------------------------------------------------------------------------
// list-all-crons response shape — Subtask 4.1
// ---------------------------------------------------------------------------

/**
 * One row returned by the `list-all-crons` IPC command.
 * Combines the cron definition with runtime state (last fire, next fire, status).
 */
export interface CronSummaryRow {
  /** Agent that owns this cron. */
  agent: string;
  /** Org the agent belongs to (from enabled-agents.json). */
  org: string;
  /** Full cron definition as stored in crons.json. */
  cron: CronDefinition;
  /**
   * ISO 8601 timestamp of the most recent fire attempt.
   * Null when the cron has never fired (no execution log entry).
   */
  lastFire: string | null;
  /**
   * Outcome of the most recent execution log entry.
   * Null when the cron has never fired.
   */
  lastStatus: 'fired' | 'retried' | 'failed' | null;
  /**
   * ISO 8601 timestamp of the next scheduled fire.
   * Computed from the cron's schedule + last_fired_at (or now).
   */
  nextFire: string;
}

// ---------------------------------------------------------------------------
// Fleet Health — Subtask 4.4
// ---------------------------------------------------------------------------

export type CronHealthState = 'healthy' | 'warning' | 'failure' | 'never-fired';

/** Health record for a single cron, returned by the fleet-health IPC command. */
export interface CronHealthRow {
  agent: string;
  org: string;
  cronName: string;
  state: CronHealthState;
  reason: string;
  lastFire: number | null;
  expectedIntervalMs: number;
  gapMs: number | null;
  successRate24h: number;
  firesLast24h: number;
  nextFire: string;
}

/** Per-agent breakdown in the fleet-health summary. */
export interface AgentHealthSummary {
  agent: string;
  org: string;
  total: number;
  healthy: number;
  warning: number;
  failure: number;
  neverFired: number;
}

/** Full response returned by the fleet-health IPC command. */
export interface FleetHealthResponse {
  rows: CronHealthRow[];
  summary: {
    total: number;
    healthy: number;
    warning: number;
    failure: number;
    neverFired: number;
    agents: Record<string, AgentHealthSummary>;
  };
}

export interface IPCRequest {
  type: IPCCommandType;
  agent?: string;
  data?: Record<string, unknown>;
  /**
   * BUG-015: human-readable identifier of the caller (e.g. 'cortextos enable',
   * 'cortextos bus soft-restart-all'). Logged by the daemon on every incoming
   * IPC request so we can trace which CLI command triggered which daemon action.
   * Optional for backwards compatibility — older clients fall back to 'unknown'.
   */
  source?: string;
}

// Worker Types

export type WorkerStatusValue = 'starting' | 'running' | 'completed' | 'failed';

export interface WorkerStatus {
  name: string;
  status: WorkerStatusValue;
  pid?: number;
  dir: string;
  parent?: string;
  spawnedAt: string;
  exitCode?: number;
}

export interface IPCResponse {
  success: boolean;
  data?: unknown;
  error?: string;
  /**
   * Structured error code for failed responses. Lets operators distinguish
   * "agent does not exist" (NOT_FOUND) from "request collapsed against an
   * in-flight identical op" (DEDUPED). See issue #346.
   */
  code?: 'NOT_FOUND' | 'DEDUPED' | 'INVALID_INPUT' | 'NOT_RUNNING';
}

// Agent Discovery Types

export interface AgentInfo {
  name: string;
  org: string;
  display_name?: string;  // user-configured name from IDENTITY.md (e.g. "Alpha", "Beta")
  role: string;
  enabled: boolean;
  running: boolean;
  last_heartbeat: string | null;
  current_task: string | null;
  mode: string | null;
  /** Remote agents discovered via Supabase orch_agent_heartbeats (not local filesystem). */
  remote?: boolean;
  /** Hostname of the VM running this agent (populated for remote agents). */
  host?: string;
  /** CTX_INSTANCE_ID of the remote instance. */
  instance_id?: string;
}

// Agent Status (returned by daemon)

export interface AgentStatus {
  name: string;
  status: 'running' | 'stopped' | 'crashed' | 'starting' | 'halted' | 'rate-limited';
  pid?: number;
  uptime?: number; // seconds
  lastHeartbeat?: string;
  sessionStart?: string;
  crashCount?: number;
  model?: string;
  healthStatus?: 'healthy' | 'degraded' | 'unknown';
}

export type { Workflow, WorkflowStep } from './workflow.js';
