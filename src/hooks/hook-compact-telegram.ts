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

  // Customer-box noise suppression (2026-06-18, Bode-direct): the "context compacting" notice is system noise
  // the customer should not see — it reads as a redeploy/quiet blip (this is part of the broader noise Jordan/P&S
  // was getting). On a CUSTOMER box, route to the OPERATOR channel if configured, else SUPPRESS — never send to
  // the customer's CHAT_ID. On an operator/internal box (CTX_IS_CUSTOMER_BOX unset), CHAT_ID is the operator → unchanged.
  let sendToken = env.botToken;
  let sendChat = env.chatId;
  if (process.env.CTX_IS_CUSTOMER_BOX === '1') {
    const opChat = process.env.OPERATOR_CHAT_ID;
    if (opChat) {
      sendToken = process.env.OPERATOR_BOT_TOKEN || env.botToken;
      sendChat = opChat;
    } else {
      return; // fail-closed: no operator channel → suppress (customer never sees compaction internals)
    }
  }

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
