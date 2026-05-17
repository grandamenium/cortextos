// cortextOS Dashboard - JSON/JSONL to Postgres sync engine
// Bridges agent-written files on disk with the Postgres read cache.
// On Vercel (no CTX_ROOT), all sync functions are no-ops.

import fs from 'fs';
import path from 'path';
import { sql } from './db';
import {
  CTX_ROOT,
  getOrgs,
  getAgentsForOrg,
  getTaskDir,
  getApprovalDir,
  getEventsDir,
  getHeartbeatPath,
} from './config';

// ---------------------------------------------------------------------------
// Mtime tracking helpers
// ---------------------------------------------------------------------------

async function hasFileChanged(filePath: string): Promise<boolean> {
  try {
    const stat = fs.statSync(filePath);
    const [row] = await sql<{ mtime: number }[]>`
      SELECT mtime FROM sync_meta WHERE file_path = ${filePath}
    `;
    return !row || row.mtime < stat.mtimeMs;
  } catch {
    return false;
  }
}

async function markSynced(filePath: string): Promise<void> {
  const stat = fs.statSync(filePath);
  await sql`
    INSERT INTO sync_meta (file_path, mtime, last_synced)
    VALUES (${filePath}, ${stat.mtimeMs}, NOW()::TEXT)
    ON CONFLICT (file_path) DO UPDATE SET mtime = EXCLUDED.mtime, last_synced = EXCLUDED.last_synced
  `;
}

// ---------------------------------------------------------------------------
// Task sync
// ---------------------------------------------------------------------------

export async function syncTasks(org: string): Promise<number> {
  if (!CTX_ROOT) return 0;
  const taskDir = getTaskDir(org);
  console.log(`[sync] syncTasks org=${org} dir=${taskDir} exists=${fs.existsSync(taskDir)}`);
  if (!fs.existsSync(taskDir)) return 0;

  let synced = 0;
  const activePaths: string[] = [];
  const files = fs.readdirSync(taskDir).filter((f) => f.endsWith('.json'));
  console.log(`[sync] Found ${files.length} task files in ${taskDir}`);

  for (const file of files) {
    const filePath = path.join(taskDir, file);
    activePaths.push(filePath);
    if (!(await hasFileChanged(filePath))) continue;

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const task = JSON.parse(raw);
      await sql`
        INSERT INTO tasks
          (id, title, description, status, priority, assignee, org, project, needs_approval,
           created_at, updated_at, completed_at, notes, source_file)
        VALUES
          (${task.id ?? path.basename(file, '.json')},
           ${task.title ?? 'Untitled'},
           ${task.description ?? null},
           ${task.status ?? 'pending'},
           ${task.priority ?? 'normal'},
           ${task.assigned_to ?? task.assignee ?? null},
           ${org},
           ${task.project ?? null},
           ${task.needs_approval ? 1 : 0},
           ${task.created_at ?? new Date().toISOString()},
           ${task.updated_at ?? null},
           ${task.completed_at ?? null},
           ${task.notes ?? null},
           ${filePath})
        ON CONFLICT (id) DO UPDATE SET
          title = EXCLUDED.title,
          description = EXCLUDED.description,
          status = EXCLUDED.status,
          priority = EXCLUDED.priority,
          assignee = EXCLUDED.assignee,
          org = EXCLUDED.org,
          project = EXCLUDED.project,
          needs_approval = EXCLUDED.needs_approval,
          created_at = EXCLUDED.created_at,
          updated_at = EXCLUDED.updated_at,
          completed_at = EXCLUDED.completed_at,
          notes = EXCLUDED.notes,
          source_file = EXCLUDED.source_file
      `;
      await markSynced(filePath);
      synced++;
    } catch (err) {
      console.error(`[sync] Failed to sync task ${file}:`, err);
    }
  }

  // Prune rows whose source files no longer exist on disk
  if (activePaths.length > 0) {
    await sql`DELETE FROM tasks WHERE org = ${org} AND source_file NOT IN ${sql(activePaths)}`;
  } else {
    await sql`DELETE FROM tasks WHERE org = ${org}`;
  }

  return synced;
}

// ---------------------------------------------------------------------------
// Approval sync
// ---------------------------------------------------------------------------

