'use server';

import { spawnSync } from 'child_process';
import path from 'path';
import { revalidatePath } from 'next/cache';
import { getFrameworkRoot, getCTXRoot } from '@/lib/config';
import { syncAll } from '@/lib/sync';
import type { ActionResult } from '@/lib/types';

// ---------------------------------------------------------------------------
// Server Actions
// ---------------------------------------------------------------------------

/**
 * Resolve an approval by shelling out to bus/update-approval.sh.
 * Revalidates the approvals and overview pages after resolution.
 */
export async function resolveApproval(
  id: string,
  decision: 'approved' | 'rejected',
  note?: string,
): Promise<ActionResult> {
  // Validate inputs
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    return { success: false, error: 'Invalid approval ID' };
  }

  if (!['approved', 'rejected'].includes(decision)) {
    return { success: false, error: 'Decision must be "approved" or "rejected"' };
  }

  if (note && note.length > 1000) {
    return { success: false, error: 'Note must be 1000 characters or fewer' };
  }

  const frameworkRoot = getFrameworkRoot();
  const env = {
    ...process.env,
    CTX_FRAMEWORK_ROOT: frameworkRoot,
    CTX_ROOT: getCTXRoot(),
    CTX_AGENT_NAME: 'dashboard',
  };

  const args: string[] = [id, decision];
  if (note) args.push(note);

  try {
    const result = spawnSync(
      'bash',
      [path.join(frameworkRoot, 'bus', 'update-approval.sh'), ...args],
      { encoding: 'utf-8', timeout: 10000, env, stdio: 'pipe' },
    );
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || 'update-approval.sh failed');
    }

    // Sync so SQLite reflects the change
    void syncAll().catch(() => {});

    // Revalidate pages that show approval data
    revalidatePath('/approvals');
    revalidatePath('/'); // Overview "Action Required" section

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[actions/approvals] resolveApproval error:', message);
    return { success: false, error: message };
  }
}
