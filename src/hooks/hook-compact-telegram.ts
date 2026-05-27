/**
 * hook-compact-telegram.ts — PreCompact hook.
 * Sends a Telegram notification when Claude Code begins context compaction,
 * so the user knows why the agent goes quiet for a moment (#18).
 *
 * This hook fires and returns immediately — it never blocks the compaction.
 * Registered in settings.json under the "PreCompact" event.
 *
 * Safety: fetch is raced against a 5s abort signal so this process always
 * exits well within the 10s settings.json timeout. A timed-out or failed
 * Telegram call must never abort compaction.
 */

import { mkdirSync, appendFileSync } from 'fs';
import { loadEnv } from './index.js';

async function main(): Promise<void> {
  const env = loadEnv();

  const agentName = env.agentName || 'agent';

  // F15: record this compaction event so the daemon can detect compaction loops.
  // Written before the Telegram call so it lands even if the network is slow.
  try {
    mkdirSync(env.stateDir, { recursive: true });
    appendFileSync(
      `${env.stateDir}/compaction-events.jsonl`,
      JSON.stringify({ ts: Date.now() }) + '\n',
    );
  } catch {
    // Never block compaction on a failed write
  }

  if (!env.botToken || !env.chatId) return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    const url = `https://api.telegram.org/bot${env.botToken}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.chatId,
        text: `[${agentName}] Context compacting... resuming shortly`,
      }),
      signal: controller.signal,
    });
  } catch {
    // Never fail — compaction must not be blocked
  } finally {
    clearTimeout(timer);
  }
}

main().catch(() => process.exit(0));
