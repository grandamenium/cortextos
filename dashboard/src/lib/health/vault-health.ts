/**
 * Vault coordination-layer health.
 *
 * The cortextos VaultLivenessWatchdog regenerates agent-shared/active-tasks.md
 * from the live bus every ~5 minutes. If that board is missing, frozen on its
 * placeholder, or older than a few regen intervals, the coordination layer (and
 * very likely the daemon) is dead — which is exactly the "fleet ran dead" state
 * this whole effort exists to prevent. The dashboard surfaces it as a banner.
 *
 * Pure-ish: reads the filesystem but the clock is injectable so the status logic
 * is unit-testable.
 */

import { existsSync, statSync, readFileSync } from 'fs';
import { join } from 'path';

/** active-tasks.md is regenerated every ~5m; 15m (3 intervals) without an update ⇒ watchdog down. */
export const BOARD_STALE_MS = 15 * 60 * 1000;
/** project-state.md is narrative; allow a full day before flagging it. */
export const PROJECT_STATE_STALE_MS = 24 * 60 * 60 * 1000;
/** The dead-updater placeholder the liveness watchdog replaces. */
export const PLACEHOLDER = '_will be auto-populated_';

export interface FileHealth {
  path: string;
  exists: boolean;
  ageMinutes: number | null;
  stale: boolean;
  placeholder: boolean;
}

export type HealthStatus = 'ok' | 'stale' | 'down';

export interface VaultHealth {
  status: HealthStatus;
  checkedAt: string;
  messages: string[];
  board: FileHealth;
  projectState: FileHealth;
}

function checkFile(
  full: string,
  rel: string,
  staleMs: number,
  now: number,
  checkPlaceholder: boolean,
): FileHealth {
  if (!existsSync(full)) {
    return { path: rel, exists: false, ageMinutes: null, stale: true, placeholder: false };
  }
  let ageMs: number | null = null;
  try {
    ageMs = now - statSync(full).mtimeMs;
  } catch {
    /* transient stat failure — treat as unknown age, not stale */
  }
  let placeholder = false;
  if (checkPlaceholder) {
    try {
      placeholder = readFileSync(full, 'utf-8').includes(PLACEHOLDER);
    } catch {
      /* unreadable — leave placeholder false */
    }
  }
  const stale = placeholder || (ageMs !== null && ageMs > staleMs);
  return {
    path: rel,
    exists: true,
    ageMinutes: ageMs === null ? null : Math.round(ageMs / 60000),
    stale,
    placeholder,
  };
}

/** Compute the coordination-layer health for a vault root. `now` is injectable for tests. */
export function computeVaultHealth(vaultRoot: string, now: number = Date.now()): VaultHealth {
  const board = checkFile(
    join(vaultRoot, 'agent-shared', 'active-tasks.md'),
    'agent-shared/active-tasks.md',
    BOARD_STALE_MS,
    now,
    true,
  );
  const projectState = checkFile(
    join(vaultRoot, 'agent-shared', 'project-state.md'),
    'agent-shared/project-state.md',
    PROJECT_STATE_STALE_MS,
    now,
    false,
  );

  let status: HealthStatus = 'ok';
  if (!board.exists || board.placeholder) status = 'down';
  else if (board.stale || !projectState.exists || projectState.stale) status = 'stale';

  const messages: string[] = [];
  if (!board.exists) {
    messages.push('Active-tasks board is missing — the liveness watchdog / daemon is not running.');
  } else if (board.placeholder) {
    messages.push('Active-tasks board still shows the placeholder — the liveness watchdog has not regenerated it.');
  } else if (board.stale) {
    messages.push(`Active-tasks board is ${board.ageMinutes}m old — the liveness watchdog may be down.`);
  }
  if (!projectState.exists) {
    messages.push('project-state.md is missing from the vault.');
  } else if (projectState.stale) {
    messages.push(`project-state.md is ${projectState.ageMinutes}m old.`);
  }

  return {
    status,
    checkedAt: new Date(now).toISOString(),
    messages,
    board,
    projectState,
  };
}
