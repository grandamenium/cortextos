import { NextRequest } from 'next/server';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getTaskById } from '@/lib/data/tasks';
import { getFrameworkRoot, getCTXRoot } from '@/lib/config';
import { syncAll } from '@/lib/sync';

// ---------------------------------------------------------------------------
// POST /api/tasks/[id]/proceed
//
// "Proceed with recommended action" from the task detail brief. Behaviour
// depends on who owns the task:
//
//   Agent-owned  -> message the assignee agent that the human approved the
//                   brief's recommendation, and unblock the task
//                   (blocked -> in_progress) so it re-enters the agent's queue.
//
//   Human-owned  -> the human IS the actor, so "proceed" means "I've handled
//                   this": complete the task, then notify any downstream tasks
//                   it blocks that their blocker is done (best-effort — we do
//                   not auto-unblock them; the agent decides).
//
// Requires the task to have a brief. No request body.
// ---------------------------------------------------------------------------

function isValidId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

function isValidAgentName(name: string): boolean {
  return typeof name === 'string' && /^[a-z0-9_-]+$/.test(name) && name.length <= 64;
}

// A task the human must action themselves: assigned to 'human'/'user', or
// unassigned. Matches the codebase's own human-task convention (see
// checkHumanTasks / stale_human in src/bus/task.ts).
function isHumanOwned(assignee: string | undefined | null): boolean {
  return !assignee || assignee === 'human' || assignee === 'user';
}

const MAX_FREE_TEXT_LEN = 2000;
function capText(value: unknown, max = MAX_FREE_TEXT_LEN): string {
  return String(value ?? '').slice(0, max);
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  if (!isValidId(id)) {
    return Response.json({ error: 'Invalid task ID' }, { status: 400 });
  }

  const task = getTaskById(id);
  if (!task) {
    return Response.json({ error: 'Task not found' }, { status: 404 });
  }
  if (!task.brief) {
    return Response.json({ error: 'Task has no brief to act on' }, { status: 400 });
  }

  const frameworkRoot = getFrameworkRoot();
  const ctxRoot = getCTXRoot();
  const env = {
    ...process.env,
    CTX_FRAMEWORK_ROOT: frameworkRoot,
    CTX_ROOT: ctxRoot,
    CTX_INSTANCE_ID: process.env.CTX_INSTANCE_ID ?? 'default',
    CTX_AGENT_NAME: 'dashboard',
    CTX_ORG: task.org || '',
  };

  const sendMessage = (agent: string, priority: string, msg: string): void => {
    try {
      spawnSync(
        'bash',
        [path.join(frameworkRoot, 'bus', 'send-message.sh'), agent, priority, capText(msg)],
        { timeout: 5000, stdio: 'pipe', env },
      );
    } catch {
      // Non-fatal: notification is best-effort.
    }
  };

  // -- Human-owned: complete the task, then notify downstream waiters. --------
  if (isHumanOwned(task.assignee)) {
    try {
      const result = spawnSync(
        'bash',
        [path.join(frameworkRoot, 'bus', 'complete-task.sh'), id, capText('Marked done by Rob from the dashboard brief')],
        { encoding: 'utf-8', timeout: 10000, stdio: 'pipe', env },
      );
      if (result.status !== 0) {
        throw new Error(result.stderr || result.stdout || 'complete-task failed');
      }
    } catch (err) {
      console.error(`[api/tasks/${id}/proceed] complete failed:`, err);
      return Response.json({ error: 'Failed to complete task' }, { status: 500 });
    }

    // Notify agents whose tasks were blocked by this one. Edges (blocks[]) live
    // on the task JSON, not in the dashboard DB, so read the file directly.
    const notified = notifyDownstream(ctxRoot, task.org || '', id, task.title, sendMessage);

    try { syncAll(); } catch { /* best-effort */ }
    return Response.json({ success: true, action: 'completed', notified });
  }

  // -- Agent-owned: message the assignee to proceed, then unblock. ------------
  const assignee = task.assignee!;
  const messagedAgent = assignee !== 'human' && assignee !== 'user' && isValidAgentName(assignee);
  if (messagedAgent) {
    sendMessage(
      assignee,
      'high',
      `[BRIEF DECISION] Rob approved your recommended action for [${id}] ${task.title}: ` +
      `"${task.brief.recommendation}". Unblocked — proceed now.`,
    );
  }

  try {
    const result = spawnSync(
      'bash',
      [path.join(frameworkRoot, 'bus', 'update-task.sh'), id, 'in_progress', capText('Proceeding with recommended action')],
      { encoding: 'utf-8', timeout: 10000, stdio: 'pipe', env },
    );
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || 'update-task failed');
    }
  } catch (err) {
    console.error(`[api/tasks/${id}/proceed] unblock failed:`, err);
    return Response.json({ error: 'Failed to unblock task' }, { status: 500 });
  }

  try { syncAll(); } catch { /* best-effort */ }
  return Response.json({ success: true, action: 'unblocked', messagedAgent, assignee: messagedAgent ? assignee : null });
}

// Read the completed task's `blocks` edge list and tell each downstream task's
// assignee agent that their blocker is done. Best-effort; returns the agents
// that were messaged.
function notifyDownstream(
  ctxRoot: string,
  org: string,
  taskId: string,
  taskTitle: string,
  sendMessage: (agent: string, priority: string, msg: string) => void,
): string[] {
  const notified: string[] = [];
  const tasksDir = org ? path.join(ctxRoot, 'orgs', org, 'tasks') : path.join(ctxRoot, 'tasks');
  const readTask = (tid: string): Record<string, unknown> | null => {
    try {
      return JSON.parse(fs.readFileSync(path.join(tasksDir, `${tid}.json`), 'utf-8'));
    } catch {
      return null;
    }
  };

  const self = readTask(taskId);
  const blocks = Array.isArray(self?.blocks) ? (self!.blocks as string[]) : [];
  for (const downId of blocks) {
    if (typeof downId !== 'string' || !isValidId(downId)) continue;
    const down = readTask(downId);
    const downAssignee = (down?.assigned_to ?? down?.assignee) as string | undefined;
    if (downAssignee && isValidAgentName(downAssignee) && downAssignee !== 'human' && downAssignee !== 'user') {
      sendMessage(
        downAssignee,
        'high',
        `[BLOCKER DONE] Rob completed [${taskId}] ${taskTitle}, which was blocking your task [${downId}]. You may be able to proceed.`,
      );
      notified.push(downAssignee);
    }
  }
  return notified;
}
