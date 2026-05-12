// cortextOS Dashboard - Shared TypeScript interfaces
// Matches JSON schemas from bus/ scripts exactly

// -- Health & Action Types --

export type HealthStatus = 'healthy' | 'stale' | 'down';

export interface ActionResult {
  success: boolean;
  error?: string;
}

// -- Agent Types --

export interface Agent {
  name: string;
  org: string;
  role?: string;
  emoji?: string;
  health: HealthStatus;
  currentTask?: string;
  tasksToday: number;
  lastHeartbeat?: string; // ISO timestamp
}

export type AgentRuntime = 'claude-code' | 'codex-app-server' | 'hermes';

export interface AgentSummary {
  name: string;
  org: string;
  health: HealthStatus;
  currentTask?: string;
  lastHeartbeat?: string;
  runtime?: AgentRuntime;
}

export interface Heartbeat {
  agent: string;
  org: string;
  status: string;
  current_task?: string;
  mode?: string;
  last_heartbeat?: string; // ISO timestamp
  loop_interval?: number;
  uptime_seconds?: number;
}

// -- Task Types --

export type TaskStatus = 'pending' | 'in_progress' | 'blocked' | 'completed';
export type TaskPriority = 'critical' | 'urgent' | 'high' | 'normal' | 'low';

export interface TaskOutput {
  type: 'file';
  value: string;
  label?: string;
}

export interface Task {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignee?: string;
  org: string;
  project?: string;
  needs_approval?: boolean;
  created_at: string;
  updated_at?: string;
  completed_at?: string;
  notes?: string;
  source_file?: string;
  outputs?: TaskOutput[];
}

// -- Approval Types --

export type ApprovalCategory = 'deployment' | 'cost' | 'access' | 'other';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface Approval {
  id: string;
  title: string;
  category: ApprovalCategory;
  description?: string;
  status: ApprovalStatus;
  agent: string;
  org: string;
  created_at: string;
  resolved_at?: string;
  resolved_by?: string;
  resolution_note?: string;
  source_file?: string;
}

// -- Event Types --

export type EventType =
  | 'action'
  | 'message'
  | 'task'
  | 'approval'
  | 'error'
  | 'milestone'
  | 'heartbeat';
export type EventSeverity = 'info' | 'warning' | 'error';

export interface Event {
  id: string;
  timestamp: string;
  agent: string;
  org: string;
  type: EventType;
  category: string;
  severity: EventSeverity;
  data?: Record<string, unknown>;
  message?: string;
  source_file?: string;
}

// -- Message Types --

export type MessageStatus = 'unread' | 'read';

export interface Message {
  id: string;
  from_agent: string;
  to_agent: string;
  org: string;
  timestamp: string;
  content: string;
  status: MessageStatus;
  source_file?: string;
}

// -- Sync Meta Types --

export interface SyncMeta {
  file_path: string;
  mtime: number;
  last_synced: string;
}

// -- Goal Types --

export interface Goal {
  id: string;
  title: string;
  progress: number; // 0-100
  order: number;
}

export interface GoalsFile {
  bottleneck: string;
  goals: Goal[];
  daily_focus?: string;       // Today's top priority, set by Orchestrator each morning
  daily_focus_set_at?: string; // ISO timestamp when daily_focus was last updated
}

// -- Cost Types --

export interface CostEntry {
  id?: number;
  timestamp: string;
  agent: string;
  org: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  source_file?: string;
}

// -- User / Auth Types --

export interface User {
  id: number;
  username: string;
  password_hash: string;
  created_at: string;
}

// -- SSE Types --

export interface SSEEvent {
  type: 'task' | 'approval' | 'heartbeat' | 'event' | 'sync';
  data: Record<string, unknown>;
  timestamp: string;
}

// -- Task Filters --

export interface TaskFilters {
  org?: string;
  agent?: string;
  priority?: string;
  status?: string;
  project?: string;
  search?: string;
}

// -- Health Summary --

export interface AgentHealth {
  agent: string;
  org: string;
  health: HealthStatus;
  lastHeartbeat?: string;
  currentTask?: string;
}

export interface HealthSummary {
  healthy: number;
  stale: number;
  down: number;
  agents: AgentHealth[];
}

// -- Goals Data (alias for GoalsFile with write support) --

export type GoalsData = GoalsFile;

// -- Org Filter --

export type OrgFilter = string | 'all';

// -- Markdown Parser Types --

export interface MarkdownSection {
  heading: string; // heading text without ## prefix
  level: number; // heading level (2 for ##, 3 for ###)
  content: string; // raw content between this heading and the next same-or-higher level
  raw: string; // original raw text including heading line
}

export interface ParsedMarkdown {
  preamble: string; // content before first heading
  sections: MarkdownSection[];
  raw: string; // original full text
}

export interface IdentityFields {
  name: string;
  role: string;
  emoji: string;
  vibe: string;
  workStyle: string;
  [key: string]: string;
}

export interface SoulFields {
  autonomyRules: string;
  communicationStyle: string;
  dayMode: string;
  nightMode: string;
  coreTruths: string;
  [key: string]: string;
}

export interface GoalsMdFields {
  bottleneck: string;
  goals: string;
  [key: string]: string;
}

// -- Agent Discovery Types --

export interface AgentPaths {
  agentDir: string;
  claudeDir: string;
  identityMd: string;
  soulMd: string;
  goalsMd: string;
  memoryMd: string;
  memoryDir: string;
  heartbeat: string;
  logsDir: string;
}

export interface AgentIdentity {
  name: string;
  role: string;
  emoji: string;
  vibe: string;
  workStyle: string;
  raw: string;
}

export interface AgentDetail {
  name: string;
  systemName?: string;
  org: string;
  identity: AgentIdentity;
  soulRaw: string;
  goalsRaw: string;
  memoryRaw: string;
  memoryFiles: MemoryFile[];
  heartbeat: Heartbeat | null;
  health: HealthStatus;
  logFiles: LogFile[];
  agentDir: string;
  runtime?: AgentRuntime;
}

export interface MemoryFile {
  date: string;
  path: string;
  size: number;
}

export interface LogFile {
  type: string;
  path: string;
  lastModified: string;
}
