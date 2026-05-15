import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { Heartbeat, BusPaths } from '../types/index.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';

/**
 * Update heartbeat for the current agent.
 * Writes to: {ctxRoot}/state/{agent}/heartbeat.json
 * Matches bash update-heartbeat.sh format exactly.
 *
 * Path B watchdog (watchdog-threshold-tuning spec): also maintains
 * `task_started_at` independent of `last_heartbeat`. Set to `now` on every
 * current_task transition (empty→non-empty, or non-empty→different
 * non-empty); cleared to null when current_task is empty; preserved when
 * current_task is unchanged. The task-stuck watcher reads this to measure
 * "how long has this task been held" without being fooled by side-channel
 * heartbeat refreshes (send-telegram, send-message).
 */
export function updateHeartbeat(
  paths: BusPaths,
  agentName: string,
  status: string,
  options?: { org?: string; timezone?: string; loopInterval?: string; currentTask?: string; displayName?: string },
): void {
  ensureDir(paths.stateDir);

  // Single-writer assumption: each agent owns its own heartbeat path and is
  // the only writer (operator vs cron call sites all run inside the agent's
  // own session). The read-modify-write below is not synchronised, but no
  // concurrent writers exist by design.
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const mode = options?.timezone ? detectDayNightMode(options.timezone) : detectDayNightMode('UTC');
  const newCurrentTask = options?.currentTask ?? '';

  // Path B: compute task_started_at by reading the prior heartbeat (best-
  // effort; on read failure we treat it as a transition, which is safe — at
  // worst we re-stamp once on an existing task and the watcher resets its
  // clock once).
  const taskStartedAt = computeTaskStartedAt(paths, newCurrentTask, ts);

  const heartbeat: Heartbeat = {
    agent: agentName,
    org: options?.org ?? '',
    ...(options?.displayName ? { display_name: options.displayName } : {}),
    status,
    current_task: newCurrentTask,
    mode,
    last_heartbeat: ts,
    loop_interval: options?.loopInterval ?? '',
    task_started_at: taskStartedAt,
  };

  atomicWriteSync(
    join(paths.stateDir, 'heartbeat.json'),
    JSON.stringify(heartbeat),
  );
}

/**
 * Path B helper — derive task_started_at for the new heartbeat write.
 *
 * `fallbackTs` is the timestamp string the caller will write as
 * `last_heartbeat`; we reuse it when stamping a fresh transition so the two
 * fields stay coherent on the first write but diverge thereafter as
 * last_heartbeat ticks forward.
 *
 * Rules:
 *   - newCurrentTask === ''           → null (no active task)
 *   - prior unreadable / first write  → `fallbackTs` (treat as a transition)
 *   - prior.current_task !== new      → `fallbackTs` (transition)
 *   - prior.current_task === new      → prior.task_started_at (preserve;
 *                                       fall back to `fallbackTs` if prior
 *                                       didn't carry the field — legacy write)
 */
function computeTaskStartedAt(paths: BusPaths, newCurrentTask: string, fallbackTs: string): string | null {
  if (newCurrentTask === '') return null;
  // No existsSync precheck — TOCTOU window between the check and the read is
  // narrow but real; the catch already handles ENOENT cleanly.
  try {
    const prior = JSON.parse(readFileSync(join(paths.stateDir, 'heartbeat.json'), 'utf-8')) as Heartbeat;
    if (prior.current_task !== newCurrentTask) return fallbackTs;
    return prior.task_started_at ?? fallbackTs;
  } catch {
    return fallbackTs;
  }
}

/**
 * Path B watchdog wiring: stamp `current_task` on the agent's heartbeat
 * non-destructively, preserving the prior status / org / displayName /
 * loop_interval. Used by task-lifecycle bus commands (claim-task,
 * complete-task, update-task) so the field that Path B's watcher reads
 * actually gets populated as agents pick up and finish work. Pass
 * `newTask=''` to clear (task complete / cancelled).
 *
 * No-op when the agent has no prior heartbeat (first call wins on next
 * full update-heartbeat); we deliberately don't synthesize a heartbeat
 * here because we lack the timezone the agent was configured with.
 */
export function setHeartbeatCurrentTask(
  paths: BusPaths,
  agentName: string,
  newTask: string,
): void {
  let prior: Heartbeat | undefined;
  try {
    prior = JSON.parse(readFileSync(join(paths.stateDir, 'heartbeat.json'), 'utf-8')) as Heartbeat;
  } catch {
    return; // No prior heartbeat — skip silently; agent's next explicit update-heartbeat will set the field.
  }
  updateHeartbeat(paths, agentName, prior.status, {
    org: prior.org,
    currentTask: newTask,
    displayName: prior.display_name,
    loopInterval: prior.loop_interval,
  });
}

/**
 * Detect day/night mode based on timezone.
 * Day: 8:00 - 22:00, Night: 22:00 - 8:00
 */
export function detectDayNightMode(timezone: string): 'day' | 'night' {
  try {
    const now = new Date();
    const formatted = now.toLocaleString('en-US', { timeZone: timezone, hour12: false, hour: '2-digit' });
    const hour = parseInt(formatted, 10);
    return (hour >= 8 && hour < 22) ? 'day' : 'night';
  } catch {
    // Fallback to UTC
    const hour = new Date().getUTCHours();
    return (hour >= 8 && hour < 22) ? 'day' : 'night';
  }
}

/**
 * Read all agent heartbeats.
 * Scans state/ directory for agent subdirs containing heartbeat.json.
 * Matches dashboard heartbeat path: state/{agent}/heartbeat.json
 */
export function readAllHeartbeats(paths: BusPaths): Heartbeat[] {
  const heartbeats: Heartbeat[] = [];
  const stateDir = join(paths.ctxRoot, 'state');
  let agentDirs: string[];
  try {
    agentDirs = readdirSync(stateDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return [];
  }

  for (const agent of agentDirs) {
    const hbPath = join(stateDir, agent, 'heartbeat.json');
    try {
      const content = readFileSync(hbPath, 'utf-8');
      heartbeats.push(JSON.parse(content));
    } catch {
      // Skip agents without heartbeat
    }
  }

  return heartbeats;
}
