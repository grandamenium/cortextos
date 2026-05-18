import { NextRequest } from 'next/server';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { getTasks } from '@/lib/data/tasks';
import { getFrameworkRoot, getCTXRoot, getOrgs, CTX_INSTANCE_ID, CTX_ROOT_REAL } from '@/lib/config';
import { syncAll } from '@/lib/sync';

export const dynamic = 'force-dynamic';

// Security (H4): frameworkRoot must match a safe path pattern — no shell metacharacters.
const SAFE_PATH_REGEX = /^[/\w.-]+$/;

// ---------------------------------------------------------------------------
// Validation constants
// ---------------------------------------------------------------------------

// VALID_STATUSES reserved for future query-param validation
// const VALID_STATUSES = ['pending', 'in_progress', 'blocked', 'completed'];
const VALID_PRIORITIES = ['urgent', 'high', 'normal', 'low'];

// ---------------------------------------------------------------------------
// GET /api/tasks - List tasks with optional filters
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;

  try { syncAll(); } catch { /* best-effort */ }

  const filters = {
    scope: searchParams.get('scope') === 'root' ? 'root' as const : undefined,
    org: searchParams.get('org') || undefined,
    agent: searchParams.get('agent') || undefined,
    priority: searchParams.get('priority') || undefined,
    status: searchParams.get('status') || undefined,
    project: searchParams.get('project') || undefined,
    search: searchParams.get('search') || undefined,
  };

  try {
    const tasks = getTasks(filters);
    return Response.json(tasks, {
      headers: {
        'X-CortexOS-Instance': CTX_INSTANCE_ID,
        'X-CortexOS-Root': CTX_ROOT_REAL,
      },
    });
  } catch (err) {
    console.error('[api/tasks] GET error:', err);
    return Response.json({ error: 'Failed to fetch tasks' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// POST /api/tasks - Create a new task via bus/create-task.sh
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { title, description, assignee, priority, project, needsApproval } =
    body as {
      title?: string;
      description?: string;
      assignee?: string;
      priority?: string;
      project?: string;
      needsApproval?: boolean;
    };

  // Validate required fields
  if (!title || typeof title !== 'string' || title.trim().length === 0) {
    return Response.json({ error: 'Title is required' }, { status: 400 });
  }
  if (title.length > 500) {
    return Response.json(
      { error: 'Title must be 500 characters or fewer' },
      { status: 400 },
    );
  }
  if (priority && !VALID_PRIORITIES.includes(priority)) {
    return Response.json(
      { error: `Invalid priority. Must be one of: ${VALID_PRIORITIES.join(', ')}` },
      { status: 400 },
    );
  }

  // Use org from request body or first available org
  const org = (body.org as string) || getOrgs()[0] || '';

  const frameworkRoot = getFrameworkRoot();

  // Security (H4): Validate frameworkRoot before using in execFileSync path.
  if (!frameworkRoot || !SAFE_PATH_REGEX.test(frameworkRoot)) {
    console.error('[api/tasks] Invalid CTX_FRAMEWORK_ROOT:', frameworkRoot);
    return Response.json({ error: 'Internal error' }, { status: 500 });
  }

  const instanceId = process.env.CTX_INSTANCE_ID ?? 'default';
  const env = {
    ...process.env,
    CTX_FRAMEWORK_ROOT: frameworkRoot,
    CTX_ROOT: getCTXRoot(),
    CTX_INSTANCE_ID: instanceId,
    CTX_AGENT_NAME: 'dashboard',
    CTX_ORG: org,
  };

  // Call the Node CLI directly instead of going through bash wrapper.
  // create-task.sh just runs: node dist/cli.js bus create-task <title> [options]
  const cliPath = join(frameworkRoot, 'dist', 'cli.js');
  const args: string[] = ['bus', 'create-task', title.trim()];
  if (description) { args.push('--desc', String(description).slice(0, 2000)); }
  if (assignee) { args.push('--assignee', String(assignee)); }
  if (priority) { args.push('--priority', priority); }
  if (project) { args.push('--project', String(project)); }
  if (needsApproval) { args.push('--needs-approval'); }

  try {
    const result = execFileSync(process.execPath, [cliPath, ...args], {
      encoding: 'utf-8',
      timeout: 10000,
      env,
    });

    // Trigger sync so subsequent reads reflect the new task
    try {
      syncAll();
    } catch {
      // Sync is best-effort
    }

    return Response.json(
      { success: true, taskId: result.trim() },
      { status: 201 },
    );
  } catch (err: unknown) {
    console.error('[api/tasks] POST error:', err);
    return Response.json({ error: 'Failed to create task' }, { status: 500 });
  }
}
