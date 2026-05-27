import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { hostname } from 'os';
import type { Heartbeat, BusPaths, Task } from '../types/index.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { broadcastPresence, isUuid, uuidv5 } from './rgos-mirror.js';

/**
 * Update heartbeat for the current agent.
 * Writes to: {ctxRoot}/state/{agent}/heartbeat.json
 * Matches bash update-heartbeat.sh format exactly.
 *
 * Also fire-and-forgets an upsert to orch_agent_heartbeats in Supabase
 * (when SUPABASE_RGOS_URL + SUPABASE_RGOS_SERVICE_KEY are present) so that
 * remote agents on other VMs are visible in `cortextos bus list-agents`.
 * The upsert is keyed on (instance_id, agent_name) — the same agent name can
 * run on multiple VMs without collision.
 */
export async function updateHeartbeat(
  paths: BusPaths,
  agentName: string,
  status: string,
  options?: { org?: string; timezone?: string; loopInterval?: string; currentTask?: string; displayName?: string },
): Promise<void> {
  ensureDir(paths.stateDir);

  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const mode = options?.timezone ? detectDayNightMode(options.timezone) : detectDayNightMode('UTC');
  const explicitCurrentTask = options?.currentTask?.trim() ?? '';
  const activeTask = resolveCurrentTask(paths, agentName, explicitCurrentTask);
  const currentTaskText = explicitCurrentTask || (activeTask ? `${activeTask.id}: ${activeTask.title}` : '');

  const heartbeat: Heartbeat = {
    agent: agentName,
    org: options?.org ?? '',
    ...(options?.displayName ? { display_name: options.displayName } : {}),
    status,
    current_task: currentTaskText,
    mode,
    last_heartbeat: ts,
    loop_interval: options?.loopInterval ?? '',
  };

  atomicWriteSync(
    join(paths.stateDir, 'heartbeat.json'),
    JSON.stringify(heartbeat),
  );

  // Fire-and-forget Supabase upsert — no-ops gracefully if env vars are absent.
  pushHeartbeatToSupabase(agentName, heartbeat).catch(() => {
    // Intentionally swallowed: Supabase unavailability must not affect local operation.
  });
  pushAgentStatusToSupabase(agentName, heartbeat, activeTask).catch(() => {
    // Intentionally swallowed: Supabase unavailability must not affect local operation.
  });

  // Await presence broadcast so the WS has time to flush before process.exit(0).
  // PRESENCE_TTL_MS on the Hub side is 90s; heartbeat fires every 10m so this
  // keeps the board non-empty while agents are active.
  try {
    const actionLabel = activeTask ? `Working: ${activeTask.title.slice(0, 60)}` : status || 'online';
    await broadcastPresence({
      agent_id: agentName,
      current_action: activeTask ? 'task_updated' : 'idle',
      current_task_id: activeTask?.id ?? null,
      cursor_position_hint: actionLabel,
      ts,
      anchor_task_id: activeTask?.id ?? null,
      actor_id: agentName,
      kind: 'agent',
      name: agentName,
      avatar_url: null,
      task_id: activeTask?.id ?? null,
      task_title: activeTask?.title.slice(0, 80) ?? null,
      status: activeTask ? 'task_updated' : 'idle',
      action_label: actionLabel,
      updated_at: ts,
      source: 'cortextos-bus',
    });
    await new Promise(r => setTimeout(r, 750));
  } catch {
    // Presence broadcast failure must not affect local heartbeat
  }
}

interface ActiveTaskRef {
  id: string;
  mirroredId: string;
  title: string;
}

function taskSortTime(task: Task): number {
  return new Date(task.updated_at || task.created_at).getTime();
}

function parseCurrentTaskRef(currentTask: string): ActiveTaskRef | null {
  const match = currentTask.match(/^\s*([A-Za-z0-9_-]+|[0-9a-f-]{36})\s*:\s*(.+)$/i);
  if (!match) return null;
  const id = match[1];
  return {
    id,
    mirroredId: isUuid(id) ? id : uuidv5(id),
    title: match[2].trim(),
  };
}

