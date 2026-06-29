import fs from 'fs';
import path from 'path';
import type { Task } from './types';

const VAULT_ROOT = "C:\\Users\\jenni\\OneDrive\\Documents\\Jen's Brain";
const TASKS_PAGE = path.join(VAULT_ROOT, 'Tasks.md');

function vaultExists(): boolean {
  try { return fs.existsSync(VAULT_ROOT); } catch { return false; }
}

function formatStatus(status: string): string {
  if (status === 'completed') return '✓';
  if (status === 'in_progress') return '▶';
  if (status === 'blocked') return '⛔';
  return '○';
}

export function syncTasksPage(tasks: Task[]): void {
  if (!vaultExists()) return;
  try {
    const now = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

    // Group by project, then unassigned
    const byProject: Record<string, Task[]> = {};
    for (const t of tasks) {
      const key = t.project || '(no project)';
      if (!byProject[key]) byProject[key] = [];
      byProject[key].push(t);
    }

    const lines: string[] = [
      '# Tasks',
      `> Last synced: ${now} — ${tasks.length} total`,
      '',
    ];

    const statusOrder: Record<string, number> = { blocked: 0, in_progress: 1, pending: 2, completed: 3 };
    for (const [proj, ptasks] of Object.entries(byProject).sort()) {
      lines.push(`## ${proj}`);
      const sorted = [...ptasks].sort((a, b) =>
        (statusOrder[a.status] ?? 4) - (statusOrder[b.status] ?? 4)
      );
      for (const t of sorted) {
        const check = t.status === 'completed' ? 'x' : ' ';
        const assignee = t.assignee || 'unassigned';
        const priority = t.priority !== 'normal' ? ` · ${t.priority}` : '';
        lines.push(`- [${check}] ${t.title} — ${assignee}${priority} · ${formatStatus(t.status)}`);
      }
      lines.push('');
    }

    const tmp = TASKS_PAGE + '.tmp';
    fs.writeFileSync(tmp, lines.join('\n'), 'utf8');
    fs.renameSync(tmp, TASKS_PAGE);
  } catch {
    // Non-fatal — Obsidian sync should never block task updates
  }
}

export function appendTaskAuditLine(
  taskId: string,
  title: string,
  field: string,
  newValue: string,
  agentMemoryPath: string,
): void {
  try {
    const now = new Date().toISOString().slice(11, 16) + ' UTC';
    const line = `\nTASK EDIT [${now}]: ${taskId} "${title}" — ${field} → ${newValue}`;
    fs.appendFileSync(agentMemoryPath, line, 'utf8');
  } catch {
    // Non-fatal
  }
}
