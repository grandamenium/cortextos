import { NextRequest } from 'next/server';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getTaskById, getTasks } from '@/lib/data/tasks';
import { getFrameworkRoot, getCTXRoot } from '@/lib/config';
import { syncAll } from '@/lib/sync';
import { syncTasksPage, appendTaskAuditLine } from '@/lib/obsidian-sync';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_STATUSES = ['pending', 'in_progress', 'blocked', 'completed'];
const VALID_PRIORITIES = ['urgent', 'high', 'normal', 'low'];

// Reject IDs that look like path traversal attempts
function isValidId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

// Agent names must be lowercase alphanumeric + underscore/hyphen.
// Used to guard against path traversal and shell metacharacters before
// passing values into bus shell scripts as positional arguments.
function isValidAgentName(name: string): boolean {
  return typeof name === 'string' && /^[a-z0-9_-]+$/.test(name) && name.length <= 64;
}

// Cap free-text fields (note, outputSummary) to a safe upper bound before
// forwarding them as positional args to bus scripts.
const MAX_FREE_TEXT_LEN = 2000;
function capText(value: unknown, max = MAX_FREE_TEXT_LEN): string {
  return String(value ?? '').slice(0, max);
}

// ---------------------------------------------------------------------------
// GET /api/tasks/[id] - Get a single task by ID
// ---------------------------------------------------------------------------

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  if (!isValidId(id)) {
    return Response.json({ error: 'Invalid task ID' }, { status: 400 });
  }

  try {
    const task = getTaskById(id);
    if (!task) {
      return Response.json({ error: 'Task not found' }, { status: 404 });
    }

    // Enrich with outputs and updates from the source JSON file (not synced to SQLite)
    if (task.source_file && fs.existsSync(task.source_file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(task.source_file, 'utf-8'));
        if (Array.isArray(raw.outputs)) task.outputs = raw.outputs;
        if (Array.isArray(raw.updates)) task.updates = raw.updates;
      } catch { /* non-fatal — outputs/updates are optional */ }
    }

    return Response.json(task);
  } catch (err) {
    console.error('[api/tasks/[id]] GET error:', err);
    return Response.json({ error: 'Failed to fetch task' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/tasks/[id] - Delete a task
// ---------------------------------------------------------------------------

export async function DELETE(
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

  // Delete the task file directly
  const fs = await import('fs/promises');
  const path = await import('path');
  const ctxRoot = getCTXRoot();
  const taskDir = task.org
    ? path.default.join(ctxRoot, 'orgs', task.org, 'tasks')
    : path.default.join(ctxRoot, 'tasks');
  const taskFile = path.default.join(taskDir, `${id}.json`);

  try {
    await fs.default.unlink(taskFile);
    try { syncAll(); } catch { /* best-effort */ }
    return Response.json({ success: true });
  } catch (err) {
    console.error('[api/tasks/[id]] DELETE error:', err);
    return Response.json({ error: 'Failed to delete task' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// PUT /api/tasks/[id] - Edit task fields (title, description, assignee, priority)
// ---------------------------------------------------------------------------

export async function PUT(
  request: NextRequest,
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

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { title, description, assignee, priority, project, start_date, due_date } = body as {
    title?: string;
    description?: string;
    assignee?: string;
    priority?: string;
    project?: string;
    start_date?: string | null;
    due_date?: string | null;
  };

  if (title !== undefined && (!title || title.trim().length === 0)) {
    return Response.json({ error: 'Title cannot be empty' }, { status: 400 });
  }
  if (priority !== undefined && !VALID_PRIORITIES.includes(priority)) {
    return Response.json({ error: 'Invalid priority' }, { status: 400 });
  }
  if (assignee !== undefined && !isValidAgentName(assignee)) {
    return Response.json({ error: 'Invalid assignee' }, { status: 400 });
  }
  const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T[\d:.Z+-]+)?$/;
  if (start_date != null && !ISO_DATE_RE.test(start_date)) {
    return Response.json({ error: 'Invalid start_date format' }, { status: 400 });
  }
  if (due_date != null && !ISO_DATE_RE.test(due_date)) {
    return Response.json({ error: 'Invalid due_date format' }, { status: 400 });
  }

  // Read and update the task JSON file directly
  const fs = await import('fs/promises');
  const path = await import('path');
  const ctxRoot = getCTXRoot();
  const taskDir = task.org
    ? path.default.join(ctxRoot, 'orgs', task.org, 'tasks')
    : path.default.join(ctxRoot, 'tasks');
  const taskFile = path.default.join(taskDir, `${id}.json`);

  try {
    const raw = await fs.default.readFile(taskFile, 'utf-8');
    const taskData = JSON.parse(raw);

    const oldAssignee = taskData.assigned_to;
    if (title !== undefined) taskData.title = title.trim();
    if (description !== undefined) taskData.description = description;
    if (assignee !== undefined) taskData.assigned_to = assignee;
    if (priority !== undefined) taskData.priority = priority;
    if (project !== undefined) taskData.project = project;
    if (start_date !== undefined) taskData.start_date = start_date ?? undefined;
    if (due_date !== undefined) taskData.due_date = due_date ?? undefined;
    taskData.updated_at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

    const tmp = taskFile + '.tmp';
    await fs.default.writeFile(tmp, JSON.stringify(taskData, null, 2) + '\n');
    await fs.default.rename(tmp, taskFile);

    // Notify new assignee if changed. assignee was validated against the
    // agent-name whitelist above, and the message body is capped before it
    // is passed as a positional arg to the bus script (which quotes "$3").
    if (assignee && assignee !== oldAssignee && assignee !== 'human' && assignee !== 'user' && isValidAgentName(assignee)) {
      try {
        const notifyMsg = capText(`Task reassigned to you: [${id}] ${taskData.title}`);
        spawnSync(
          'bash',
          [
            path.join(getFrameworkRoot(), 'bus', 'send-message.sh'),
            assignee,
            'normal',
            notifyMsg,
          ],
          { timeout: 5000, stdio: 'pipe', env: { ...process.env, CTX_FRAMEWORK_ROOT: getFrameworkRoot(), CTX_ROOT: getCTXRoot(), CTX_INSTANCE_ID: process.env.CTX_INSTANCE_ID ?? 'default', CTX_AGENT_NAME: 'dashboard', CTX_ORG: task?.org || '' } },
        );
      } catch { /* non-fatal */ }
    }

    try { syncAll(); } catch { /* best-effort */ }

    // Obsidian sync (Phase 1) — fire and forget, never blocks response
    try {
      const changedFields = [title, description, assignee, priority, project, due_date]
        .map((v, i) => v !== undefined ? ['title','description','assignee','priority','project','due_date'][i] : null)
        .filter(Boolean).join(', ');
      const memPath = path.join(getCTXRoot(), 'orgs', task.org || '', '..', '..', 'agents', 'forge', 'memory',
        `${new Date().toISOString().slice(0,10)}.md`);
      appendTaskAuditLine(id, taskData.title, changedFields || 'fields', 'updated', memPath);
      const allTasks = getTasks({});
      syncTasksPage(allTasks);
    } catch { /* non-fatal */ }

    return Response.json({ success: true });
  } catch (err) {
    console.error('[api/tasks/[id]] PUT error:', err);
    return Response.json({ error: 'Failed to update task' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// PATCH /api/tasks/[id] - Update task status via bus scripts
//
// Body: { status, note?, blockedBy?, outputSummary? }
// - status=completed -> delegates to complete-task.sh
// - other statuses   -> delegates to update-task.sh
// ---------------------------------------------------------------------------

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  if (!isValidId(id)) {
    return Response.json({ error: 'Invalid task ID' }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { status, note, blockedBy, outputSummary, comment } = body as {
    status?: string;
    note?: string;
    blockedBy?: string;
    outputSummary?: string;
    comment?: string;
  };

  // Must provide at least a valid status or a comment
  const hasComment = typeof comment === 'string' && comment.trim().length > 0;
  const hasStatus = typeof status === 'string' && VALID_STATUSES.includes(status);
  if (!hasStatus && !hasComment) {
    return Response.json(
      { error: `Provide a valid status (${VALID_STATUSES.join(', ')}) and/or a comment` },
      { status: 400 },
    );
  }

  // blockedBy is forwarded as a positional arg to update-task.sh. It should
  // either be absent or match the agent-name / task-id shape. Reject anything
  // containing shell metacharacters or path traversal.
  if (blockedBy !== undefined && blockedBy !== null && blockedBy !== '') {
    if (typeof blockedBy !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(blockedBy) || blockedBy.length > 128) {
      return Response.json({ error: 'Invalid blockedBy' }, { status: 400 });
    }
  }

  // Look up task's org to pass CTX_ORG to bus script
  const task = getTaskById(id);

  const frameworkRoot = getFrameworkRoot();
  const ctxRoot = getCTXRoot();
  const env = {
    ...process.env,
    CTX_FRAMEWORK_ROOT: frameworkRoot,
    CTX_ROOT: ctxRoot,
    CTX_INSTANCE_ID: process.env.CTX_INSTANCE_ID ?? 'default',
    CTX_AGENT_NAME: 'dashboard',
    CTX_ORG: task?.org || '',
  };

  // Helper: notify Atlas via bus — non-fatal, fire-and-forget
  function notifyAtlas(msg: string) {
    try {
      spawnSync(
        'node',
        [path.join(frameworkRoot, 'dist', 'cli.js'), 'bus', 'send-message', 'atlas', 'normal', capText(msg)],
        { timeout: 5000, stdio: 'pipe', env },
      );
    } catch { /* non-fatal */ }
  }

  try {
    // Handle comment-only path (no status change)
    if (hasComment && !hasStatus) {
      const commentText = capText(comment!.trim());
      // Append comment to task JSON updates[]
      if (task?.source_file && fs.existsSync(task.source_file)) {
        try {
          const raw = fs.readFileSync(task.source_file, 'utf-8');
          const taskData = JSON.parse(raw);
          if (!Array.isArray(taskData.updates)) taskData.updates = [];
          taskData.updates.push({ from: 'dashboard', text: commentText, at: new Date().toISOString() });
          const tmp = task.source_file + '.tmp';
          fs.writeFileSync(tmp, JSON.stringify(taskData, null, 2) + '\n');
          fs.renameSync(tmp, task.source_file);
        } catch { /* non-fatal */ }
      }
      notifyAtlas(`DASHBOARD — Jennifer update on [${id}] ${task?.title ?? id}: ${commentText}`);
      try { syncAll(); } catch { /* best-effort */ }
      return Response.json({ success: true });
    }

    let spawnResult;
    if (status === 'completed') {
      // Use complete-task.sh for completion (handles additional side effects).
      // summaryArg is capped and passed as a positional arg; the bus script
      // quotes "$2" and exec's node directly, so no shell interpolation occurs.
      const summaryArg = capText(outputSummary);
      spawnResult = spawnSync(
        'bash',
        [path.join(frameworkRoot, 'bus', 'complete-task.sh'), id, summaryArg],
        { encoding: 'utf-8', timeout: 10000, env, stdio: 'pipe' },
      );
    } else {
      // Use update-task.sh for other status changes. All args are positional
      // and bounded; blockedBy was validated above, id/status are whitelisted.
      const args: string[] = [id, status!];
      if (note) args.push(capText(note));
      if (blockedBy) args.push(String(blockedBy));

      spawnResult = spawnSync(
        'bash',
        [path.join(frameworkRoot, 'bus', 'update-task.sh'), ...args],
        { encoding: 'utf-8', timeout: 10000, env, stdio: 'pipe' },
      );
    }
    if (spawnResult.status !== 0) {
      throw new Error(spawnResult.stderr || spawnResult.stdout || 'Script failed');
    }

    // Always notify Atlas when Jennifer changes a status from the dashboard
    notifyAtlas(`DASHBOARD — Jennifer changed [${id}] ${task?.title ?? id} → ${status}`);

    // If a comment was also included with the status change, attach it and notify
    if (hasComment) {
      const commentText = capText(comment!.trim());
      if (task?.source_file && fs.existsSync(task.source_file)) {
        try {
          const raw = fs.readFileSync(task.source_file, 'utf-8');
          const taskData = JSON.parse(raw);
          if (!Array.isArray(taskData.updates)) taskData.updates = [];
          taskData.updates.push({ from: 'dashboard', text: commentText, at: new Date().toISOString() });
          const tmp = task.source_file + '.tmp';
          fs.writeFileSync(tmp, JSON.stringify(taskData, null, 2) + '\n');
          fs.renameSync(tmp, task.source_file);
        } catch { /* non-fatal */ }
      }
      notifyAtlas(`DASHBOARD — Jennifer update on [${id}] ${task?.title ?? id}: ${commentText}`);
    }

    // Notify the task creator when a task is completed or status changes significantly.
    // This is how agents find out their blocked tasks can be unblocked.
    if (task?.source_file) {
      try {
        const raw = fs.readFileSync(task.source_file, 'utf-8');
        const taskData = JSON.parse(raw);
        const createdBy: string | undefined = taskData.created_by;
        // Only notify agents (not 'dashboard', 'human', etc.) and only when
        // the recipient name passes the agent-name whitelist — prevents
        // passing crafted names into the bus CLI.
        const agentNames = new Set(['dashboard', 'human', 'user', 'atlas']);
        if (createdBy && !agentNames.has(createdBy) && isValidAgentName(createdBy)) {
          const rawMsg = status === 'completed'
            ? `Human task completed by user: [${id}] ${task.title} - you can now unblock your work`
            : `Task status updated to ${status}: [${id}] ${task.title}`;
          const msg = capText(rawMsg);
          spawnSync(
            'node',
            [
              path.join(frameworkRoot, 'dist', 'cli.js'),
              'bus', 'send-message', createdBy, 'normal', msg,
            ],
            { timeout: 5000, stdio: 'pipe', env },
          );
        }
      } catch { /* non-fatal */ }
    }

    // Trigger sync so subsequent reads reflect the update
    try {
      syncAll();
    } catch {
      // Sync is best-effort
    }

    // Obsidian sync (Phase 1) — fire and forget
    try {
      const memPath = path.join(getCTXRoot(), 'orgs', task?.org || '', '..', '..', 'agents', 'forge', 'memory',
        `${new Date().toISOString().slice(0,10)}.md`);
      appendTaskAuditLine(id, task?.title || id, 'status', status!, memPath);
      const allTasks = getTasks({});
      syncTasksPage(allTasks);
    } catch { /* non-fatal */ }

    return Response.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[api/tasks/[id]] PATCH error:', message);
    return Response.json(
      { error: 'Failed to update task' },
      { status: 500 },
    );
  }
}