function resolveCurrentTask(paths: BusPaths, agentName: string, currentTask: string): ActiveTaskRef | null {
  const explicit = parseCurrentTaskRef(currentTask);
  if (explicit) return explicit;

  const taskDirs = [paths.taskDir, join(paths.ctxRoot, 'tasks')]
    .filter((dir, index, list) => dir && list.indexOf(dir) === index);
  const tasks: Task[] = [];

  for (const taskDir of taskDirs) {
    if (!existsSync(taskDir)) continue;
    let files: string[];
    try {
      files = readdirSync(taskDir).filter(file => file.startsWith('task_') && file.endsWith('.json'));
    } catch {
      continue;
    }

    for (const file of files) {
      try {
        const task = JSON.parse(readFileSync(join(taskDir, file), 'utf-8')) as Task;
        if (task.archived) continue;
        if (task.status !== 'in_progress') continue;
        if (task.assigned_to !== agentName) continue;
        tasks.push(task);
      } catch {
        // Skip corrupt task files.
      }
    }
  }

  tasks.sort((a, b) => taskSortTime(b) - taskSortTime(a));
  const task = tasks[0];
  if (!task) return null;
  return {
    id: task.id,
    mirroredId: isUuid(task.id) ? task.id : uuidv5(task.id),
    title: task.title,
  };
}

/**
 * Push a heartbeat row to orch_agent_heartbeats in Supabase.
 * Keyed on (instance_id, agent_name) — safe for same-name agents on different VMs.
 * No-ops when SUPABASE_RGOS_URL or SUPABASE_RGOS_SERVICE_KEY are absent.
 */
async function pushHeartbeatToSupabase(agentName: string, hb: Heartbeat): Promise<void> {
  const url = process.env.SUPABASE_RGOS_URL;
  const key = process.env.SUPABASE_RGOS_SERVICE_KEY;
  if (!url || !key) return;

  const instanceId = process.env.CTX_INSTANCE_ID || 'default';

  const row = {
    instance_id: instanceId,
    agent_name: agentName,
    org: hb.org ?? '',
    host: hostname(),
    status: hb.status,
    current_task: hb.current_task ?? '',
    mode: hb.mode,
    loop_interval: hb.loop_interval ?? '',
    last_heartbeat: hb.last_heartbeat,
    updated_at: new Date().toISOString(),
  };

  const endpoint = `${url}/rest/v1/orch_agent_heartbeats`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${key}`,
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify(row),
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) {
    throw new Error(`Supabase upsert failed: ${response.status}`);
  }
}

/**
 * Keep RGOS orch_agents in sync with the same task-store fallback used by
 * local fleet views. This table powers AgentOps fleet status; without this
 * patch a healthy local task store can show in-progress work while
 * orch_agents.current_task_id remains null, making every active agent look idle.
 */
async function pushAgentStatusToSupabase(
  agentName: string,
  hb: Heartbeat,
  activeTask: ActiveTaskRef | null,
): Promise<void> {
  const url = process.env.SUPABASE_RGOS_URL;
  const key = process.env.SUPABASE_RGOS_SERVICE_KEY;
  if (!url || !key) return;

  const roleId = `cortextos-${agentName}`;
  const row = {
    is_active: true,
    current_task_id: activeTask?.mirroredId ?? null,
    last_heartbeat: hb.last_heartbeat,
    config_json: {
      mode: hb.mode,
      source: 'cortextos',
      current_task: hb.current_task || null,
      current_task_bus_id: activeTask?.id ?? null,
    },
    updated_at: new Date().toISOString(),
  };

  const endpoint = `${url}/rest/v1/orch_agents?role_id=eq.${encodeURIComponent(roleId)}`;
  const response = await fetch(endpoint, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${key}`,
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(row),
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) {
    throw new Error(`Supabase orch_agents update failed: ${response.status}`);
  }
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

// ── Remote heartbeat types ────────────────────────────────────────────────────

export interface RemoteHeartbeatRow {
  instance_id: string;
  agent_name: string;
  org: string;
  host: string;
  status: string;
  current_task: string;
  mode: string;
  loop_interval: string;
  last_heartbeat: string;
}

/**
 * Fetch heartbeat rows from Supabase for agents NOT running on this instance.
 * Returns [] when SUPABASE_RGOS_URL / SUPABASE_RGOS_SERVICE_KEY are absent or
 * the request fails — callers always get at least the local result.
 */
export async function fetchRemoteHeartbeats(): Promise<RemoteHeartbeatRow[]> {
  const url = process.env.SUPABASE_RGOS_URL;
  const key = process.env.SUPABASE_RGOS_SERVICE_KEY;
  if (!url || !key) return [];

  const instanceId = process.env.CTX_INSTANCE_ID || 'default';

  try {
    const endpoint =
      `${url}/rest/v1/orch_agent_heartbeats?instance_id=neq.${encodeURIComponent(instanceId)}&select=*`;
    const response = await fetch(endpoint, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return [];
    return (await response.json()) as RemoteHeartbeatRow[];
  } catch {
    return [];
  }
}
