import type { BackendId, WorkerAdapter } from './base.js';
import { claudeAdapter } from './adapters/claude.js';
import { codexAdapter } from './adapters/codex.js';
import { geminiAdapter } from './adapters/gemini.js';

/**
 * Factory: BackendId → WorkerAdapter.
 *
 * Mirrors the shape of `loadAdapter()` in src/pty/adapters/base.ts:22 — a flat
 * switch on the id that returns a singleton adapter, throwing on an unknown id.
 * Deliberately separate from `loadAdapter()`: VendorAdapter (PTY, lifetime
 * process, no health/result) and WorkerAdapter (headless, single-task,
 * health-gated) are distinct interfaces.
 */
export function loadWorkerAdapter(id: BackendId): WorkerAdapter {
  switch (id) {
    case 'claude':
      return claudeAdapter;
    case 'codex':
      return codexAdapter;
    case 'gemini':
      return geminiAdapter;
    default:
      throw new Error(
        `Unknown Hermes backend: '${id as string}'. Supported backends: 'claude', 'codex', 'gemini'.`
      );
  }
}
