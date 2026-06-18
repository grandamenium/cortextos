// Fleet box-side supabase-sync — CLI entry. Runs on each customer box as a small long-lived
// process: one full sync up front, then watch + push on change. Server-side only; uses the scoped
// writer key from env.
//
//   SUPABASE_URL=... SUPABASE_SYNC_KEY=... node dist/lib/supabase-sync/run.js
//   (or via tsx in dev: npx tsx src/lib/supabase-sync/run.ts)
//
// `--once` does a single sync and exits (good for cron-driven syncs / CI).
import { isConfigured } from './client';
import { syncAll } from './sync';
import { startSyncWatcher } from './watcher';

async function main() {
  if (!isConfigured()) {
    console.error('[supabase-sync] not configured: set SUPABASE_URL + SUPABASE_SYNC_KEY (scoped writer, server-only). Supabase project pending.');
    process.exit(2);
  }
  const once = process.argv.includes('--once');
  try {
    const counts = await syncAll();
    console.log('[supabase-sync] initial sync:', counts);
  } catch (err) {
    console.error('[supabase-sync] initial sync failed:', err instanceof Error ? err.message : err);
    if (once) process.exit(1);
  }
  if (once) { process.exit(0); }

  const watcher = startSyncWatcher();
  const shutdown = async () => { await watcher.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
