/**
 * ClickUp -> cortextOS read-back.
 *
 * The mirror was one-way: tasks flowed out, and anything Jennifer changed on her
 * phone (a due date, a priority, marking something done) was invisible to the
 * fleet. That makes ClickUp a dead-drop rather than a task manager. This pulls
 * her edits back so ClickUp is the surface she actually controls.
 *
 * Matching is by TITLE, because the mirror never recorded the ClickUp task id
 * against the local task. Title match is exact after trim; ambiguous titles are
 * reported and skipped rather than guessed at.
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import https from 'https';
import { atomicWriteSync } from './atomic.js';
import type { Task } from '../types/index.js';

const LIST_IDS = [
  '901418072210', '901418072202', '901418072119', '901323647008',
  '901311152805', '901324730191', '901315813749', '901418072216',
];

const PRIORITY_FROM_CLICKUP: Record<string, string> = { '1': 'urgent', '2': 'high', '3': 'normal', '4': 'low' };

export interface ClickUpTaskLite {
  id: string;
  name: string;
  due_date: string | null;
  priority: string | null;
  status: string;
}

function getApiKey(frameworkRoot: string): string | null {
  const p = join(frameworkRoot, 'orgs', 'atlasos', 'secrets', 'clickup_api_key.txt');
  if (!existsSync(p)) return null;
  try { return readFileSync(p, 'utf-8').trim() || null; } catch { return null; }
}

function getJson(token: string, path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: 'api.clickup.com', path, method: 'GET', headers: { Authorization: token }, timeout: 15000 },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          if ((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300) {
            try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`bad JSON: ${String(e)}`)); }
          } else {
            reject(new Error(`HTTP ${res.statusCode} ${body.slice(0, 140)}`));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout after 15s')));
    req.on('error', reject);
    req.end();
  });
}

/** Fetch every open task across the mapped lists. */
export async function fetchClickUpTasks(frameworkRoot: string): Promise<ClickUpTaskLite[]> {
  const token = getApiKey(frameworkRoot);
  if (!token) throw new Error('no ClickUp API key at orgs/atlasos/secrets/clickup_api_key.txt');
  const out: ClickUpTaskLite[] = [];
  for (const listId of LIST_IDS) {
    const data = await getJson(token, `/api/v2/list/${listId}/task?archived=false&include_closed=false&subtasks=false`);
    for (const t of (data.tasks ?? [])) {
      out.push({
        id: t.id,
        name: String(t.name ?? '').trim(),
        due_date: t.due_date ?? null,
        priority: t.priority?.orderindex != null ? String(t.priority.orderindex) : null,
        status: t.status?.status ?? '',
      });
    }
  }
  return out;
}

export interface PullResult {
  scanned: number;
  matched: number;
  updatedDue: number;
  updatedPriority: number;
  ambiguous: string[];
  changes: string[];
}

/**
 * Apply ClickUp due dates and priorities onto local task JSONs.
 * ClickUp wins on those two fields: they are the ones she edits by hand.
 * Status is deliberately NOT pulled — completion has its own audited path
 * (`complete-task`) and overwriting it here would bypass the audit log.
 */
export async function pullFromClickUp(frameworkRoot: string, taskDir: string, dryRun = false): Promise<PullResult> {
  const remote = await fetchClickUpTasks(frameworkRoot);
  const byTitle = new Map<string, ClickUpTaskLite[]>();
  for (const r of remote) {
    const key = r.name.toLowerCase();
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key)!.push(r);
  }

  const result: PullResult = { scanned: remote.length, matched: 0, updatedDue: 0, updatedPriority: 0, ambiguous: [], changes: [] };
  if (!existsSync(taskDir)) return result;

  for (const file of readdirSync(taskDir)) {
    if (!file.endsWith('.json')) continue;
    const full = join(taskDir, file);
    let task: Task;
    try { task = JSON.parse(readFileSync(full, 'utf-8')); } catch { continue; }
    if (task.status === 'completed' || task.status === 'cancelled' || task.archived) continue;

    const hits = byTitle.get(String(task.title ?? '').trim().toLowerCase());
    if (!hits || hits.length === 0) continue;
    if (hits.length > 1) { result.ambiguous.push(task.title); continue; }
    const r = hits[0];
    result.matched++;

    let dirty = false;
    if (r.due_date) {
      const iso = new Date(Number(r.due_date)).toISOString();
      if (task.due_date !== iso) {
        result.changes.push(`due  ${task.due_date ?? 'none'} -> ${iso}  "${task.title.slice(0, 50)}"`);
        task.due_date = iso;
        dirty = true;
        result.updatedDue++;
      }
    }
    const mapped = r.priority ? PRIORITY_FROM_CLICKUP[r.priority] : undefined;
    if (mapped && mapped !== task.priority) {
      result.changes.push(`pri  ${task.priority} -> ${mapped}  "${task.title.slice(0, 50)}"`);
      (task as { priority: string }).priority = mapped;
      dirty = true;
      result.updatedPriority++;
    }

    if (dirty && !dryRun) {
      task.updated_at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      atomicWriteSync(full, JSON.stringify(task));
    }
  }
  return result;
}
