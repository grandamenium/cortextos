/**
 * hook-compact-outbound.ts — PreCompact hook.
 *
 * Sends a notification on the operator's remote channel when Claude
 * Code begins context compaction, so the user knows why the agent
 * goes quiet for a moment (#18). Renamed from
 * `hook-compact-telegram.ts` in PR2.
 *
 * This hook fires and returns immediately — it never blocks the
 * compaction. Registered in settings.json under the "PreCompact" event.
 *
 * Safety: fetch is raced against a 5s abort signal so this process
 * always exits well within the 10s settings.json timeout. A timed-out
 * or failed remote call must never abort compaction.
 *
 * PR2 keeps the raw-fetch Telegram path; PR5+ migrates to connector
 * dispatch via the standard connector interface.
 */

import { loadEnv } from './index.js';

export async function main(): Promise<void> {
  const env = loadEnv();

  if (!env.botToken || !env.chatId) return;

  const agentName = env.agentName || 'agent';

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

// Self-exec guard with argv[1] basename check — see hook-permission-request.ts
// for the Codex H1.cr rationale.
{
  // Exact basename match (Codex L1.crv) — see hook-permission-request.ts for rationale.
  const argv1 = process.argv[1] ?? '';
  const sep = Math.max(argv1.lastIndexOf('/'), argv1.lastIndexOf('\\'));
  const base = argv1.substring(sep + 1);
  if (base === 'hook-compact-outbound.js' || base === 'hook-compact-outbound.ts') {
    main().catch(() => process.exit(0));
  }
}
