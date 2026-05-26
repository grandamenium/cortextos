/**
 * hook-policy-check.ts — PreToolUse hook for Bash: enforces P1, P2, P4 policies.
 *
 * P1: No direct external sends (specialist agents must route through orchestrator).
 * P2: Push to fork, never origin.
 * P4: Git staging discipline — no git add -A or git add .
 *
 * On violation: writes { decision: 'block', reason } to stdout and exits 0.
 * All other paths exit 0 silently so the tool call proceeds.
 * On crash: exits non-zero → tool call is BLOCKED (fail-closed). Intentional.
 *
 * Block events are logged to the bus Activity feed for diagnosis.
 */

import { execFileSync } from 'child_process';
import { readStdin, parseHookInput } from './index.js';

// ---------------------------------------------------------------------------
// Block helpers
// ---------------------------------------------------------------------------

function blockCall(policy: string, reason: string): void {
  const output = { decision: 'block', reason };
  process.stdout.write(JSON.stringify(output) + '\n');

  // Log to Activity feed (best-effort — never let this prevent the block)
  const agent = process.env.CTX_AGENT_NAME || 'unknown';
  try {
    execFileSync('cortextos', [
      'bus', 'log-event', 'policy', 'policy_block', 'warn',
      '--meta', JSON.stringify({ policy, agent, reason }),
    ], { timeout: 3000, stdio: 'ignore' });
  } catch {
    // Logging failure must not affect the block decision
  }

  process.exit(0);
}

// ---------------------------------------------------------------------------
// Policy checks
// ---------------------------------------------------------------------------

/**
 * P1: Specialist agents must not send Telegram messages directly.
 * Orchestrator is exempt. Unknown/unset CTX_AGENT_NAME skips this check
 * to avoid blocking orchestrator in misconfigured environments.
 */
function checkP1(command: string, agent: string): void {
  if (!agent || agent === 'unknown' || agent === 'orchestrator') return;

  // Match: send-telegram followed by a numeric chat ID (8+ digits)
  if (/send-telegram[^|&\n]*[0-9]{8,}/.test(command)) {
    blockCall('P1', `BLOCKED: specialist agents cannot send-telegram to user; route via cortextos bus send-message orchestrator instead per external-comms-funnel rule. Agent: "${agent}"`);
  }
}

/**
 * P2: All git pushes must target 'fork' remote, never 'origin'.
 * origin = grandamenium public repo with 77 external PRs.
 *
 * Strips heredoc content (<<'EOF'...EOF) before matching so that
 * commit messages containing "git push" in their body don't false-positive.
 */
function checkP2(command: string, agent: string): void {
  // Strip heredoc content — everything from <<'MARKER' or <<MARKER onward.
  // This prevents "git push" in commit message bodies from triggering P2.
  let skeleton = command.replace(/<<\s*['"]?\w+['"]?[\s\S]*/g, '');

  // Strip double-quoted and single-quoted strings so that "git push" appearing
  // inside --body "..." arguments or other quoted values is ignored.
  skeleton = skeleton.replace(/"[^"\\]*(?:\\.[^"\\]*)*"/g, '""');
  skeleton = skeleton.replace(/'[^'\\]*(?:\\.[^'\\]*)*'/g, "''");

  // Only check the skeleton when "git push" appears at a command boundary:
  // start-of-string, after &&, ||, ;, |, (, or newline — optionally with whitespace.
  // This prevents "git push" mentioned inside arguments from triggering the check.
  const GIT_PUSH = /(?:^|&&|\|\||;|\||\(|\n)\s*git push/;
  if (!GIT_PUSH.test(skeleton)) return;

  // Allow if 'fork' is the explicit remote.
  // Flags like -u, --set-upstream, --force-with-lease may appear before the remote name.
  if (/git push(?:\s+--?\S+)*\s+fork/.test(skeleton)) return;

  // Allow --delete on any remote (branch deletion is low-risk)
  if (/git push\s+\S+\s+--delete/.test(skeleton) || /git push\s+--delete/.test(skeleton)) return;

  blockCall('P2', `Push target must be 'fork' (RevOps-Global-GIT), not origin (grandamenium — public repo). Use: git push fork <branch>. Agent: "${agent}"`);
}

/**
 * P4: Git staging discipline — never git add -A or git add . (catch-all staging).
 * Allow git add ./relative/path.ts (relative paths after ./).
 * Pattern anchors: end-of-string or space after the dot (not followed by /).
 */
function checkP4(command: string, agent: string): void {
  // git add -A (flag form)
  if (/git add\s+-A/.test(command)) {
    blockCall('P4', `Use git add <specific paths>, not -A. Untracked files may contain secrets or large binaries. Agent: "${agent}"`);
  }

  // git add . at end-of-command or followed by space (not ./ which is a relative path)
  if (/git add\s+\.(\s|$)/.test(command)) {
    blockCall('P4', `Use git add <specific paths>, not '.'. Untracked files may be swept in. Agent: "${agent}"`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const raw = await readStdin();
  const { tool_name, tool_input } = parseHookInput(raw);

  // This hook only applies to Bash tool calls
  if (tool_name !== 'Bash') {
    process.exit(0);
  }

  const command: string = tool_input?.command ?? '';
  const agent = process.env.CTX_AGENT_NAME || 'unknown';

  // Strip heredoc content for all checks — prevents commit message bodies
  // containing policy-example text from triggering false-positives.
  // Note: bash allows a space between << and the delimiter (e.g. << 'EOF'),
  // so \s* is required to catch both `<<'EOF'` and `<< 'EOF'` forms.
  const skeleton = command.replace(/<<\s*['"]?\w+['"]?[\s\S]*/g, '');

  checkP1(skeleton, agent);
  checkP2(command, agent); // checkP2 does its own heredoc strip internally
  checkP4(skeleton, agent);

  // All checks passed — allow the tool call
  process.exit(0);
}

main().catch(err => {
  // Unhandled error → exits with non-zero → fail-closed (tool call blocked)
  process.stderr.write(`hook-policy-check error: ${err}\n`);
  process.exit(1);
});
