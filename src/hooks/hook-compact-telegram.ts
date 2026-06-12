/**
 * hook-compact-telegram.ts — PreCompact hook.
 * Records each context-compaction event so the daemon can detect compaction
 * loops (F15). It does NOT notify the user: routine compaction is internal
 * housekeeping, and per-compaction Telegram pings are noise — especially under
 * cron-driven context growth on idle agents and during restart waves, where a
 * single operation can fire many compactions (user feedback, 2026-06-11). Real
 * problems (compaction loops) are surfaced by the daemon reading the jsonl
 * below, not by this hook.
 *
 * This hook fires and returns immediately — it never blocks the compaction.
 * Registered in settings.json under the "PreCompact" event.
 */

import { mkdirSync, appendFileSync } from 'fs';
import { loadEnv } from './index.js';

async function main(): Promise<void> {
  const env = loadEnv();

  // F15: record this compaction event so the daemon can detect compaction loops.
  try {
    mkdirSync(env.stateDir, { recursive: true });
    appendFileSync(
      `${env.stateDir}/compaction-events.jsonl`,
      JSON.stringify({ ts: Date.now() }) + '\n',
    );
  } catch {
    // Never block compaction on a failed write
  }
}

main().catch(() => process.exit(0));
