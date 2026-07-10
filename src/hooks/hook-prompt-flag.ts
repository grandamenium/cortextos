/**
 * UserPromptSubmit hook - writes turn-start attribution to last_prompt.flag.
 *
 * This is the turn-START signal, the counterpart of hook-idle-flag's Stop
 * (turn-end) signal. The daemon's delivery-confirmation loop watches this
 * flag after injecting a message: flag advances past the injection time =
 * a prompt actually submitted and a turn began; no advance = the content is
 * sitting in the CLI input box with a dropped Enter (2026-07-09 stall class)
 * and the injector retries Enter.
 *
 * 2026-07-10 (G-D2-2): an mtime advance alone cannot be ATTRIBUTED — two
 * injectors racing on one PTY both saw the same advance and one confirmed a
 * payload that never submitted (kirk 13:00Z false confirm). The hook now also
 * records WHAT submitted: the flag file carries JSON {ts, sha256, len} of the
 * submitted prompt, and the raw prompt text goes to last_prompt.txt beside it
 * (same trust boundary as the inbox files in the same state dir). The daemon
 * confirms an injection only when the flag advances AND its payload appears
 * in the submitted prompt. Legacy plain-integer flag content (older hook) is
 * detected by the daemon and degrades to mtime-only confirmation.
 */
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
  } catch {
    return '';
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function main(): Promise<void> {
  const agentName = process.env.CTX_AGENT_NAME;
  const instanceId = process.env.CTX_INSTANCE_ID || 'default';
  if (!agentName) return;

  // UserPromptSubmit hooks receive JSON on stdin including the submitted prompt.
  let prompt = '';
  try {
    const raw = await readStdin();
    if (raw) {
      const payload = JSON.parse(raw);
      if (typeof payload.prompt === 'string') prompt = payload.prompt;
    }
  } catch {
    // No/invalid stdin — flag still stamps the turn start, attribution absent.
  }

  const stateDir = join(homedir(), '.cortextos', instanceId, 'state', agentName);
  try {
    mkdirSync(stateDir, { recursive: true });
    const flag = {
      ts: Math.floor(Date.now() / 1000),
      sha256: prompt ? createHash('sha256').update(prompt, 'utf-8').digest('hex') : null,
      len: prompt.length,
    };
    writeFileSync(join(stateDir, 'last_prompt.flag'), JSON.stringify(flag), 'utf-8');
    writeFileSync(join(stateDir, 'last_prompt.txt'), prompt, { encoding: 'utf-8', mode: 0o600 });
  } catch { /* ignore */ }
}

main().catch(() => process.exit(0));
