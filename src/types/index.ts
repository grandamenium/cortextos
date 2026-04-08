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
  sig?: string; // Security (H10): HMAC-SHA256 signature — optional for backwards compat
}

// Task Types

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'cancelled';

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
  model?: string;
  working_directory?: string;
  enabled?: boolean;
  crons?: CronEntry[];
  timezone?: string;
  day_mode_start?: string;
  day_mode_end?: string;
  communication_style?: string;
  approval_rules?: {
    always_ask: string[];
    never_ask: string[];
  };
  ecosystem?: EcosystemConfig;
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
   *  "once" restores only if fire_at is still in the future; deleted after firing. */
  type?: 'recurring' | 'once';
}

export interface OrgContext {
  name?: string;
  description?: string;
  industry?: string;
  icp?: string;
  value_prop?: string;
  timezone?: string;
  orchestrator?: string;
  day_mode_start?: string;
  day_mode_end?: string;
  default_approval_categories?: string[];
  communication_style?: string;
  dashboard_url?: string;
}

// Telegram Types

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
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
  | 'inject-worker';

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
}

// Agent Status (returned by daemon)

export interface AgentStatus {
  name: string;
  status: 'running' | 'stopped' | 'crashed' | 'starting' | 'halted';
  pid?: number;
  uptime?: number; // seconds
  lastHeartbeat?: string;
  sessionStart?: string;
  crashCount?: number;
  model?: string;
}
