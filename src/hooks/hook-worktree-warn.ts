/**
 * SessionStart hook — warns if the agent has booted with cwd inside a
 * canonical shared working tree.
 *
 * BL-2026-05-08-005 convention: each agent works in
 *   ~/cortextos-worktrees/<agent>/<branch>
 * or
 *   ~/jarvis-worktrees/<agent>/<branch>
 * and never directly in
 *   /Volumes/MacStorage/UserData/0devprojects/sb-cortextos-fork
 *   /Volumes/MacStorage/UserData/0devprojects/sb-claude-jarvis
 *
 * Configured in settings.json as a SessionStart hook:
 *   "SessionStart": [
 *     { "hooks": [{ "type": "command",
 *                   "command": "cortextos bus hook-worktree-warn",
 *                   "timeout": 5 }] }
 *   ]
 *
 * Output:
 * - Always exits 0; a SessionStart hook failure must not block boot.
 * - On no match: writes `{}` to stdout (no additional context).
 * - On match: emits a `worktree_canonical_boot_warning` bus event AND
 *   writes hookSpecificOutput.additionalContext so the warning lands in
 *   the agent's session context immediately. The injected message uses
 *   the matched canonical's worktree-dir convention so the agent gets
 *   the right path whether they're in cortextos-fork OR jarvis.
 */

import { realpathSync } from 'fs';
import { basename } from 'path';

import { logEvent } from '../bus/event.js';
import { resolvePaths } from '../utils/paths.js';
import { readStdin } from './index.js';

const DEFAULT_CANONICAL_PATHS = [
  '/Volumes/MacStorage/UserData/0devprojects/sb-cortextos-fork',
  '/Volumes/MacStorage/UserData/0devprojects/sb-claude-jarvis',
];

/**
 * Maps a canonical-path basename to its per-agent worktree-dir prefix.
 * Add new entries here when new shared repos enter the convention.
 */
const WORKTREE_DIR_BY_CANONICAL_BASENAME: Record<string, string> = {
  'sb-cortextos-fork': '~/cortextos-worktrees',
  'sb-claude-jarvis': '~/jarvis-worktrees',
};

/**
 * Test-only escape hatch. When `CTX_HOOK_CANONICAL_PATHS_OVERRIDE` is set,
 * the hook treats its colon-separated value as the canonical-paths list
 * instead of DEFAULT_CANONICAL_PATHS. Tests use this to point at tmp dirs
 * so subprocess assertions don't depend on `/Volumes/...` existing on the
 * CI runner. Production never sets this var.
 */
export function resolveCanonicalPaths(): string[] {
  const override = process.env.CTX_HOOK_CANONICAL_PATHS_OVERRIDE;
  if (override) {
    return override.split(':').map((s) => s.trim()).filter(Boolean);
  }
  return DEFAULT_CANONICAL_PATHS;
}

/**
 * Resolve a path through symlinks. Returns input unchanged on failure.
 */
function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Returns the matched canonical root if `cwd` is exactly one of the
 * canonical roots OR a descendant of one; else null. The trailing-slash
 * check prevents false positives on sibling paths that share a prefix
 * (e.g. `/Volumes/.../sb-cortextos-fork-other` does NOT match
 * `/Volumes/.../sb-cortextos-fork`).
 */
export function matchedCanonical(cwd: string, canonicalPaths?: string[]): string | null {
  const paths = canonicalPaths ?? resolveCanonicalPaths();
  for (const canonical of paths) {
    if (cwd === canonical || cwd.startsWith(canonical + '/')) return canonical;
  }
  return null;
}

/**
 * Convenience boolean form of {@link matchedCanonical}, kept as a stable
 * export for callers that only care about the yes/no.
 */
export function isUnderCanonical(cwd: string, canonicalPaths?: string[]): boolean {
  return matchedCanonical(cwd, canonicalPaths) !== null;
}

/**
 * Resolve the worktree-dir prefix for a matched canonical root. Falls
 * back to `~/<basename>-worktrees` for canonicals not in the explicit
 * map — keeps the message useful for forks that follow the same
 * naming convention without needing to update this table.
 */
export function worktreeDirFor(canonical: string): string {
  const name = basename(canonical);
  return WORKTREE_DIR_BY_CANONICAL_BASENAME[name] ?? `~/${name}-worktrees`;
}

/**
 * Build the warning text injected as additionalContext. The matched
 * canonical drives BOTH the `cd` target (so the agent fetches from the
 * right repo) and the worktree-dir prefix (so jarvis cwd → jarvis
 * worktree path).
 */
export function buildWarningMessage(
  agentName: string,
  cwd: string,
  canonical: string,
): string {
  const worktreeDir = worktreeDirFor(canonical);
  return [
    `[BL-005 worktree warning] You booted with cwd inside a shared canonical working tree:`,
    `  ${cwd}`,
    ``,
    `Branch operations there silently corrupt other agents' uncommitted state. Before any non-trivial`,
    `code work, switch to a per-agent worktree:`,
    ``,
    `  cd ${canonical}`,
    `  git fetch origin main`,
    `  git worktree add ${worktreeDir}/${agentName}/<branch> -b <branch> origin/main`,
    `  cd ${worktreeDir}/${agentName}/<branch>`,
    ``,
    `Read-only ops here (git fetch, log, status against main) are fine. See your CLAUDE.md`,
    `§ "Working tree (shared-repo discipline)" for the full workflow.`,
  ].join('\n');
}

async function main(): Promise<void> {
  // Drain stdin so Claude Code's hook-input pipe doesn't block. We don't
  // currently need any field from the SessionStart payload, but the harness
  // still pipes JSON on stdin and an unread pipe can stall.
  await readStdin().catch(() => '');

  const agentName = process.env.CTX_AGENT_NAME;
  if (!agentName) {
    process.stdout.write('{}\n');
    return;
  }

  const cwd = safeRealpath(process.cwd());
  const canonical = matchedCanonical(cwd);
  if (!canonical) {
    process.stdout.write('{}\n');
    return;
  }

  // Best-effort audit-trail event. logEvent has its own internal error
  // handling; we still wrap defensively so a failed write never poisons
  // session boot.
  try {
    const instanceId = process.env.CTX_INSTANCE_ID || 'default';
    const org = process.env.CTX_ORG || '';
    const paths = resolvePaths(agentName, instanceId, org);
    logEvent(paths, agentName, org, 'action', 'worktree_canonical_boot_warning', 'warning', {
      cwd,
      agent: agentName,
      canonical,
      worktree_dir: worktreeDirFor(canonical),
      reminder: `use ${worktreeDirFor(canonical)}/<agent>/<branch> for non-trivial code work`,
    });
  } catch { /* non-fatal */ }

  const output = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: buildWarningMessage(agentName, cwd, canonical),
    },
  };
  process.stdout.write(JSON.stringify(output) + '\n');
}

// Always exit 0 — see file header.
main().catch(() => undefined).then(() => process.exit(0));
