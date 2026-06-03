/**
 * Dashboard runtime-path resolver.
 *
 * This module MIRRORS the resolution rules in `src/utils/paths.ts` so that the
 * Next.js dashboard reads and writes runtime data in the SAME directory tree
 * the daemon, CLI, hooks and agents use (#38 #39 #40).
 *
 * Resolution order (matches src/utils/paths.ts getCtxRoot, #568):
 *   1. explicit ctxRoot argument
 *   2. CTX_ROOT environment variable
 *   3. ~/.cortextos/{instance} default
 *
 * CTX_ROOT, when set, IS the full per-instance data root — the instance id is
 * NOT appended to it. Deployments that relocate the data root (e.g.
 * ~/agentic/cortextos-data) MUST set CTX_ROOT consistently for the daemon and
 * the dashboard, otherwise they resolve different trees — which is exactly the
 * bug #38/#39/#40 fix this.
 *
 * IMPORTANT: `$CTX_ROOT/orgs/...` is canonical for ALL runtime data (agent
 * workspaces, configs, goals, knowledge base, tasks, org context).
 * CTX_FRAMEWORK_ROOT is ONLY for framework CODE (templates/, dist/, bus
 * scripts, the system-wide skills catalog, the python venv).
 */
import path from 'path';
import os from 'os';

// Mirrors src/utils/validate.ts AGENT_NAME_REGEX / validateInstanceId.
const INSTANCE_ID_REGEX = /^[a-z0-9_-]+$/;

export function validateInstanceId(instanceId: string): void {
  if (!instanceId || !INSTANCE_ID_REGEX.test(instanceId)) {
    throw new Error(
      `Invalid instance ID '${instanceId}'. Must contain only lowercase letters, numbers, underscores, and hyphens.`,
    );
  }
}

/**
 * Resolve the cortextOS data root for an instance.
 *
 * Precedence: explicit ctxRoot arg > CTX_ROOT env > ~/.cortextos/{instance}.
 * The `||` chain means a falsy explicit arg (including an empty string `''`) is
 * treated as "not provided" and falls through to env then default — this is
 * deliberate and matches src/utils/paths.ts exactly. validateInstanceId always
 * runs first, so an invalid instanceId throws regardless of which branch wins.
 *
 * This MUST NOT tilde-expand. The canonical daemon resolver
 * (src/utils/paths.ts:getCtxRoot) does NOT expand a leading `~`, so expanding
 * here would make the dashboard and daemon resolve different physical roots
 * for `CTX_ROOT=~/...` and read/write different KB trees. Deployments SHOULD
 * set CTX_ROOT to an absolute path (the default branch already is absolute via
 * os.homedir()).
 */
export function getCtxRoot(instanceId: string = 'default', ctxRoot?: string): string {
  validateInstanceId(instanceId);
  return ctxRoot || process.env.CTX_ROOT || path.join(os.homedir(), '.cortextos', instanceId);
}

/** The instance id from the environment, defaulting to 'default'. */
export function getInstanceId(): string {
  // Treat an unset OR empty CTX_INSTANCE_ID as 'default' — an empty string is
  // never a valid instance id and would otherwise fail validateInstanceId().
  return process.env.CTX_INSTANCE_ID || 'default';
}

/**
 * IPC socket path for daemon communication (#40).
 * Unix domain socket inside the data root (honours CTX_ROOT), named pipe on
 * Windows (instance-keyed, not path-based — CTX_ROOT does not apply).
 * Mirrors src/utils/paths.ts getIpcPath.
 */
export function getIpcPath(instanceId: string = getInstanceId(), ctxRoot?: string): string {
  validateInstanceId(instanceId);
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\cortextos-${instanceId}`;
  }
  return path.join(getCtxRoot(instanceId, ctxRoot), 'daemon.sock');
}

/** Org directory under the data root: `$ctxRoot/orgs/<org>`. */
export function getOrgDir(org: string, instanceId: string = getInstanceId(), ctxRoot?: string): string {
  return path.join(getCtxRoot(instanceId, ctxRoot), 'orgs', org);
}

/**
 * Agent workspace directory (#39).
 * With org: `$ctxRoot/orgs/<org>/agents/<agent>`.
 * Without org: `$ctxRoot/agents/<agent>`.
 */
export function getAgentDir(
  agent: string,
  org?: string,
  instanceId: string = getInstanceId(),
  ctxRoot?: string,
): string {
  const root = getCtxRoot(instanceId, ctxRoot);
  if (org) {
    return path.join(root, 'orgs', org, 'agents', agent);
  }
  return path.join(root, 'agents', agent);
}

/** Knowledge-base directory for an org (#38): `$ctxRoot/orgs/<org>/knowledge-base`. */
export function getKnowledgeBaseDir(
  org: string,
  instanceId: string = getInstanceId(),
  ctxRoot?: string,
): string {
  return path.join(getOrgDir(org, instanceId, ctxRoot), 'knowledge-base');
}
