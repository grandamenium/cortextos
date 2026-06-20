import { NextResponse } from 'next/server';
import { getVaultRoot } from '@/lib/config';
import { computeVaultHealth } from '@/lib/health/vault-health';

export const dynamic = 'force-dynamic';

/**
 * GET /api/health — coordination-layer liveness.
 *
 * Reports whether the cortextos VaultLivenessWatchdog is keeping the vault board
 * fresh. Always returns 200 so the in-app banner poller can read the JSON body;
 * the real state is `status` (ok | stale | down).
 */
export async function GET() {
  try {
    const vaultRoot = getVaultRoot();
    return NextResponse.json(computeVaultHealth(vaultRoot));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({
      status: 'down',
      checkedAt: new Date().toISOString(),
      messages: [`Health check failed: ${message}`],
      board: { path: 'agent-shared/active-tasks.md', exists: false, ageMinutes: null, stale: true, placeholder: false },
      projectState: { path: 'agent-shared/project-state.md', exists: false, ageMinutes: null, stale: true, placeholder: false },
    });
  }
}
