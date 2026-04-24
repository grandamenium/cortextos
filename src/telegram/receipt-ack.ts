/**
 * Receipt acknowledgement for inbound user Telegram messages.
 *
 * Called immediately after an update passes the allowed-user gate, before any
 * media download, dedup check, or PTY injection. The user sees 👍 and a
 * `typing…` indicator within ~1 second of sending — long before the agent
 * finishes processing.
 *
 * Both Telegram calls are fire-and-forget: a failure here must never block
 * message delivery. Errors are logged and swallowed.
 *
 * Per-message dedup: Telegram may redeliver an update if the downstream
 * handler throws (see TelegramPoller.pollOnce). Without a local guard we
 * would react on every redelivery — wasteful API calls and log noise.
 * The `ackedMessageIds` set is caller-owned so it persists across poll
 * cycles for the same bot; we bound its size at 1000 entries (FIFO-ish)
 * to prevent unbounded memory growth on a long-running daemon.
 */

import type { TelegramAPI } from './api.js';

type LogFn = (msg: string) => void;

const MAX_ACKED_IDS = 1000;
const TRIM_TARGET = 900;

export function ackTelegramReceipt(
  api: TelegramAPI | undefined,
  chatId: string | number | undefined,
  messageId: number | undefined,
  ackedMessageIds: Set<number>,
  log: LogFn,
): void {
  if (!api || chatId === undefined || chatId === '' || !messageId) return;
  if (ackedMessageIds.has(messageId)) return;

  ackedMessageIds.add(messageId);
  // Bounded cleanup: Set iteration order is insertion order, so dropping the
  // oldest N entries keeps the most recent message_ids ack-guarded.
  if (ackedMessageIds.size > MAX_ACKED_IDS) {
    const toDrop = ackedMessageIds.size - TRIM_TARGET;
    const iter = ackedMessageIds.values();
    for (let i = 0; i < toDrop; i++) {
      const next = iter.next();
      if (next.done) break;
      ackedMessageIds.delete(next.value);
    }
  }

  api.setMessageReaction(chatId, messageId, '👍').catch((err) => {
    log(`setMessageReaction failed for msg ${messageId}: ${err}`);
  });
  api.sendChatAction(chatId, 'typing').catch(() => {
    // sendChatAction is best-effort; indicator auto-expires ~5s so a miss
    // is visually harmless.
  });
}
