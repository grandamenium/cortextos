/**
 * Observability & Metrics Module
 * Node.js equivalent of bash collect-metrics.sh, scrape-usage.sh, check-upstream.sh
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync, readdirSync, mkdirSync } from 'fs';
import { join, basename, dirname } from 'path';
import { execSync } from 'child_process';
import { ensureDir } from '../utils/atomic.js';
import { resolveRoleConfig, type RoleConfig, type RoleType } from './role-config.js';

// --- Types ---

/**
 * Per-role KPI blocks (SYS-MET-01). The role-typed `role` block is emitted
 * alongside the legacy unified counters so existing dashboards and callers
 * keep working.
 */

export interface AssigneeMetrics {
  completed: number;
  pending: number;
  in_progress: number;
  /** completed / (completed + pending), or null when both are 0 */
  completion_ratio: number | null;
}

export interface AuthoringMetrics {
  /** All tasks where created_by === agent (any status) */
  authored_total: number;
  /** Authored tasks still in author's queue: pending + (unassigned OR self-assigned) */
  pending_dispatch: number;
  /** Age (now - created_at, ms) percentiles across currently pending-dispatch tasks */
  pending_dispatch_age_p50_ms: number | null;
  pending_dispatch_age_p95_ms: number | null;
}

export interface InboxTriageMetrics {
  /** Today's events with category='inbox' or event names matching the inbox pattern */
  requests_today: number;
  /** p50 response latency (ms). null until a separate event-pairing pipeline emits it */
  response_p50_ms: number | null;
  /** null pending the ground-truth backfill pipeline — see SYS-MET-01-ADDENDUM */
  classification_accuracy: number | null;
}

export interface RoleMetrics {
  role_type: RoleType;
  primary_kpi: string;
  assignee: AssigneeMetrics;
  authoring: AuthoringMetrics;
  inbox_triage: InboxTriageMetrics;
  /** Anomaly tokens fired this run, scoped to this role-type's thresholds */
  anomalies: string[];
}

export interface AgentMetrics {
  tasks_completed: number;
  tasks_pending: number;
  tasks_in_progress: number;
  errors_today: number;
  heartbeat_stale: boolean;
  /** Role-typed KPI block. Required — every agent resolves to a role config. */
  role: RoleMetrics;
}

export interface SystemMetrics {
  total_tasks_completed: number;
  agents_healthy: number;
  agents_total: number;
  approvals_pending: number;
}

export interface MetricsReport {
  timestamp: string;
  agents: Record<string, AgentMetrics>;
  system: SystemMetrics;
}

export interface UsageData {
  agent: string;
  timestamp: string;
  session: { used_pct: number; resets: string };
  week_all_models: { used_pct: number; resets: string };
  week_sonnet: { used_pct: number };
}

export interface CatalogAddition {
  name: string;
  type: string;
  description?: string;
  tags?: string[];
}

export interface UpstreamResult {
  status: string;
  commits?: number;
  diff_stat?: string;
  commit_log?: string;
  changes?: {
    bus: string[];
    scripts: string[];
    templates: string[];
    skills: string[];
    community: string[];
    other: string[];
  };
  catalog_additions?: CatalogAddition[];
  message?: string;
  error?: string;
  hint?: string;
}

export interface RegisterCommandsResult {
  status: string;
  count: number;
  commands: { command: string; description: string }[];
  error?: string;
}

// --- collectMetrics ---

/**
 * Decide whether a single JSONL event line should be counted as an error
 * for the daily errors_today metric. Returns false on malformed JSON
 * rather than throwing — bad lines should not break the report.
 *
 * An event qualifies only when BOTH:
 *   - category === 'error', AND
 *   - severity ∈ {'error', 'critical'}
 * 'warning' is intentionally not counted toward errors_today; it has its
 * own meaning in the severity ladder. 'info' events with category=error
 * (the original false-positive class) are filtered out here.
 */
function isErrorEvent(line: string): boolean {
  let evt: { category?: unknown; severity?: unknown };
  try {
    evt = JSON.parse(line);
  } catch {
    return false;
  }
  if (evt.category !== 'error') return false;
  return evt.severity === 'error' || evt.severity === 'critical';
}

