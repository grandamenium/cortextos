/**
 * Stop hook - writes a Unix timestamp to last_idle.flag.
 *
 * Used by fast-checker to determine whether the agent is currently "working"
 * on a response to a Telegram message (for the typing indicator).
 *
 * Logic in fast-checker:
 *   typing = last_message_injected > last_idle AND within 10 min
 */
import { writeFileSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

async function main(): Promise<void> {
  const agentName = process.env.CTX_AGENT_NAME;
  const instanceId = process.env.CTX_INSTANCE_ID || 'default';
  if (!agentName) return;

  const stateDir = join(homedir(), '.cortextos', instanceId, 'state', agentName);
  try {
    mkdirSync(stateDir, { recursive: true });
    const idleFlag = join(stateDir, 'last_idle.flag');
    writeFileSync(idleFlag, String(Math.floor(Date.now() / 1000)), 'utf-8');
    try { chmodSync(idleFlag, 0o600); } catch { /* ignore on unsupported platforms */ }
  } catch { /* ignore */ }
}

main().catch(() => process.exit(0));
