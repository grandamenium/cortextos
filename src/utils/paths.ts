import { homedir } from 'os';
import { join } from 'path';
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
