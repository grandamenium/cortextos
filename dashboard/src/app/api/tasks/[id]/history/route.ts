import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { getTaskById, getTaskHistory, appendComment } from '@/lib/data/tasks';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Validation (mirrors [id]/route.ts)
// ---------------------------------------------------------------------------

function isValidId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

const MAX_COMMENT_LEN = 2000;

function capText(value: unknown, max = MAX_COMMENT_LEN): string {
  return String(value ?? '').slice(0, max);
}

// ---------------------------------------------------------------------------
// GET /api/tasks/[id]/history - Return audit log as JSON array
// ---------------------------------------------------------------------------

export async function GET(
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

  try {
    const entries = getTaskHistory(id);
    return Response.json(entries);
  } catch (err) {
    console.error('[api/tasks/[id]/history] GET error:', err);
    return Response.json({ error: 'Failed to fetch task history' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// POST /api/tasks/[id]/history - Append a comment to the task audit log
// Body: { text: string }
// ---------------------------------------------------------------------------

export async function POST(
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

  const rawText = body.text;
  if (typeof rawText !== 'string' || !rawText.trim()) {
    return Response.json({ error: 'text is required' }, { status: 400 });
  }

  const text = capText(rawText.trim());

  // Resolve agent from NextAuth session; fall back to a safe default.
  let agent = 'dashboard-user';
  try {
    const session = await auth();
    if (session?.user?.name) {
      agent = session.user.name;
    }
  } catch {
    // Non-fatal — use fallback agent name
  }

  try {
    appendComment(id, agent, text, task);
    const entries = getTaskHistory(id);
    return Response.json(entries, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[api/tasks/[id]/history] POST error:', message);
    return Response.json({ error: message }, { status: 500 });
  }
}
