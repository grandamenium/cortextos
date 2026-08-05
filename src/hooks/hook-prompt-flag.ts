/**
 * UserPromptSubmit hook - writes a Unix timestamp to last_prompt.flag.
 *
 * This is the turn-START signal, the counterpart of hook-idle-flag's Stop
 * (turn-end) signal. The daemon's delivery-confirmation loop watches this
 * flag after injecting a message: flag advances past the injection time =
 * the prompt actually submitted and a turn began; no advance = the content
 * is sitting in the CLI input box with a dropped Enter (2026-07-09 stall
 * class) and the injector retries Enter.
 */
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

async function main(): Promise<void> {
  const agentName = process.env.CTX_AGENT_NAME;
  const instanceId = process.env.CTX_INSTANCE_ID || 'default';
  if (!agentName) return;

  const stateDir = join(homedir(), '.cortextos', instanceId, 'state', agentName);
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'last_prompt.flag'), String(Math.floor(Date.now() / 1000)), 'utf-8');
  } catch { /* ignore */ }
}

main().catch(() => process.exit(0));