export async function syncApprovals(org: string): Promise<number> {
  if (!CTX_ROOT) return 0;
  const approvalDir = getApprovalDir(org);
  let synced = 0;

  for (const subdir of ['pending', 'resolved'] as const) {
    const dir = path.join(approvalDir, subdir);
    if (!fs.existsSync(dir)) continue;

    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      const filePath = path.join(dir, file);
      if (!(await hasFileChanged(filePath))) continue;

      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const approval = JSON.parse(raw);
        await sql`
          INSERT INTO approvals
            (id, title, category, description, status, agent, org,
             created_at, resolved_at, resolved_by, resolution_note, source_file)
          VALUES
            (${approval.id ?? path.basename(file, '.json')},
             ${approval.title ?? 'Untitled'},
             ${approval.category ?? 'other'},
             ${approval.description ?? null},
             ${subdir === 'pending' ? 'pending' : (approval.status ?? 'approved')},
             ${approval.requesting_agent ?? approval.agent ?? 'unknown'},
             ${org},
             ${approval.created_at ?? new Date().toISOString()},
             ${approval.resolved_at ?? null},
             ${approval.resolved_by ?? null},
             ${approval.resolution_note ?? null},
             ${filePath})
          ON CONFLICT (id) DO UPDATE SET
            title = EXCLUDED.title,
            category = EXCLUDED.category,
            description = EXCLUDED.description,
            status = EXCLUDED.status,
            agent = EXCLUDED.agent,
            org = EXCLUDED.org,
            created_at = EXCLUDED.created_at,
            resolved_at = EXCLUDED.resolved_at,
            resolved_by = EXCLUDED.resolved_by,
            resolution_note = EXCLUDED.resolution_note,
            source_file = EXCLUDED.source_file
        `;
        await markSynced(filePath);
        synced++;
      } catch (err) {
        console.error(`[sync] Failed to sync approval ${file}:`, err);
      }
    }
  }

  return synced;
}

// ---------------------------------------------------------------------------
// Event sync (JSONL)
// ---------------------------------------------------------------------------

export async function syncEvents(org: string, agent: string): Promise<number> {
  if (!CTX_ROOT) return 0;
  const eventsDir = getEventsDir(org, agent);
  if (!fs.existsSync(eventsDir)) return 0;

  let synced = 0;
  const files = fs.readdirSync(eventsDir).filter((f) => f.endsWith('.jsonl'));

  for (const file of files) {
    const filePath = path.join(eventsDir, file);
    if (!(await hasFileChanged(filePath))) continue;

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const lines = raw.split('\n').filter((l) => l.trim());

      for (let i = 0; i < lines.length; i++) {
        try {
          const event = JSON.parse(lines[i]);
          const eventId = event.id ?? `${agent}-${file}-${i}`;
          await sql`
            INSERT INTO events
              (id, timestamp, agent, org, type, category, severity, data, message, source_file)
            VALUES
              (${eventId},
               ${event.timestamp ?? new Date().toISOString()},
               ${event.agent ?? agent},
               ${org},
               ${event.category ?? event.type ?? 'action'},
               ${event.category ?? null},
               ${event.severity ?? 'info'},
               ${event.metadata ? JSON.stringify(event.metadata) : (event.data ? JSON.stringify(event.data) : null)},
               ${event.event ?? event.message ?? null},
               ${filePath})
            ON CONFLICT (id) DO NOTHING
          `;
          synced++;
        } catch {
          console.warn(`[sync] Skipping malformed JSONL line ${i} in ${filePath}`);
        }
      }
      await markSynced(filePath);
    } catch (err) {
      console.error(`[sync] Failed to sync events ${file}:`, err);
    }
  }

  return synced;
}

// ---------------------------------------------------------------------------
// Heartbeat sync
// ---------------------------------------------------------------------------

