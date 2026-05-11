// cortextOS Dashboard - JSON/JSONL to SQLite sync engine
// Bridges agent-written files on disk with the SQLite read cache.

import fs from 'fs';
import path from 'path';
import { db } from './db';
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

function hasFileChanged(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    const row = db
      .prepare('SELECT mtime FROM sync_meta WHERE file_path = ?')
      .get(filePath) as { mtime: number } | undefined;
    return !row || row.mtime < stat.mtimeMs;
  } catch {
    return false; // file doesn't exist
  }
}

function markSynced(filePath: string): void {
  const stat = fs.statSync(filePath);
  db.prepare(
    `INSERT OR REPLACE INTO sync_meta (file_path, mtime, last_synced)
     VALUES (?, ?, datetime('now'))`,
  ).run(filePath, stat.mtimeMs);
}

// ---------------------------------------------------------------------------
// Task sync
// ---------------------------------------------------------------------------

export function syncTasks(org: string): number {
  const taskDir = getTaskDir(org);
  console.log(`[sync] syncTasks org=${org} dir=${taskDir} exists=${fs.existsSync(taskDir)}`);
  if (!fs.existsSync(taskDir)) return 0;

  let synced = 0;

  const upsert = db.prepare(`
    INSERT OR REPLACE INTO tasks
      (id, title, description, status, priority, assignee, org, project, needs_approval, created_at, updated_at, completed_at, notes, source_file)
    VALUES
      (@id, @title, @description, @status, @priority, @assignee, @org, @project, @needs_approval, @created_at, @updated_at, @completed_at, @notes, @source_file)
  `);

  const files = fs.readdirSync(taskDir).filter((f) => f.endsWith('.json'));
  console.log(`[sync] Found ${files.length} task files in ${taskDir}`);

  const run = db.transaction(() => {
    const activePaths: string[] = [];

    for (const file of files) {
      const filePath = path.join(taskDir, file);
      activePaths.push(filePath);
      if (!hasFileChanged(filePath)) continue;

      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const task = JSON.parse(raw);
        upsert.run({
          id: task.id ?? path.basename(file, '.json'),
          title: task.title ?? 'Untitled',
          description: task.description ?? null,
          status: task.status ?? 'pending',
          priority: task.priority ?? 'normal',
          assignee: task.assigned_to ?? task.assignee ?? null,
          org,
          project: task.project ?? null,
          needs_approval: task.needs_approval ? 1 : 0,
          created_at: task.created_at ?? new Date().toISOString(),
          updated_at: task.updated_at ?? null,
          completed_at: task.completed_at ?? null,
          notes: task.notes ?? null,
          source_file: filePath,
        });
        markSynced(filePath);
        synced++;
      } catch (err) {
        console.error(`[sync] Failed to sync task ${file}:`, err);
      }
    }

    // Prune rows whose source files no longer exist on disk
    if (activePaths.length > 0) {
      const placeholders = activePaths.map(() => '?').join(',');
      db.prepare(
        `DELETE FROM tasks WHERE org = ? AND source_file NOT IN (${placeholders})`,
      ).run(org, ...activePaths);
    } else {
      // No files at all — delete all tasks for this org
      db.prepare('DELETE FROM tasks WHERE org = ?').run(org);
    }
  });

  run();
  return synced;
}

// ---------------------------------------------------------------------------
// Approval sync
// ---------------------------------------------------------------------------

export function syncApprovals(org: string): number {
  const approvalDir = getApprovalDir(org);
  let synced = 0;

  const upsert = db.prepare(`
    INSERT OR REPLACE INTO approvals
      (id, title, category, description, status, agent, org, created_at, resolved_at, resolved_by, resolution_note, source_file)
    VALUES
      (@id, @title, @category, @description, @status, @agent, @org, @created_at, @resolved_at, @resolved_by, @resolution_note, @source_file)
  `);

  const run = db.transaction(() => {
    for (const subdir of ['pending', 'resolved'] as const) {
      const dir = path.join(approvalDir, subdir);
      if (!fs.existsSync(dir)) continue;

      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        const filePath = path.join(dir, file);
        if (!hasFileChanged(filePath)) continue;

        try {
          const raw = fs.readFileSync(filePath, 'utf-8');
          const approval = JSON.parse(raw);
          upsert.run({
            id: approval.id ?? path.basename(file, '.json'),
            title: approval.title ?? 'Untitled',
            category: approval.category ?? 'other',
            description: approval.description ?? null,
            status:
              subdir === 'pending'
                ? 'pending'
                : (approval.status ?? 'approved'),
            agent: approval.requesting_agent ?? approval.agent ?? 'unknown',
            org,
            created_at: approval.created_at ?? new Date().toISOString(),
            resolved_at: approval.resolved_at ?? null,
            resolved_by: approval.resolved_by ?? null,
            resolution_note: approval.resolution_note ?? null,
            source_file: filePath,
          });
          markSynced(filePath);
          synced++;
        } catch (err) {
          console.error(`[sync] Failed to sync approval ${file}:`, err);
        }
      }
    }
  });

  run();
  return synced;
}

// ---------------------------------------------------------------------------
// Event sync (JSONL)
// ---------------------------------------------------------------------------

