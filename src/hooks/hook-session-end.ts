/**
 * SessionEnd hook — automated session-end protocol steps.
 *
 * Guarantees that context capture and event logging happen on every
 * session end, regardless of how the session terminates (clean exit,
 * crash, context exhaustion, rate limit).
 *
 *   1. Daily memory capture — last chance to save context before the
 *      session dies. Without this, the next session starts blind.
 *   2. Session-end event log — marks the natural endpoint in the
 *      dashboard activity feed. Without this, sessions appear to hang.
 *
 * Runs alongside the existing hook-crash-alert (which handles Telegram
 * notifications). This hook handles the state-persistence side.
 */
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execFileSync } from 'child_process';

async function main(): Promise<void> {
  const agentName = process.env.CTX_AGENT_NAME;
  const instanceId = process.env.CTX_INSTANCE_ID || 'default';
  if (!agentName) return;

  // 1. Daily memory capture
  try {
    const agentDir = process.env.CTX_AGENT_DIR || process.cwd();
    const today = new Date().toISOString().split('T')[0];
    const timeUtc = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const memoryDir = join(agentDir, 'memory');
    mkdirSync(memoryDir, { recursive: true });
    appendFileSync(
      join(memoryDir, `${today}.md`),
      `\n## Session End - ${timeUtc}\n- Status: session ending (hook-session-end)\n`,
      'utf-8',
    );
  } catch { /* non-fatal — session may be in a bad state */ }

  // 2. Session-end event log
  try {
    execFileSync('cortextos', [
      'bus', 'log-event', 'action', 'session_end', 'info',
      '--meta', JSON.stringify({ agent: agentName, source: 'hook' }),
    ], {
      timeout: 10000,
      stdio: 'ignore',
    });
  } catch { /* non-fatal */ }
}

main().catch(() => { /* hooks must never crash the session */ });
