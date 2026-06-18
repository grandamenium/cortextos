// Fleet box-side supabase-sync — the inverted watcher. This is the existing dashboard chokidar
// pattern flipped: instead of file-change -> SQLite write + SSE, it does file-change -> push to
// Supabase. Bursts are debounced into a single syncAll so a flurry of writes coalesces into one
// idempotent push. Runs on the box (server-side).
import { watch, type FSWatcher } from 'chokidar';
import fs from 'fs';
import path from 'path';
import { CTX_ROOT, CTX_FRAMEWORK_ROOT } from '../config';
import { syncAll } from './sync';

const DEBOUNCE_MS = 1500;

// chokidar@5 removed glob support — globs are treated as literal paths and never match.
// Expand to concrete parent dirs instead. syncAll() re-reads all sources on any trigger,
// so watching parent dirs (fires on any child change) is correct + glob-free.
function watchPaths(): string[] {
  const paths: string[] = [
    // state/ covers: heartbeat.json, crons.json, agent.pid, .invalid_runtime_error, etc.
    path.join(CTX_ROOT, 'state'),
    // logs/ covers: crashes.log and all per-agent log dirs.
    path.join(CTX_ROOT, 'logs'),
  ];
  // Enumerate existing org/agent dirs so config.json changes (runtime edits) trigger
  // an immediate sync. New agents added post-startup are covered by the state/ watch
  // (their heartbeat.json appears there first). Best-effort — missing dirs are skipped.
  try {
    const orgsDir = path.join(CTX_FRAMEWORK_ROOT, 'orgs');
    if (fs.existsSync(orgsDir)) {
      for (const entry of fs.readdirSync(orgsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const agentsDir = path.join(orgsDir, entry.name, 'agents');
        if (fs.existsSync(agentsDir)) {
          paths.push(agentsDir);
        }
      }
    }
  } catch { /* state/ + logs/ always watched; agent dirs are best-effort */ }
  return paths;
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