export function syncEvents(org: string, agent: string): number {
  const eventsDir = getEventsDir(org, agent);
  if (!fs.existsSync(eventsDir)) return 0;

  let synced = 0;

  const upsert = db.prepare(`
    INSERT OR REPLACE INTO events
      (id, timestamp, agent, org, type, category, severity, data, message, source_file)
    VALUES
      (@id, @timestamp, @agent, @org, @type, @category, @severity, @data, @message, @source_file)
  `);

  const files = fs.readdirSync(eventsDir).filter((f) => f.endsWith('.jsonl'));

  const run = db.transaction(() => {
    for (const file of files) {
      const filePath = path.join(eventsDir, file);
      if (!hasFileChanged(filePath)) continue;

      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const lines = raw.split('\n').filter((l) => l.trim());

        for (let i = 0; i < lines.length; i++) {
          try {
            const event = JSON.parse(lines[i]);
            const eventId = event.id ?? `${agent}-${file}-${i}`;
            upsert.run({
              id: eventId,
              timestamp: event.timestamp ?? new Date().toISOString(),
              agent: event.agent ?? agent,
              org,
              type: event.category ?? event.type ?? 'action',
              category: event.category ?? null,
              severity: event.severity ?? 'info',
              data: event.metadata ? JSON.stringify(event.metadata) : (event.data ? JSON.stringify(event.data) : null),
              message: event.event ?? event.message ?? null,
              source_file: filePath,
            });
            synced++;
          } catch {
            console.warn(
              `[sync] Skipping malformed JSONL line ${i} in ${filePath}`,
            );
          }
        }
        markSynced(filePath);
      } catch (err) {
        console.error(`[sync] Failed to sync events ${file}:`, err);
      }
    }
  });

  run();
  return synced;
}

// ---------------------------------------------------------------------------
// Heartbeat sync
// ---------------------------------------------------------------------------

export function syncHeartbeat(agent: string): boolean {
  const heartbeatPath = getHeartbeatPath(agent);
  if (!fs.existsSync(heartbeatPath)) return false;
  if (!hasFileChanged(heartbeatPath)) return false;

  try {
    const raw = fs.readFileSync(heartbeatPath, 'utf-8');
    const hb = JSON.parse(raw);

    db.prepare(
      `INSERT OR REPLACE INTO heartbeats
        (agent, org, status, current_task, mode, last_heartbeat, loop_interval, uptime_seconds)
       VALUES
        (@agent, @org, @status, @current_task, @mode, @last_heartbeat, @loop_interval, @uptime_seconds)`,
    ).run({
      agent,
      org: hb.org ?? '',
      status: hb.status ?? null,
      current_task: hb.current_task ?? null,
      mode: hb.mode ?? null,
      last_heartbeat: hb.last_heartbeat ?? hb.timestamp ?? null,
      loop_interval: hb.loop_interval ?? null,
      uptime_seconds: hb.uptime_seconds ?? null,
    });
    markSynced(heartbeatPath);
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

export function syncAll(): SyncResult {
  const results: SyncResult = { tasks: 0, approvals: 0, events: 0, heartbeats: 0 };

  const orgs = getOrgs();
  for (const org of orgs) {
    results.tasks += syncTasks(org);
    results.approvals += syncApprovals(org);

    // Scan events directory directly for agent subdirs (agents may not exist in state dir)
    const eventsBaseDir = path.join(CTX_ROOT, 'orgs', org, 'analytics', 'events');
    if (fs.existsSync(eventsBaseDir)) {
      const eventAgentDirs = fs
        .readdirSync(eventsBaseDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
      for (const agent of eventAgentDirs) {
        results.events += syncEvents(org, agent);
      }
    }
  }

  // Heartbeats are flat (not org-scoped)
  const stateDir = path.join(CTX_ROOT, 'state');
  if (fs.existsSync(stateDir)) {
    const agentDirs = fs
      .readdirSync(stateDir, { withFileTypes: true })
      .filter((d) => d.isDirectory());
    for (const agentDir of agentDirs) {
      if (syncHeartbeat(agentDir.name)) results.heartbeats++;
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
          db.prepare('UPDATE heartbeats SET org = ? WHERE agent = ? AND (org IS NULL OR org = \'\')').run(agentOrg, name);
        }
      }
    }
  } catch {
    // Best effort
  }

  // Cost sync moved to syncCostsLazy() - only runs when Analytics page is visited

  console.log(`[sync] Full sync complete:`, results);
  return results;
}

// ---------------------------------------------------------------------------
// Lazy cost sync (only called from Analytics page)
// ---------------------------------------------------------------------------

const COST_SYNC_INTERVAL_MS = 15 * 1000;

export function syncCostsLazy(force = false): void {
  const now = Date.now();
  const lastCostSync = (globalThis as unknown as Record<string, number>).__lastCostSync ?? 0;
  if (force || now - lastCostSync > COST_SYNC_INTERVAL_MS) {
    try {
      const { syncCosts } = require('./cost-parser');
      const costResult = syncCosts();
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

export function syncFile(filePath: string): void {
  if (filePath.includes('/tasks/') && filePath.endsWith('.json')) {
    const org = extractOrgFromPath(filePath);
    if (org) syncTasks(org);
  } else if (filePath.includes('/approvals/') && filePath.endsWith('.json')) {
    const org = extractOrgFromPath(filePath);
    if (org) syncApprovals(org);
  } else if (
    filePath.includes('/analytics/events/') &&
    filePath.endsWith('.jsonl')
  ) {
    const { org, agent } = extractOrgAndAgentFromEventPath(filePath);
    if (org && agent) syncEvents(org, agent);
  } else if (
    filePath.includes('/state/') &&
    filePath.endsWith('heartbeat.json')
  ) {
    const agent = extractAgentFromStatePath(filePath);
    if (agent) syncHeartbeat(agent);
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
  const match = filePath.match(
    /\/orgs\/([^/]+)\/analytics\/events\/([^/]+)\//,
  );
  return { org: match?.[1] ?? null, agent: match?.[2] ?? null };
}

export function extractAgentFromStatePath(filePath: string): string | null {
  const match = filePath.match(/\/state\/([^/]+)\//);
  return match ? match[1] : null;
}
