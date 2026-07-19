import { NextRequest } from 'next/server';
import { spawnSync } from 'child_process';
import path from 'path';
import { getTaskById } from '@/lib/data/tasks';
import { getFrameworkRoot, getCTXRoot } from '@/lib/config';
import { syncAll } from '@/lib/sync';

// ---------------------------------------------------------------------------
// POST /api/tasks/[id]/proceed
//
// "Proceed with recommended action" from the task detail brief. Tells the
// task's assignee agent that the human approved the brief's recommendation,
// and unblocks the task so the agent picks it back up. Requires the task to
// have a brief. No request body.
// ---------------------------------------------------------------------------

function isValidId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

function isValidAgentName(name: string): boolean {
  return typeof name === 'string' && /^[a-z0-9_-]+$/.test(name) && name.length <= 64;
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
  const env = {
    ...process.env,
    CTX_FRAMEWORK_ROOT: frameworkRoot,
    CTX_ROOT: getCTXRoot(),
    CTX_INSTANCE_ID: process.env.CTX_INSTANCE_ID ?? 'default',
    CTX_AGENT_NAME: 'dashboard',
    CTX_ORG: task.org || '',
  };

  // Notify the assignee agent to proceed with its recommended action. Message
  // body is capped and passed as a positional arg to the bus script (which
  // quotes "$3"), so no shell interpolation occurs. Skip when the task is
  // owned by a human — there is no agent inbox to message.
  const assignee = task.assignee;
  const messagedAgent = !!assignee && assignee !== 'human' && assignee !== 'user' && isValidAgentName(assignee);
  if (messagedAgent) {
    const msg = capText(
      `[BRIEF DECISION] Rob approved your recommended action for [${id}] ${task.title}: ` +
      `"${task.brief.recommendation}". Unblocked — proceed now.`,
    );
    try {
      spawnSync(
        'bash',
        [path.join(frameworkRoot, 'bus', 'send-message.sh'), assignee!, 'high', msg],
        { timeout: 5000, stdio: 'pipe', env },
      );
    } catch {
      // Non-fatal: the unblock below is the load-bearing effect.
    }
  }

  // Unblock the task so it re-enters the agent's active queue. Only meaningful
  // when currently blocked; update-task is idempotent for other states.
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

  return Response.json({ success: true, messagedAgent, assignee: messagedAgent ? assignee : null });
}
