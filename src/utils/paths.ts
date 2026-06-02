import { homedir } from 'os';
import { join } from 'path';
import type { BusPaths } from '../types/index.js';
import { validateInstanceId } from './validate.js';

/**
 * Resolve the cortextOS data root for an instance.
 *
 * Resolution order (#568):
 *   1. explicit ctxRoot argument (caller already resolved it, e.g. from resolveEnv())
 *   2. CTX_ROOT environment variable
 *   3. ~/.cortextos/{instance} default
 *
 * CTX_ROOT, when set, IS the full per-instance data root — the instance id is
 * not appended to it. This matches resolveEnv() and bash _ctx-env.sh semantics.
 * Deployments that relocate the data root (e.g. ~/agentic/cortextos-data) must
 * set CTX_ROOT consistently for the daemon (ecosystem.config.js) and any shell
 * that runs cortextos CLI commands, otherwise they will resolve different roots.
 */
export function getCtxRoot(instanceId: string = 'default', ctxRoot?: string): string {
  validateInstanceId(instanceId);
  return ctxRoot || process.env.CTX_ROOT || join(homedir(), '.cortextos', instanceId);
}

/**
 * Resolve all bus paths for an agent.
 * Mirrors the path resolution in bash _ctx-env.sh.
 *
 * The directory layout is:
 *   {ctxRoot}/               - CTX_ROOT or ~/.cortextos/{instance}
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
  ctxRoot?: string,
): BusPaths {
  const resolvedCtxRoot = getCtxRoot(instanceId, ctxRoot);

  // Org-scoped paths for tasks, approvals, analytics
  const orgBase = org ? join(resolvedCtxRoot, 'orgs', org) : resolvedCtxRoot;

  return {
    ctxRoot: resolvedCtxRoot,
    inbox: join(resolvedCtxRoot, 'inbox', agentName),
    inflight: join(resolvedCtxRoot, 'inflight', agentName),
    processed: join(resolvedCtxRoot, 'processed', agentName),
    logDir: join(resolvedCtxRoot, 'logs', agentName),
    stateDir: join(resolvedCtxRoot, 'state', agentName),
    taskDir: join(orgBase, 'tasks'),
    approvalDir: join(orgBase, 'approvals'),
    analyticsDir: join(orgBase, 'analytics'),
    deliverablesDir: join(orgBase, 'deliverables'),
  };
}

/**
 * Get the IPC socket path for daemon communication.
 * Unix domain socket on macOS/Linux, named pipe on Windows.
 *
 * On Unix the socket lives inside the data root, so it honours CTX_ROOT (#568).
 * Windows named pipes are instance-keyed, not path-based — CTX_ROOT does not apply.
 */
export function getIpcPath(instanceId: string = 'default', ctxRoot?: string): string {
  validateInstanceId(instanceId);
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\cortextos-${instanceId}`;
  }
  return join(getCtxRoot(instanceId, ctxRoot), 'daemon.sock');
}
