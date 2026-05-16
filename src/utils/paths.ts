import { homedir } from 'os';
import { join } from 'path';
import { existsSync } from 'fs';
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
 * Bootstrap file that marks a directory as a fully scaffolded agent.
 * An agent without this file will silently misbehave when Claude Code launches
 * because the session-start prompt instructs the agent to read it first.
 */
const AGENT_BOOTSTRAP_FILE = 'AGENTS.md';

/**
 * Return true when `dir` looks like a scaffolded agent directory.
 * The check is intentionally narrow: presence of `AGENTS.md`. Other bootstrap
 * files (HEARTBEAT.md, IDENTITY.md) may be staged piecemeal during onboarding,
 * but AGENTS.md is what the start-up prompt reads first — without it the agent
 * cannot bootstrap.
 */
export function isAgentDirScaffolded(dir: string | undefined): boolean {
  if (!dir) return false;
  return existsSync(join(dir, AGENT_BOOTSTRAP_FILE));
}

/**
 * Resolve the cwd for an agent PTY, respecting `config.working_directory` only
 * when it points at a real scaffolded agent directory.
 *
 * Order:
 *   1. `configWorkingDirectory` if set AND the path contains `AGENTS.md`
 *   2. `agentDir` if set
 *   3. `process.cwd()` as ultimate fallback
 *
 * If `configWorkingDirectory` is set but invalid (path missing, or missing
 * AGENTS.md), the optional `warn` callback is invoked and the resolver falls
 * back to `agentDir`. This prevents a typo in `config.working_directory` from
 * silently launching Claude Code into an unrelated repo whose AGENTS.md
 * belongs to a different system — the exact failure mode that broke
 * director/analyst against /Users/.../work/team-brain on 2026-05-15.
 */
export function resolveAgentCwd(
  agentDir: string | undefined,
  configWorkingDirectory: string | undefined,
  warn?: (msg: string) => void,
): string {
  const override = configWorkingDirectory?.trim();
  if (override) {
    if (isAgentDirScaffolded(override)) {
      return override;
    }
    warn?.(
      `config.working_directory=${JSON.stringify(override)} is not a scaffolded agent dir ` +
      `(no ${AGENT_BOOTSTRAP_FILE} found); falling back to agentDir`,
    );
  }
  return agentDir || process.cwd();
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
  // Respect CTX_ROOT so processes spawned in a sandboxed test environment
  // (CTX_ROOT=/tmp/XXX) connect to the sandbox socket, not the production
  // daemon. Without this, integration tests that set CTX_ROOT but not
  // CTX_INSTANCE_ID silently hit the live daemon (observed: race-agent
  // IPC storm 2026-05-14T17:14Z from concurrent-cron-mutations test).
  const ctxRoot = process.env.CTX_ROOT ?? join(homedir(), '.cortextos', instanceId);
  return join(ctxRoot, 'daemon.sock');
}
