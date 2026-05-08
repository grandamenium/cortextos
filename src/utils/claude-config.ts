import { existsSync, readFileSync } from 'fs';
import { atomicWriteSync } from './atomic.js';

/**
 * Pre-seed Claude Code's per-project trust acceptance for `cwd` so an
 * unattended PTY agent doesn't wedge on the workspace-trust dialog.
 *
 * Claude Code reads `<configDir>/.claude.json` and looks up
 * `.projects[<cwd>].hasTrustDialogAccepted` on session start. When the
 * value is missing or false, claude renders an interactive trust prompt
 * and waits for keyboard input that an unattended agent will never
 * provide. Writing `true` ahead of spawn is the structured replacement
 * for the previous output-substring heuristic that auto-pressed Enter
 * (which silently backfired when Claude Code 2.1.126 added a Bypass
 * Permissions dialog whose default option exits the session).
 *
 * Best-effort: if the config file is missing, malformed, or the write
 * fails, the function returns silently. The agent will fall back to the
 * runtime trust dialog — operator can hand-accept once and the value
 * sticks. Failing the spawn over a config seed would be worse than the
 * fallback.
 *
 * **Concurrency note:** the read-modify-write window is unguarded.
 * `atomicWriteSync` makes the final rename atomic, but if the operator
 * is running interactive `claude` against the same `~/.claude.json`
 * (default-account case where CLAUDE_CONFIG_DIR is unset and the agent
 * shares the operator's home), one side's write between the other side's
 * read and rename can be silently dropped. The seed itself is
 * idempotent — re-running on next spawn re-asserts — so the fallout is
 * at most a single missed seed, which the runtime trust handler in
 * `agent-pty.ts` recovers from. Per-agent isolated CLAUDE_CONFIG_DIR
 * (a separate BL) closes this race entirely.
 */
export function seedTrustDialog(claudeJsonPath: string, cwd: string): void {
  let obj: Record<string, unknown> = {};
  if (existsSync(claudeJsonPath)) {
    try {
      const raw = readFileSync(claudeJsonPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        obj = parsed as Record<string, unknown>;
      }
    } catch {
      return;
    }
  }

  const projects = (obj.projects && typeof obj.projects === 'object' && !Array.isArray(obj.projects))
    ? obj.projects as Record<string, Record<string, unknown>>
    : {};
  const entry = (projects[cwd] && typeof projects[cwd] === 'object') ? projects[cwd] : {};
  if (entry.hasTrustDialogAccepted === true) return;

  entry.hasTrustDialogAccepted = true;
  projects[cwd] = entry;
  obj.projects = projects;

  try {
    atomicWriteSync(claudeJsonPath, JSON.stringify(obj, null, 2));
  } catch {
    // Best-effort; agent will fall back to runtime trust prompt.
  }
}
