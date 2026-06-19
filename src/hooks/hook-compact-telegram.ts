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

import { loadEnv } from './index.js';

async function main(): Promise<void> {
  const env = loadEnv();

  if (!env.botToken || !env.chatId) return;

  const agentName = env.agentName || 'agent';

  // Compaction notice = internal housekeeping noise. Bode-direct 2026-06-19 ("I want to stop getting these"):
  // it must NEVER go to the primary user/CHAT_ID — on a customer box it reads as a redeploy blip to the customer,
  // and on the operator box Bode does not want it either (sage compacts many times/day = a steady spam stream).
  // The 2026-06-18 fix only suppressed the customer case; the operator/internal case still spammed CHAT_ID.
  // New rule (uniform across all boxes): send ONLY to a dedicated OPERATOR_CHAT_ID if explicitly configured
  // (a separate low-noise ops channel); otherwise SUPPRESS entirely. Default = nobody gets compaction pings.
  const opChat = process.env.OPERATOR_CHAT_ID;
  if (!opChat) return; // no dedicated ops channel → suppress (the default; primary CHAT_ID is never used)
  const sendToken = process.env.OPERATOR_BOT_TOKEN || env.botToken;
  if (!sendToken) return;
  const sendChat = opChat;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    const url = `https://api.telegram.org/bot${sendToken}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: sendChat,
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