/**
 * Index of all task records used by collectMetrics. Internal-only — kept in
 * memory so we can compute per-agent assignee+authoring rollups in O(tasks)
 * total instead of O(tasks × agents). Only the fields that matter for KPIs
 * are typed; everything else is intentionally absent.
 */
interface TaskRecord {
  assigned_to?: string;
  created_by?: string;
  status?: string;
  created_at?: string;
  archived?: boolean;
}

/**
 * Nearest-rank percentile (no interpolation). p must be in [0, 100].
 * Returns null for empty input — keeps callers honest about no-data cases.
 */
function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/**
 * Inbox-triage request signal. Counts today's events that look like inbound
 * messages: category='inbox' OR an event name starting with `inbox_`/`request_`.
 * Conservative — agents that already emit category='inbox' get an accurate
 * count; others get 0 until they normalize. This is the scaffold called out
 * in SYS-MET-01-ADDENDUM (primary KPI = request-count + response-p50; the
 * pairing pipeline that produces p50 lives in a separate task).
 */
function countInboxRequests(eventFiles: string[]): number {
  let count = 0;
  for (const f of eventFiles) {
    if (!existsSync(f)) continue;
    try {
      const lines = readFileSync(f, 'utf-8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const e = JSON.parse(line) as { category?: unknown; event?: unknown };
          if (e.category === 'inbox') { count++; continue; }
          if (typeof e.event === 'string' && (e.event.startsWith('inbox_') || e.event.startsWith('request_'))) {
            count++;
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  return count;
}

/**
 * Apply per-role anomaly thresholds. Returns the firing anomaly tokens.
 * Empty array = healthy. Tokens are stable strings consumers can match on.
 */
function detectAnomalies(role: RoleConfig, metrics: Omit<RoleMetrics, 'anomalies' | 'role_type' | 'primary_kpi'>): string[] {
  const out: string[] = [];
  const t = role.anomaly_thresholds;

  const wantsAssignee = role.role_type === 'coding-assignee' || role.role_type === 'analyst-hybrid';
  const wantsAuthoring = role.role_type === 'authoring' || role.role_type === 'analyst-hybrid';
  const wantsInbox = role.role_type === 'inbox-triage';

  if (wantsAssignee) {
    if (typeof t.assignee_completion_ratio_min === 'number'
        && metrics.assignee.completion_ratio !== null
        && metrics.assignee.completion_ratio < t.assignee_completion_ratio_min) {
      out.push('assignee_low_completion_ratio');
    }
    if (typeof t.wip_cap_max === 'number' && metrics.assignee.in_progress > t.wip_cap_max) {
      out.push('assignee_wip_cap_breach');
    }
  }
  if (wantsAuthoring) {
    if (typeof t.pending_dispatch_age_p95_max_ms === 'number'
        && metrics.authoring.pending_dispatch_age_p95_ms !== null
        && metrics.authoring.pending_dispatch_age_p95_ms > t.pending_dispatch_age_p95_max_ms) {
      out.push('authoring_dispatch_backlog');
    }
  }
  if (wantsInbox) {
    if (typeof t.response_p50_max_ms === 'number'
        && metrics.inbox_triage.response_p50_ms !== null
        && metrics.inbox_triage.response_p50_ms > t.response_p50_max_ms) {
      out.push('inbox_triage_slow_response');
    }
    if (typeof t.classification_accuracy_min === 'number'
        && metrics.inbox_triage.classification_accuracy !== null
        && metrics.inbox_triage.classification_accuracy < t.classification_accuracy_min) {
      out.push('inbox_triage_classification_drift');
    }
  }

  return out;
}

export function collectMetrics(ctxRoot: string, org?: string): MetricsReport {
  const timestamp = new Date().toISOString();
  const today = timestamp.split('T')[0];
  const now = Date.now();

  const enabledFile = join(ctxRoot, 'config', 'enabled-agents.json');
  let agentNames: string[] = [];
  if (existsSync(enabledFile)) {
    try {
      agentNames = Object.keys(JSON.parse(readFileSync(enabledFile, 'utf-8')));
    } catch { /* empty */ }
  }

  const agents: Record<string, AgentMetrics> = {};
  let totalCompleted = 0;
  let agentsHealthy = 0;
  const agentsTotal = agentNames.length;

  // Scope task aggregation to the caller's org context. Walking root + every
  // org's tasks dir conflates unrelated agent populations: a phytomedic-org
  // `product-owner` lookup would include the 56 mis-routed default-pool
  // tasks plus any other org's `product-owner` queue, so `tasks_pending`
  // came back ~57 when `list-tasks --agent product-owner --status pending`
  // (single-dir, listTasks semantics) returned 1. Match listTasks here:
  // when org is set, look only at <ctxRoot>/orgs/<org>/tasks; otherwise
  // look only at <ctxRoot>/tasks. Cross-org rollups belong in a separate
  // explicit aggregator, not in per-agent metrics.
  const taskDirs: string[] = [];
  const orgsDir = join(ctxRoot, 'orgs');
  if (org) {
    const orgTasks = join(orgsDir, org, 'tasks');
    if (existsSync(orgTasks)) taskDirs.push(orgTasks);
  } else {
    const tasksDir = join(ctxRoot, 'tasks');
    if (existsSync(tasksDir)) taskDirs.push(tasksDir);
  }

  // Single-pass: load every task once into memory. 1k+ tasks × 10+ agents ran
  // the previous nested loop at O(tasks × agents) reads; preloading collapses
  // it to O(tasks). Status/created_by parsing happens per-task once.
  const allTasks: TaskRecord[] = [];
  for (const taskDir of taskDirs) {
    try {
      for (const file of readdirSync(taskDir)) {
        if (!file.endsWith('.json')) continue;
        try {
          allTasks.push(JSON.parse(readFileSync(join(taskDir, file), 'utf-8')) as TaskRecord);
        } catch { /* skip bad files */ }
      }
    } catch { /* skip bad dirs */ }
  }

  for (const agent of agentNames) {
    const roleConfig = resolveRoleConfig(ctxRoot, agent, org);
    let completed = 0, pending = 0, inProgress = 0;
    let authoredTotal = 0, pendingDispatch = 0;
    const pendingDispatchAges: number[] = [];

    for (const task of allTasks) {
      // Archived tasks are excluded from listTasks (src/bus/task.ts), so
      // counting them here would make `tasks_pending` drift above the live
      // workload visible to the agent. Mirror listTasks: skip archived.
      if (task.archived) continue;
      if (task.assigned_to === agent) {
        switch (task.status) {
          case 'completed': completed++; break;
          case 'pending': pending++; break;
          case 'in_progress': inProgress++; break;
        }
      }
      if (task.created_by === agent) {
        authoredTotal++;
        // "pending dispatch" = author still owns it (unassigned OR self-assigned)
        const selfOrUnassigned = !task.assigned_to || task.assigned_to === agent;
        if (task.status === 'pending' && selfOrUnassigned) {
          pendingDispatch++;
          if (task.created_at) {
            const t = Date.parse(task.created_at);
            if (!Number.isNaN(t)) pendingDispatchAges.push(now - t);
          }
        }
      }
    }
    totalCompleted += completed;

    // Count errors today from event logs.
    // Both category AND severity must match — early agents emitted
    // category=error events at severity=info for things like
    // `gap_detector_false_positive` (Frank had 7 of these in a single day,
    // all classified as "errors" by the previous substring check). Filter
    // on parsed JSON to skip false positives that happen to contain
    // `"category":"error"` inside a metadata payload, and only count
    // events where severity is genuinely error-level.
    let errorsToday = 0;
    const eventPaths = [
      join(ctxRoot, 'analytics', 'events', agent, `${today}.jsonl`),
    ];
    if (org) {
      eventPaths.push(join(ctxRoot, 'orgs', org, 'analytics', 'events', agent, `${today}.jsonl`));
    }
    for (const eventFile of eventPaths) {
      if (existsSync(eventFile)) {
        try {
          const lines = readFileSync(eventFile, 'utf-8').split('\n').filter(Boolean);
          errorsToday += lines.filter(line => isErrorEvent(line)).length;
        } catch { /* skip */ }
      }
    }

    // Check heartbeat staleness (stale if >5 hours old)
    let heartbeatStale = true;
    const hbFile = join(ctxRoot, 'state', agent, 'heartbeat.json');
    if (existsSync(hbFile)) {
      try {
        const hb = JSON.parse(readFileSync(hbFile, 'utf-8'));
        if (hb.last_heartbeat) {
          const hbTime = new Date(hb.last_heartbeat).getTime();
          const age = now - hbTime;
          if (age < 5 * 60 * 60 * 1000) {
            heartbeatStale = false;
            agentsHealthy++;
          }
        }
      } catch { /* stale by default */ }
    }

    const denom = completed + pending;
    const assignee: AssigneeMetrics = {
      completed,
      pending,
      in_progress: inProgress,
      completion_ratio: denom === 0 ? null : completed / denom,
    };
    const authoring: AuthoringMetrics = {
      authored_total: authoredTotal,
      pending_dispatch: pendingDispatch,
      pending_dispatch_age_p50_ms: percentile(pendingDispatchAges, 50),
      pending_dispatch_age_p95_ms: percentile(pendingDispatchAges, 95),
    };
    const inbox: InboxTriageMetrics = {
      requests_today: roleConfig.role_type === 'inbox-triage' ? countInboxRequests(eventPaths) : 0,
      response_p50_ms: null,
      classification_accuracy: null,
    };
    const anomalies = detectAnomalies(roleConfig, { assignee, authoring, inbox_triage: inbox });

    agents[agent] = {
      tasks_completed: completed,
      tasks_pending: pending,
      tasks_in_progress: inProgress,
      errors_today: errorsToday,
      heartbeat_stale: heartbeatStale,
      role: {
        role_type: roleConfig.role_type,
        primary_kpi: roleConfig.primary_kpi,
        assignee,
        authoring,
        inbox_triage: inbox,
        anomalies,
      },
    };
  }

  // Count pending approvals — same org-scoping rationale as taskDirs above.
  // Cross-org approval rollups would inflate `approvals_pending` for a
  // single-org report. Use the org's approvals dir when org is set, the
  // root one otherwise.
  let approvalsPending = 0;
  const approvalPaths: string[] = [];
  if (org) {
    const p = join(orgsDir, org, 'approvals', 'pending');
    if (existsSync(p)) approvalPaths.push(p);
  } else {
    const p = join(ctxRoot, 'approvals', 'pending');
    if (existsSync(p)) approvalPaths.push(p);
  }
  for (const apDir of approvalPaths) {
    if (existsSync(apDir)) {
      try {
        approvalsPending += readdirSync(apDir).filter(f => f.endsWith('.json')).length;
      } catch { /* ignore */ }
    }
  }

  const report: MetricsReport = {
    timestamp,
    agents,
    system: {
      total_tasks_completed: totalCompleted,
      agents_healthy: agentsHealthy,
      agents_total: agentsTotal,
      approvals_pending: approvalsPending,
    },
  };

  // Write to analytics reports
  const orgBase = org ? join(ctxRoot, 'orgs', org) : ctxRoot;
  const reportsDir = join(orgBase, 'analytics', 'reports');
  ensureDir(reportsDir);
  writeFileSync(join(reportsDir, 'latest.json'), JSON.stringify(report, null, 2) + '\n', 'utf-8');

  // Also write system-wide report if org-scoped
  if (org) {
    const systemReports = join(ctxRoot, 'analytics', 'reports');
    ensureDir(systemReports);
    writeFileSync(join(systemReports, 'latest.json'), JSON.stringify(report, null, 2) + '\n', 'utf-8');
  }

  return report;
}

// --- scrapeUsage ---

/**
 * Parse Claude Code /usage output text.
 * This is the parsing logic; the actual tmux interaction is handled by the daemon.
 */
export function parseUsageOutput(output: string, agentName: string): UsageData {
  const timestamp = new Date().toISOString();

  // Parse session percentage
  const sessionMatch = output.match(/Current session[\s\S]*?(\d+)%/);
  const sessionPct = sessionMatch ? parseInt(sessionMatch[1], 10) : 0;

  // Parse week all-models percentage
  const weekMatch = output.match(/Current week.*all[\s\S]*?(\d+)%/i);
  const weekPct = weekMatch ? parseInt(weekMatch[1], 10) : 0;

  // Parse week sonnet percentage
  const sonnetMatch = output.match(/Current week.*Sonnet[\s\S]*?(\d+)%/i);
  const sonnetPct = sonnetMatch ? parseInt(sonnetMatch[1], 10) : 0;

  // Parse reset times
  const sessionResetMatch = output.match(/Current session[\s\S]*?Resets\s+(.*)/);
  const sessionReset = sessionResetMatch ? sessionResetMatch[1].trim() : '';

  const weekResetMatch = output.match(/Current week.*all[\s\S]*?Resets\s+(.*)/i);
  const weekReset = weekResetMatch ? weekResetMatch[1].trim() : '';

  return {
    agent: agentName,
    timestamp,
    session: { used_pct: sessionPct, resets: sessionReset },
    week_all_models: { used_pct: weekPct, resets: weekReset },
    week_sonnet: { used_pct: sonnetPct },
  };
}

/**
 * Store scraped usage data to state files.
 */
export function storeUsageData(ctxRoot: string, data: UsageData): void {
  const usageDir = join(ctxRoot, 'state', 'usage');
  ensureDir(usageDir);

  // Write latest
  writeFileSync(join(usageDir, 'latest.json'), JSON.stringify(data, null, 2) + '\n', 'utf-8');

  // Append to daily log
  const today = data.timestamp.split('T')[0];
  const dailyPath = join(usageDir, `${today}.jsonl`);
  const line = JSON.stringify(data) + '\n';
  try {
    appendFileSync(dailyPath, line, 'utf-8');
  } catch {
    writeFileSync(dailyPath, line, 'utf-8');
  }
}

// --- checkUpstream ---

/**
 * Check for upstream framework updates.
 * This function performs git operations in the given directory.
 * Returns structured diff information for the agent to present.
 */
export function checkUpstream(
  frameworkRoot: string,
  options: { apply?: boolean } = {},
): UpstreamResult {
  const execOpts = { cwd: frameworkRoot, encoding: 'utf-8' as const, timeout: 30000 };

  // Check if it's a git repo
  try {
    execSync('git rev-parse --is-inside-work-tree', { ...execOpts, stdio: 'pipe' });
  } catch {
    return { status: 'error', error: 'not a git repository' };
  }

  // Check upstream remote
  try {
    execSync('git remote get-url upstream', { ...execOpts, stdio: 'pipe' });
  } catch {
    return { status: 'error', error: 'no upstream remote configured', hint: 'Run: git remote add upstream <canonical-repo-url>' };
  }

  // Fetch upstream
  try {
    execSync('git fetch upstream main', { ...execOpts, stdio: 'pipe' });
  } catch {
    return { status: 'error', error: 'failed to fetch upstream', hint: 'Check network and repo access' };
  }

  // Compare heads
  let localHead: string, upstreamHead: string;
  try {
    localHead = execSync('git rev-parse HEAD', { ...execOpts, stdio: 'pipe' }).trim();
    upstreamHead = execSync('git rev-parse upstream/main', { ...execOpts, stdio: 'pipe' }).trim();
  } catch {
    return { status: 'error', error: 'failed to resolve HEAD or upstream/main' };
  }

  if (localHead === upstreamHead) {
    return { status: 'up_to_date', message: 'No upstream changes available' };
  }

  // Count changes
  let commitCount = 0;
  try {
    commitCount = parseInt(execSync('git rev-list HEAD..upstream/main --count', { ...execOpts, stdio: 'pipe' }).trim(), 10);
  } catch { /* default 0 */ }

  let diffStat = '';
  try {
    const stat = execSync('git diff HEAD..upstream/main --stat', { ...execOpts, stdio: 'pipe' });
    const lines = stat.trim().split('\n');
    diffStat = lines[lines.length - 1] || '';
  } catch { /* ignore */ }

  // Categorize changed files
  let changedFiles: string[] = [];
  try {
    changedFiles = execSync('git diff HEAD..upstream/main --name-only', { ...execOpts, stdio: 'pipe' })
      .trim().split('\n').filter(Boolean);
  } catch { /* ignore */ }

  const changes = {
    bus: [] as string[],
    scripts: [] as string[],
    templates: [] as string[],
    skills: [] as string[],
    community: [] as string[],
    other: [] as string[],
  };

  for (const file of changedFiles) {
    if (file.startsWith('bus/')) changes.bus.push(file);
    else if (file.startsWith('scripts/')) changes.scripts.push(file);
    else if (file.startsWith('templates/')) changes.templates.push(file);
    else if (file.startsWith('skills/')) changes.skills.push(file);
    else if (file.startsWith('community/')) changes.community.push(file);
    else changes.other.push(file);
  }

  // Commit log
  let commitLog = '';
  try {
    commitLog = execSync('git log HEAD..upstream/main --oneline', { ...execOpts, stdio: 'pipe' }).trim();
  } catch { /* ignore */ }

  // Detect new catalog items in upstream vs local
  function getCatalogItems(source: 'local' | 'upstream'): CatalogAddition[] {
    try {
      let raw: string;
      if (source === 'upstream') {
        raw = execSync('git show upstream/main:community/catalog.json', { ...execOpts, stdio: 'pipe' });
      } else {
        const localPath = join(frameworkRoot, 'community', 'catalog.json');
        if (!existsSync(localPath)) return [];
        raw = readFileSync(localPath, 'utf-8');
      }
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed.items) ? parsed.items : [];
    } catch {
      return [];
    }
  }

  // If --apply: merge upstream
  if (options.apply) {
    if (process.env.CORTEXTOS_CONFIRM_UPSTREAM_MERGE !== 'yes') {
      return {
        status: 'error',
        error: 'Refusing to auto-merge upstream. Review the diff first (run without --apply), then re-run with CORTEXTOS_CONFIRM_UPSTREAM_MERGE=yes if you trust the changes.',
      };
    }
    const localItems = getCatalogItems('local');
    const localNames = new Set(localItems.map((i: CatalogAddition) => i.name));
    try {
      execSync('git merge upstream/main --no-edit', { ...execOpts, stdio: 'pipe' });
      // After merge, read updated catalog and surface new items
      const mergedItems = getCatalogItems('local');
      const catalog_additions = mergedItems.filter((i: CatalogAddition) => !localNames.has(i.name));
      return {
        status: 'merged',
        commits: commitCount,
        message: 'Upstream changes applied successfully',
        ...(catalog_additions.length > 0 ? { catalog_additions } : {}),
      };
    } catch {
      try { execSync('git merge --abort', { ...execOpts, stdio: 'pipe' }); } catch { /* ignore */ }
      return { status: 'conflict', message: 'Merge conflicts detected. Resolve conversationally with user.' };
    }
  }

  // Dry-run: surface new catalog items in upstream vs local
  const localItems = getCatalogItems('local');
  const localNames = new Set(localItems.map((i: CatalogAddition) => i.name));
  const upstreamItems = getCatalogItems('upstream');
  const catalog_additions = upstreamItems.filter((i: CatalogAddition) => !localNames.has(i.name));

  return {
    status: 'updates_available',
    commits: commitCount,
    diff_stat: diffStat,
    commit_log: commitLog,
    changes,
    ...(catalog_additions.length > 0 ? { catalog_additions } : {}),
  };
}

// --- registerTelegramCommands ---

/**
 * Scan directories for skills/commands, parse YAML frontmatter,
 * and build a list of Telegram bot commands to register.
 * The actual API call is separate (requires bot token).
 */
export function collectTelegramCommands(scanDirs: string[]): { command: string; description: string }[] {
  const seen = new Set<string>();
  const commands: { command: string; description: string }[] = [];

  for (const dir of scanDirs) {
    if (!existsSync(dir)) continue;

    const skillFiles = collectSkillFiles(dir);
    for (const file of skillFiles) {
      const parsed = parseSkillFrontmatter(file);
      if (!parsed) continue;
      if (parsed.userInvocable === false) continue;

      let name = parsed.name || deriveNameFromPath(file);
      if (!name) continue;

      const cmd = sanitizeCommand(name);
      if (!cmd || seen.has(cmd)) continue;
      seen.add(cmd);

      const description = (parsed.description || `Skill: ${name}`).slice(0, 256);
      commands.push({ command: cmd, description });
    }
  }

  return commands;
}

/**
 * Register commands with Telegram Bot API.
 */
export async function registerTelegramCommands(
  botToken: string,
  commands: { command: string; description: string }[],
): Promise<RegisterCommandsResult> {
  if (commands.length === 0) {
    return { status: 'empty', count: 0, commands: [], error: 'No commands found to register' };
  }

  try {
    // Register under all_private_chats scope so the / menu appears in private bot chats.
    // The default scope alone is insufficient — Telegram shows commands from the most
    // specific matching scope, and all_private_chats takes precedence over default.
    const response = await fetch(`https://api.telegram.org/bot${botToken}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands, scope: { type: 'all_private_chats' } }),
    });

    const data = await response.json() as { ok: boolean; description?: string };
    if (data.ok) {
      return { status: 'ok', count: commands.length, commands };
    } else {
      return { status: 'error', count: 0, commands, error: data.description || 'Failed to register commands with Telegram' };
    }
  } catch (err) {
    return { status: 'error', count: 0, commands, error: String(err) };
  }
}

// --- Internal helpers ---

function collectSkillFiles(dir: string): string[] {
  const files: string[] = [];

  // .claude/commands/*.md
  const cmdDir = join(dir, '.claude', 'commands');
  if (existsSync(cmdDir)) {
    try {
      for (const f of readdirSync(cmdDir)) {
        if (f.endsWith('.md')) files.push(join(cmdDir, f));
      }
    } catch { /* ignore */ }
  }

  // .codex/prompts/*.md and .codex/commands/*.md (issue #329)
  // Codex CLI exposes user prompts via `.codex/prompts/`; some templates also
  // ship a `.codex/commands/` dir mirroring the .claude convention. Both feed
  // the Telegram setMyCommands call so codex-runtime agents get a slash menu.
  for (const sub of ['prompts', 'commands']) {
    const codexDir = join(dir, '.codex', sub);
    if (existsSync(codexDir)) {
      try {
        for (const f of readdirSync(codexDir)) {
          if (f.endsWith('.md')) files.push(join(codexDir, f));
        }
      } catch { /* ignore */ }
    }
  }

  // .claude/skills/*/SKILL.md
  const claudeSkillsDir = join(dir, '.claude', 'skills');
  if (existsSync(claudeSkillsDir)) {
    try {
      for (const entry of readdirSync(claudeSkillsDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const skillFile = join(claudeSkillsDir, entry.name, 'SKILL.md');
          if (existsSync(skillFile)) files.push(skillFile);
        }
      }
    } catch { /* ignore */ }
  }

  // skills/*/SKILL.md
  const skillsDir = join(dir, 'skills');
  if (existsSync(skillsDir)) {
    try {
      for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const skillFile = join(skillsDir, entry.name, 'SKILL.md');
          if (existsSync(skillFile)) files.push(skillFile);
        }
      }
    } catch { /* ignore */ }
  }

  return files;
}

function parseSkillFrontmatter(filePath: string): { name?: string; description?: string; userInvocable?: boolean } | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    let inFrontmatter = false;
    let name: string | undefined;
    let description: string | undefined;
    let userInvocable: boolean | undefined;
    let readingMultiline = '';
    let multilineValue = '';

    for (const line of lines) {
      if (line.trim() === '---') {
        if (inFrontmatter) {
          // Flush multiline
          if (readingMultiline === 'description') description = multilineValue.trim();
          else if (readingMultiline === 'name') name = multilineValue.trim();
          break;
        }
        inFrontmatter = true;
        continue;
      }
      if (!inFrontmatter) continue;

      // Multi-line continuation
      if (readingMultiline && /^\s/.test(line)) {
        multilineValue += ' ' + line.trim();
        continue;
      } else if (readingMultiline) {
        if (readingMultiline === 'description') description = multilineValue.trim();
        else if (readingMultiline === 'name') name = multilineValue.trim();
        readingMultiline = '';
        multilineValue = '';
      }

      // Parse fields
      const nameMatch = line.match(/^name:\s*["']?(.+?)["']?\s*$/);
      if (nameMatch) { name = nameMatch[1]; continue; }

      const descMatch = line.match(/^description:\s*(.+)$/);
      if (descMatch) {
        const val = descMatch[1].trim().replace(/^["']|["']$/g, '');
        if (/^[>|]-?$/.test(val)) {
          readingMultiline = 'description';
          multilineValue = '';
        } else {
          description = val;
        }
        continue;
      }

      const invMatch = line.match(/^user-invocable:\s*(.+)$/);
      if (invMatch) {
        userInvocable = invMatch[1].trim() !== 'false';
      }
    }

    return { name, description, userInvocable };
  } catch {
    return null;
  }
}

function deriveNameFromPath(filePath: string): string {
  const base = basename(filePath);
  if (base === 'SKILL.md') {
    return basename(dirname(filePath));
  }
  return base.replace(/\.md$/, '');
}

function sanitizeCommand(name: string): string {
  return name.toLowerCase().replace(/-/g, '_').replace(/[^a-z0-9_]/g, '').slice(0, 32);
}