export async function syncHeartbeat(agent: string): Promise<boolean> {
  if (!CTX_ROOT) return false;
  const heartbeatPath = getHeartbeatPath(agent);
  if (!fs.existsSync(heartbeatPath)) return false;
  if (!(await hasFileChanged(heartbeatPath))) return false;

  try {
    const raw = fs.readFileSync(heartbeatPath, 'utf-8');
    const hb = JSON.parse(raw);

    await sql`
      INSERT INTO heartbeats
        (agent, org, status, current_task, mode, last_heartbeat, loop_interval, uptime_seconds)
      VALUES
        (${agent},
         ${hb.org ?? ''},
         ${hb.status ?? null},
         ${hb.current_task ?? null},
         ${hb.mode ?? null},
         ${hb.last_heartbeat ?? hb.timestamp ?? null},
         ${hb.loop_interval ?? null},
         ${hb.uptime_seconds ?? null})
      ON CONFLICT (agent) DO UPDATE SET
        org = EXCLUDED.org,
        status = EXCLUDED.status,
        current_task = EXCLUDED.current_task,
        mode = EXCLUDED.mode,
        last_heartbeat = EXCLUDED.last_heartbeat,
        loop_interval = EXCLUDED.loop_interval,
        uptime_seconds = EXCLUDED.uptime_seconds
    `;
    await markSynced(heartbeatPath);
    return true;
  } catch (err) {
    console.error(`[sync] Failed to sync heartbeat for ${agent}:`, err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Full sync
// ---------------------------------------------------------------------------

export interface SyncResult {
  tasks: number;
  approvals: number;
  events: number;
  heartbeats: number;
}

export async function syncAll(): Promise<SyncResult> {
  if (!CTX_ROOT) return { tasks: 0, approvals: 0, events: 0, heartbeats: 0 };

  const results: SyncResult = { tasks: 0, approvals: 0, events: 0, heartbeats: 0 };

  const orgs = getOrgs();
  for (const org of orgs) {
    results.tasks += await syncTasks(org);
    results.approvals += await syncApprovals(org);

    const eventsBaseDir = path.join(CTX_ROOT, 'orgs', org, 'analytics', 'events');
    if (fs.existsSync(eventsBaseDir)) {
      const eventAgentDirs = fs
        .readdirSync(eventsBaseDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
      for (const agent of eventAgentDirs) {
        results.events += await syncEvents(org, agent);
      }
    }
  }

  const stateDir = path.join(CTX_ROOT, 'state');
  if (fs.existsSync(stateDir)) {
    const agentDirs = fs
      .readdirSync(stateDir, { withFileTypes: true })
      .filter((d) => d.isDirectory());
    for (const agentDir of agentDirs) {
      if (await syncHeartbeat(agentDir.name)) results.heartbeats++;
    }
  }

  // Backfill empty org in heartbeats from enabled-agents.json
  try {
    const enabledFile = path.join(CTX_ROOT, 'config', 'enabled-agents.json');
    if (fs.existsSync(enabledFile)) {
      const enabled = JSON.parse(fs.readFileSync(enabledFile, 'utf-8'));
      for (const [name, config] of Object.entries(enabled)) {
        const agentOrg = (config as Record<string, string>).org ?? '';
        if (agentOrg) {
          await sql`UPDATE heartbeats SET org = ${agentOrg} WHERE agent = ${name} AND (org IS NULL OR org = '')`;
        }
      }
    }
  } catch {
    // Best effort
  }

  console.log(`[sync] Full sync complete:`, results);
  return results;
}

// ---------------------------------------------------------------------------
// Lazy cost sync (only called from Analytics page)
// ---------------------------------------------------------------------------

const COST_SYNC_INTERVAL_MS = 5 * 60 * 1000;

export async function syncCostsLazy(): Promise<void> {
  if (!CTX_ROOT) return;
  const now = Date.now();
  const lastCostSync = (globalThis as unknown as Record<string, number>).__lastCostSync ?? 0;
  if (now - lastCostSync > COST_SYNC_INTERVAL_MS) {
    try {
      const { syncCosts } = await import('./cost-parser');
      const costResult = await syncCosts();
      (globalThis as unknown as Record<string, number>).__lastCostSync = now;
      if (costResult.inserted > 0) {
        console.log(`[sync] Cost sync: ${costResult.scanned} scanned, ${costResult.inserted} inserted`);
      }
    } catch {
      // Cost sync is best-effort
    }
  }
}

// ---------------------------------------------------------------------------
// Single-file sync (called by file watcher)
// ---------------------------------------------------------------------------

export async function syncFile(filePath: string): Promise<void> {
  if (!CTX_ROOT) return;
  if (filePath.includes('/tasks/') && filePath.endsWith('.json')) {
    const org = extractOrgFromPath(filePath);
    if (org) await syncTasks(org);
  } else if (filePath.includes('/approvals/') && filePath.endsWith('.json')) {
    const org = extractOrgFromPath(filePath);
    if (org) await syncApprovals(org);
  } else if (filePath.includes('/analytics/events/') && filePath.endsWith('.jsonl')) {
    const { org, agent } = extractOrgAndAgentFromEventPath(filePath);
    if (org && agent) await syncEvents(org, agent);
  } else if (filePath.includes('/state/') && filePath.endsWith('heartbeat.json')) {
    const agent = extractAgentFromStatePath(filePath);
    if (agent) await syncHeartbeat(agent);
  }
}

// ---------------------------------------------------------------------------
// Path extraction helpers
// ---------------------------------------------------------------------------

export function extractOrgFromPath(filePath: string): string | null {
  const match = filePath.match(/\/orgs\/([^/]+)\//);
  return match ? match[1] : null;
}

export function extractOrgAndAgentFromEventPath(
  filePath: string,
): { org: string | null; agent: string | null } {
  const match = filePath.match(/\/orgs\/([^/]+)\/analytics\/events\/([^/]+)\//);
  return { org: match?.[1] ?? null, agent: match?.[2] ?? null };
}

export function extractAgentFromStatePath(filePath: string): string | null {
  const match = filePath.match(/\/state\/([^/]+)\//);
  return match ? match[1] : null;
}
