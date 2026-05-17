// cortextOS Dashboard - Chokidar file watcher singleton
// Monitors CTX_ROOT for JSON/JSONL changes, syncs to SQLite, emits SSE events.

import { EventEmitter } from 'events';
import { watch, type FSWatcher } from 'chokidar';
import path from 'path';
import { CTX_ROOT, getOrgs } from './config';
import { syncFile, syncAll } from './sync';
import type { SSEEvent } from './types';

// ---------------------------------------------------------------------------
// globalThis singleton pattern (survives Next.js hot reloads)
// ---------------------------------------------------------------------------

const globalForWatcher = globalThis as unknown as {
  __cortextos_emitter: EventEmitter | undefined;
  __cortextos_watcher: FSWatcher | undefined;
};

export const emitter: EventEmitter =
  globalForWatcher.__cortextos_emitter ?? new EventEmitter();
emitter.setMaxListeners(100); // support many concurrent SSE clients

if (process.env.NODE_ENV !== 'production') {
  globalForWatcher.__cortextos_emitter = emitter;
}

// ---------------------------------------------------------------------------
// Watch path builder
// ---------------------------------------------------------------------------

function getWatchPaths(): string[] {
  const paths: string[] = [];
  const orgs = getOrgs();

  for (const org of orgs) {
    const orgBase = path.join(CTX_ROOT, 'orgs', org);
    paths.push(path.join(orgBase, 'tasks', '**', '*.json'));
    paths.push(path.join(orgBase, 'approvals', '**', '*.json'));
    paths.push(path.join(orgBase, 'analytics', 'events', '**', '*.jsonl'));
  }

  // Flat paths (not org-scoped)
  paths.push(path.join(CTX_ROOT, 'state', '*', 'heartbeat.json'));
  paths.push(path.join(CTX_ROOT, 'inbox', '**', '*.json'));

  return paths;
}

// ---------------------------------------------------------------------------
// File change handler
// ---------------------------------------------------------------------------

function categorizeFilePath(filePath: string): SSEEvent['type'] {
  if (filePath.includes('/tasks/')) return 'task';
  if (filePath.includes('/approvals/')) return 'approval';
  if (filePath.includes('/heartbeat.json')) return 'heartbeat';
  if (filePath.includes('/analytics/events/')) return 'event';
  return 'sync';
}

function handleFileChange(
  filePath: string,
  changeType: 'change' | 'add' | 'remove',
): void {
  console.log(`[watcher] ${changeType}: ${filePath}`);

  // Sync the changed file to SQLite (skip for deletions)
  if (changeType !== 'remove') {
    void syncFile(filePath).catch((err) => {
      console.error(`[watcher] Sync failed for ${filePath}:`, err);
    });
  }

  // Emit SSE event
  const sseEvent: SSEEvent = {
    type: categorizeFilePath(filePath),
    data: { filePath, changeType },
    timestamp: new Date().toISOString(),
  };

  emitter.emit('sse', sseEvent);
}

// ---------------------------------------------------------------------------
// Watcher factory
// ---------------------------------------------------------------------------

function createWatcher(): FSWatcher {
  const watchPaths = getWatchPaths();

  if (watchPaths.length === 0) {
    console.warn(
      '[watcher] No paths to watch - CTX_ROOT may not have any orgs yet',
    );
  }

  const watcher = watch(watchPaths, {
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100,
    },
  });

  watcher.on('add', (fp) => handleFileChange(fp, 'add'));
  watcher.on('change', (fp) => handleFileChange(fp, 'change'));
  watcher.on('unlink', (fp) => handleFileChange(fp, 'remove'));
  watcher.on('error', (error) => console.error('[watcher] Error:', error));

  console.log(
    `[watcher] Watching ${watchPaths.length} patterns under ${CTX_ROOT}`,
  );
  return watcher;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the file watcher singleton.
 * Runs a full sync on first call, then starts watching for incremental changes.
 */
export function initWatcher(): FSWatcher {
  if (globalForWatcher.__cortextos_watcher) {
    return globalForWatcher.__cortextos_watcher;
  }

  console.log('[watcher] Running initial full sync...');
  syncAll();

  const watcher = createWatcher();

  if (process.env.NODE_ENV !== 'production') {
    globalForWatcher.__cortextos_watcher = watcher;
  }

  return watcher;
}

/**
 * Gracefully close the watcher.
 */
export function stopWatcher(): void {
  if (globalForWatcher.__cortextos_watcher) {
    globalForWatcher.__cortextos_watcher.close();
    globalForWatcher.__cortextos_watcher = undefined;
  }
}

/**
 * Subscribe to SSE events. Returns an unsubscribe function.
 */
export function onSSEEvent(
  handler: (event: SSEEvent) => void,
): () => void {
  emitter.on('sse', handler);
  return () => emitter.off('sse', handler);
}

// Graceful shutdown on process exit
if (typeof process !== 'undefined') {
  const shutdown = () => {
    stopWatcher();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
