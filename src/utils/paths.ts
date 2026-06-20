import { homedir } from 'os';
import { existsSync, readdirSync } from 'fs';
import { join, sep } from 'path';
import type { BusPaths } from '../types/index.js';
import { validateInstanceId } from './validate.js';

/**
 * Resolve all bus paths for an agent.
 * Mirrors the path resolution in bash _ctx-env.sh.
 *
 * The directory layout is:
 *   ~/.cortextos/{instance}/
 *     config/                - enabled-agents.json
 *     state/{agent}/         - flat, per-agent subdirs
 *     state/{agent}/heartbeat.json - canonical heartbeat location
 *     state/oauth/           - OAuth accounts.json (token store)
 *     state/usage/           - Usage monitoring snapshots
 *     inbox/{agent}/         - flat (not org-nested)
 *     inflight/{agent}/      - flat
 *     processed/{agent}/     - flat
 *     outbox/{agent}/        - flat
 *     logs/{agent}/          - flat
 *     orgs/{org}/tasks/      - org-scoped
 *     orgs/{org}/approvals/  - org-scoped
 *     orgs/{org}/analytics/  - org-scoped
 */
export function resolvePaths(
  agentName: string,
  instanceId: string = 'default',
  org?: string,
): BusPaths {
  validateInstanceId(instanceId);
  const ctxRoot = join(homedir(), '.cortextos', instanceId);

  // Org-scoped paths for tasks, approvals, analytics
  const orgBase = org ? join(ctxRoot, 'orgs', org) : ctxRoot;

  return {
    ctxRoot,
    inbox: join(ctxRoot, 'inbox', agentName),
    inflight: join(ctxRoot, 'inflight', agentName),
    processed: join(ctxRoot, 'processed', agentName),
    logDir: join(ctxRoot, 'logs', agentName),
    stateDir: join(ctxRoot, 'state', agentName),
    taskDir: join(orgBase, 'tasks'),
    approvalDir: join(orgBase, 'approvals'),
    analyticsDir: join(orgBase, 'analytics'),
    deliverablesDir: join(orgBase, 'deliverables'),
  };
}

/**
 * Resolve the obsidian-vault root that holds the LIVE coordination layer.
 *
 * The naive `<frameworkRoot>/obsidian-vault` is wrong when the daemon runs from
 * a git worktree (e.g. `<repo>/.claude/worktrees/<name>`): that path is an empty
 * placeholder dir while the populated vault lives at the repo root. Mere
 * dir-existence (the `||` resolver in bus.ts) would pick the empty one, so this
 * resolver REQUIRES a populated `agent-shared/` before accepting a candidate.
 *
 * Priority: CTX_VAULT_ROOT → <frameworkRoot>/obsidian-vault → the repo-root vault
 * derived from a `.claude/worktrees/` framework root. The first candidate whose
 * `agent-shared/` already exists wins; otherwise the first candidate (created on
 * first write).
 */
export function resolveVaultRoot(frameworkRoot?: string): string {
  const candidates: string[] = [];
  if (process.env.CTX_VAULT_ROOT) candidates.push(process.env.CTX_VAULT_ROOT);
  if (frameworkRoot) {
    candidates.push(join(frameworkRoot, 'obsidian-vault'));
    // If frameworkRoot is a worktree under `<repo>/.claude/worktrees/<name>`,
    // the real vault lives at the repo root, not inside the worktree.
    const marker = `${sep}.claude${sep}worktrees${sep}`;
    const idx = frameworkRoot.indexOf(marker);
    if (idx !== -1) candidates.push(join(frameworkRoot.slice(0, idx), 'obsidian-vault'));
  }
  // Prefer a candidate that already holds a populated agent-shared/ (the live board).
  for (const c of candidates) {
    if (existsSync(join(c, 'agent-shared'))) return c;
  }
  return candidates[0] ?? join(frameworkRoot ?? process.cwd(), 'obsidian-vault');
}

/**
 * Discover the primary org under an orgs/ directory. Returns the sole org if
 * there is exactly one, else the org with the most tasks, else null. Used to
 * default a daemon launched with an empty CTX_ORG so it reads the real task
 * store (`orgs/<org>/tasks`) instead of the empty `<ctxRoot>/tasks`.
 */
export function discoverPrimaryOrgIn(orgsDir: string): string | null {
  let dirs: string[];
  try {
    dirs = readdirSync(orgsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return null;
  }
  if (dirs.length === 0) return null;
  if (dirs.length === 1) return dirs[0];
  let best: string | null = null;
  let bestN = -1;
  for (const o of dirs) {
    let n = 0;
    try { n = readdirSync(join(orgsDir, o, 'tasks')).length; } catch { /* no tasks dir */ }
    if (n > bestN) { bestN = n; best = o; }
  }
  return best;
}

/** Discover the primary org for an instance (see discoverPrimaryOrgIn). */
export function discoverPrimaryOrg(instanceId: string = 'default'): string | null {
  validateInstanceId(instanceId);
  return discoverPrimaryOrgIn(join(homedir(), '.cortextos', instanceId, 'orgs'));
}

/**
 * Get the IPC socket path for daemon communication.
 * Unix domain socket on macOS/Linux, named pipe on Windows.
 */
export function getIpcPath(instanceId: string = 'default'): string {
  validateInstanceId(instanceId);
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\cortextos-${instanceId}`;
  }
  return join(homedir(), '.cortextos', instanceId, 'daemon.sock');
}
