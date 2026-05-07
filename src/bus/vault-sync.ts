import { existsSync, mkdirSync, renameSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import type { Task, TaskStatus } from '../types/index.js';

/**
 * MEMORY-07: Bidirectional vault sync for tasks.
 *
 * Writes/moves task markdown files into the Obsidian vault directory tree:
 *   obsidian-vault/<agent>/tasks/{open,in-progress,completed}/<taskId>.md
 *
 * All operations are best-effort — a vault write failure never blocks
 * the underlying task operation. The vault is a read-friendly mirror,
 * not the source of truth.
 *
 * Vault root is derived from CTX_FRAMEWORK_ROOT env var. If not set,
 * vault sync is silently skipped.
 */

function getVaultRoot(): string | null {
  const frameworkRoot = process.env.CTX_FRAMEWORK_ROOT;
  if (!frameworkRoot) return null;
  const vaultRoot = join(frameworkRoot, 'obsidian-vault');
  if (!existsSync(vaultRoot)) return null;
  return vaultRoot;
}

function statusToFolder(status: TaskStatus): string {
  switch (status) {
    case 'pending': return 'open';
    case 'in_progress': return 'in-progress';
    case 'completed': return 'completed';
    case 'cancelled': return 'completed';
    default: return 'open';
  }
}

function priorityEmoji(priority: string): string {
  switch (priority) {
    case 'urgent': return '🔴';
    case 'high': return '🟠';
    case 'normal': return '🟡';
    case 'low': return '🟢';
    default: return '⚪';
  }
}

function buildTaskMarkdown(task: Task): string {
  const now = new Date().toISOString().substring(0, 10);
  const created = task.created_at?.substring(0, 10) ?? now;
  const updated = task.updated_at?.substring(0, 10) ?? now;
  const hasVerified = (task.result ?? '').match(/VERIFIED:/i) ? 'true' : 'false';
  const agent = task.assigned_to ?? 'unassigned';

  const frontmatter = [
    '---',
    `type: task`,
    `agent: ${agent}`,
    `task_id: ${task.id}`,
    `status: ${task.status}`,
    `priority: ${task.priority ?? 'normal'}`,
    `assignee: ${agent}`,
    `created_by: ${task.created_by ?? 'unknown'}`,
    `org: ${task.org ?? ''}`,
    task.project ? `project: ${task.project}` : null,
    `created: ${created}`,
    `modified: ${updated}`,
    `has_verified: ${hasVerified}`,
    `tags: [${agent}, task, ${statusToFolder(task.status)}, ${task.priority ?? 'normal'}]`,
    '---',
    '',
  ].filter(line => line !== null).join('\n');

  const body = [
    `# ${priorityEmoji(task.priority ?? 'normal')} ${task.title}`,
    '',
    `**Status:** ${task.status}  `,
    `**Priority:** ${task.priority ?? 'normal'}  `,
    `**Assigned to:** ${agent}  `,
    `**Created:** ${task.created_at}  `,
    `**Updated:** ${task.updated_at}  `,
    task.due_date ? `**Due:** ${task.due_date}  ` : null,
    task.project ? `**Project:** ${task.project}  ` : null,
    '',
  ].filter(line => line !== null).join('\n');

  const desc = task.description
    ? `## Description\n\n${task.description}\n\n`
    : '';

  const result = task.result
    ? `## Result\n\n${task.result}\n\n`
    : '';

  const busLink = `## Bus Link\n\n\`cortextos bus get-task ${task.id}\`\n`;

  return frontmatter + body + desc + result + busLink;
}

/**
 * Write (create or overwrite) a task's vault markdown file.
 * Places it in the folder matching the task's current status.
 */
export function vaultWriteTask(task: Task): void {
  try {
    const vaultRoot = getVaultRoot();
    if (!vaultRoot) return;

    const agent = task.assigned_to ?? 'unassigned';
    const folder = statusToFolder(task.status);
    const agentTaskDir = join(vaultRoot, agent, 'tasks', folder);

    mkdirSync(agentTaskDir, { recursive: true });
    const filePath = join(agentTaskDir, `${task.id}.md`);
    writeFileSync(filePath, buildTaskMarkdown(task), { encoding: 'utf-8', mode: 0o600 });
  } catch {
    // Best-effort — never block task operations on vault write failure.
  }
}

/**
 * Move a task's vault markdown file from oldStatus folder to newStatus folder.
 * Falls back to a write if the source file doesn't exist (idempotent recovery).
 */
export function vaultMoveTask(task: Task, oldStatus: TaskStatus): void {
  try {
    const vaultRoot = getVaultRoot();
    if (!vaultRoot) return;

    const agent = task.assigned_to ?? 'unassigned';
    const oldFolder = statusToFolder(oldStatus);
    const newFolder = statusToFolder(task.status);

    if (oldFolder === newFolder) {
      // Same folder — just overwrite in place.
      vaultWriteTask(task);
      return;
    }

    const oldPath = join(vaultRoot, agent, 'tasks', oldFolder, `${task.id}.md`);
    const newDir = join(vaultRoot, agent, 'tasks', newFolder);
    mkdirSync(newDir, { recursive: true });
    const newPath = join(newDir, `${task.id}.md`);

    // Write the updated content first, then remove the old file.
    // This avoids a window where the file doesn't exist in either place.
    writeFileSync(newPath, buildTaskMarkdown(task), { encoding: 'utf-8', mode: 0o600 });
    if (existsSync(oldPath)) {
      try { unlinkSync(oldPath); } catch { /* best-effort */ }
    }
  } catch {
    // Best-effort.
  }
}

/**
 * Archive a task's vault file (move completed → archive subfolder).
 * Called when the bus compacts tasks older than 14 days.
 */
export function vaultArchiveTask(taskId: string, assignedTo: string): void {
  try {
    const vaultRoot = getVaultRoot();
    if (!vaultRoot) return;

    const agent = assignedTo ?? 'unassigned';
    const completedPath = join(vaultRoot, agent, 'tasks', 'completed', `${taskId}.md`);
    if (!existsSync(completedPath)) return;

    const archiveDir = join(vaultRoot, agent, 'tasks', 'archive');
    mkdirSync(archiveDir, { recursive: true });
    renameSync(completedPath, join(archiveDir, `${taskId}.md`));
  } catch {
    // Best-effort.
  }
}
