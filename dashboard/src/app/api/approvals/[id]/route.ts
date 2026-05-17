import { NextRequest } from 'next/server';
import { spawnSync } from 'child_process';
import path from 'path';
import { getApprovalById } from '@/lib/data/approvals';
import { getFrameworkRoot, getCTXRoot } from '@/lib/config';
import { syncAll } from '@/lib/sync';

export const dynamic = 'force-dynamic';

// Reject IDs that look like path traversal attempts
function isValidId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

const VALID_DECISIONS = ['approved', 'rejected'];

// ---------------------------------------------------------------------------
// GET /api/approvals/[id] - Get a single approval by ID
// ---------------------------------------------------------------------------

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  if (!isValidId(id)) {
    return Response.json({ error: 'Invalid approval ID' }, { status: 400 });
  }

  try {
    const approval = await getApprovalById(id);
    if (!approval) {
      return Response.json({ error: 'Approval not found' }, { status: 404 });
    }
    return Response.json(approval);
  } catch (err) {
    console.error('[api/approvals/[id]] GET error:', err);
    return Response.json(
      { error: 'Failed to fetch approval' },
      { status: 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// PATCH /api/approvals/[id] - Resolve an approval via bus/update-approval.sh
//
// Body: { decision: "approved" | "rejected", note?: string }
// ---------------------------------------------------------------------------

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  if (!isValidId(id)) {
    return Response.json({ error: 'Invalid approval ID' }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { decision, note } = body as {
    decision?: string;
    note?: string;
  };

  if (!decision || !VALID_DECISIONS.includes(decision)) {
    return Response.json(
      { error: 'Decision must be "approved" or "rejected"' },
      { status: 400 },
    );
  }

  if (note && typeof note === 'string' && note.length > 1000) {
    return Response.json(
      { error: 'Note must be 1000 characters or fewer' },
      { status: 400 },
    );
  }

  // Security: Strip null bytes and control characters from note.
  const sanitizedNote = note
    ? String(note).replace(/[\x00-\x1F\x7F]/g, '').slice(0, 500)
    : undefined;

  // Look up the approval's org to pass CTX_ORG to bus script
  const approval = await getApprovalById(id);
  if (!approval) {
    return Response.json({ error: 'Approval not found in pending' }, { status: 404 });
  }

  const frameworkRoot = getFrameworkRoot();
  const env = {
    ...process.env,
    CTX_FRAMEWORK_ROOT: frameworkRoot,
    CTX_ROOT: getCTXRoot(),
    CTX_INSTANCE_ID: process.env.CTX_INSTANCE_ID ?? 'default',
    CTX_AGENT_NAME: 'dashboard',
    CTX_ORG: approval.org || '',
  };

  const args: string[] = [id, decision];
  if (sanitizedNote) args.push(sanitizedNote);

  try {
    const result = spawnSync(
      'bash',
      [path.join(frameworkRoot, 'bus', 'update-approval.sh'), ...args],
      { encoding: 'utf-8', timeout: 10000, env, stdio: 'pipe' },
    );
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || 'update-approval.sh failed');
    }

    // Trigger sync so subsequent reads reflect the resolution
    void syncAll().catch(() => {});

    return Response.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    // Check if the script reported "not found"
    if (message.includes('not found')) {
      return Response.json(
        { error: 'Approval not found in pending' },
        { status: 404 },
      );
    }

    console.error('[api/approvals/[id]] PATCH error:', message);
    return Response.json(
      { error: 'Failed to resolve approval', details: message },
      { status: 500 },
    );
  }
}
