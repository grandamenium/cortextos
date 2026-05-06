/**
 * SessionStart hook — automated session-start protocol steps.
 *
 * Guarantees that four non-negotiable actions run on every session
 * start, regardless of whether the agent's prompt-level instructions
 * are followed:
 *
 *   1. Heartbeat update — marks the agent as online in the dashboard
 *   2. Daily memory entry — captures session start for cross-session continuity
 *   3. Inbox check — surfaces any un-ACK'd messages waiting for this agent
 *   4. Session-start event log — makes the session visible in the activity feed
 *
 * Principle (instar): "A 1,000-line prompt is a wish. A 10-line hook
 * is a guarantee." These steps were previously prompt-only instructions
 * that agents sometimes skipped, leaving them appearing offline or
 * losing context across restarts.
 */
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execFileSync } from 'child_process';

async function main(): Promise<void> {
  const agentName = process.env.CTX_AGENT_NAME;
  const instanceId = process.env.CTX_INSTANCE_ID || 'default';
  const org = process.env.CTX_ORG || '';
  if (!agentName) return;

  const ctxRoot = join(homedir(), '.cortextos', instanceId);

  // 1. Heartbeat update
  try {
    execFileSync('cortextos', ['bus', 'update-heartbeat', 'session_start: coming online'], {
      timeout: 10000,
      stdio: 'ignore',
    });
  } catch { /* non-fatal — agent may still be starting */ }

  // 2. Daily memory entry
  try {
    const agentDir = process.env.CTX_AGENT_DIR || process.cwd();
    const today = new Date().toISOString().split('T')[0];
    const timeUtc = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const memoryDir = join(agentDir, 'memory');
    mkdirSync(memoryDir, { recursive: true });
    appendFileSync(
      join(memoryDir, `${today}.md`),
      `\n## Session Start - ${timeUtc}\n- Status: coming online (hook-session-start)\n`,
      'utf-8',
    );
  } catch { /* non-fatal */ }

  // 3. Inbox check (output goes to stderr so it's visible but doesn't block)
  try {
    const result = execFileSync('cortextos', ['bus', 'check-inbox'], {
      timeout: 10000,
      encoding: 'utf-8',
    });
    if (result.trim() !== '[]') {
      process.stderr.write(`[hook-session-start] Inbox has pending messages\n`);
    }
  } catch { /* non-fatal */ }

  // 4. Session-start event log
  try {
    execFileSync('cortextos', [
      'bus', 'log-event', 'action', 'session_start', 'info',
      '--meta', JSON.stringify({ agent: agentName, source: 'hook' }),
    ], {
      timeout: 10000,
      stdio: 'ignore',
    });
  } catch { /* non-fatal */ }
}

main().catch(() => { /* hooks must never crash the session */ });
