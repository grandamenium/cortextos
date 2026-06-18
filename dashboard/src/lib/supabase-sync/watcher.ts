// Fleet box-side supabase-sync — the inverted watcher. This is the existing dashboard chokidar
// pattern flipped: instead of file-change -> SQLite write + SSE, it does file-change -> push to
// Supabase. Bursts are debounced into a single syncAll so a flurry of writes coalesces into one
// idempotent push. Runs on the box (server-side).
import { watch, type FSWatcher } from 'chokidar';
import path from 'path';
import { CTX_ROOT } from '../config';
import { syncAll } from './sync';

const DEBOUNCE_MS = 1500;

// M1 watch targets (heartbeats, crons, crash logs). Other sources join in later milestones.
function watchPaths(): string[] {
  return [
    path.join(CTX_ROOT, 'state', '*', 'heartbeat.json'),
    path.join(CTX_ROOT, 'state', '*', 'crons.json'),
    path.join(CTX_ROOT, 'logs', '*', 'crashes.log'),
  ];
}

export function startSyncWatcher(): FSWatcher {
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let again = false;

  const flush = async () => {
    if (running) { again = true; return; }
    running = true;
    try {
      const counts = await syncAll();
      console.log(`[supabase-sync] pushed`, counts);
    } catch (err) {
      console.error('[supabase-sync] push failed:', err instanceof Error ? err.message : err);
    } finally {
      running = false;
      if (again) { again = false; schedule(); }
    }
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, DEBOUNCE_MS);
  };

  const watcher = watch(watchPaths(), { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 } });
  watcher.on('add', schedule).on('change', schedule).on('unlink', schedule);
  console.log('[supabase-sync] watching box for changes (debounced push to Supabase)');
  return watcher;
}
