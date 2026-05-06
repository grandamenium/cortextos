/**
 * E2E process-exit tests for `cortextos bus send-telegram`.
 *
 * Verifies that the send-telegram command exits within 5 seconds in all cases:
 *   1. Healthy path  — Telegram succeeds, Supabase reachable, empty drain queue
 *   2. Outage path   — Telegram succeeds, Supabase unreachable, non-empty drain queue
 *   3. Drain-in-flight — Supabase unreachable + 50-entry retry queue (worst-case
 *      before the fix: 50 × 10s = 500s hang; after: exits in < 1s)
 *
 * Root cause being tested: drainRetryQueue() is triggered via setImmediate after
 * every successful Telegram send (through the rgos-mirror activity-event path).
 * Each pending drain entry holds an open fetch with a 10s AbortSignal timeout,
 * keeping the Node event loop alive until ALL entries are attempted. The fix adds
 * an explicit process.exit(0) in the send-telegram action handler so the process
 * exits as soon as all local writes (logOutboundMessage, cacheLastSent, logEvent
 * JSONL) are complete — before any setImmediate callbacks run.
 *
 * Strategy: spin up a local HTTP mock server for the Telegram API (pointed at
 * via TELEGRAM_API_BASE_URL), point SUPABASE_RGOS_URL at a non-routable RFC-5737
 * address (192.0.2.1) so every drain fetch attempt hangs, and assert the
 * subprocess exits within DEADLINE_MS regardless.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import { createServer, type Server } from 'http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLI_PATH = resolve(fileURLToPath(import.meta.url), '../../../../dist/cli.js');

/** Maximum ms the subprocess is allowed to run before the test fails. */
const DEADLINE_MS = 5_000;

/**
 * Non-routable IP from RFC 5737 test range — TCP SYN packets are dropped,
 * simulating an unreachable Supabase host. Fetch calls to this address will
 * hang until their AbortSignal fires (10s each in drainRetryQueue). Without
 * the fix, a queue of 50 entries would hold the event loop for up to 500s.
 */
const UNREACHABLE_HOST = 'http://192.0.2.1';

// ---------------------------------------------------------------------------
// Mock Telegram server
// ---------------------------------------------------------------------------

let mockServer: Server;
let mockPort: number;

/**
 * Minimal Telegram Bot API mock. Every POST returns { ok: true, result: { message_id: 1 } }
 * so send-telegram succeeds instantly regardless of the path or payload.
 */
beforeAll(
  () =>
    new Promise<void>((resolve, reject) => {
      mockServer = createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 123456789 } } }));
      });
      mockServer.listen(0, '127.0.0.1', () => {
        const addr = mockServer.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('Mock server failed to bind'));
          return;
        }
        mockPort = addr.port;
        resolve();
      });
      mockServer.on('error', reject);
    }),
  10_000,
);

afterAll(
  () =>
    new Promise<void>((resolve) => {
      mockServer.close(() => resolve());
    }),
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TempDir {
  ctxRoot: string;
  agentName: string;
  stateDir: string;
  cleanup: () => void;
}

function makeTempDir(): TempDir {
  const ctxRoot = mkdtempSync(join(tmpdir(), 'send-telegram-exit-'));
  const agentName = 'test-agent';
  const stateDir = join(ctxRoot, 'state', agentName);
  mkdirSync(stateDir, { recursive: true });
  // Also create the analytics events dir so logEvent doesn't throw
  mkdirSync(join(ctxRoot, 'analytics', 'events', agentName), { recursive: true });
  return {
    ctxRoot,
    agentName,
    stateDir,
    cleanup() {
      try {
        rmSync(ctxRoot, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

/** Build a JSONL retry-queue entry for an orch_tasks row. */
function makeRetryEntry(index: number): string {
  return JSON.stringify({
    table: 'orch_tasks',
    row: {
      id: `11111111-0000-5000-8000-${String(index).padStart(12, '0')}`,
      org_id: '00000000-0000-0000-0000-000000000001',
      title: `Stale task ${index}`,
      status: 'approved',
      priority: 'medium',
      assigned_to: 'dev',
      created_by: 'orchestrator',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      source: 'cortextos_bus_mirror',
    },
    ts: new Date().toISOString(),
  });
}

/**
 * Spawn `cortextos bus send-telegram` as a subprocess and wait for it to exit
 * or for DEADLINE_MS to elapse. Returns the exit code (0/1) or -1 on timeout.
 */
function runSendTelegram(
  env: Record<string, string | undefined>,
): Promise<{ exitCode: number; elapsed: number }> {
  return new Promise((resolve) => {
    const start = Date.now();

    const proc = spawn(
      process.execPath,
      [CLI_PATH, 'bus', 'send-telegram', '123456789', 'hello from test'],
      {
        env: {
          // Start with a clean slate — strip real credentials
          ...process.env,
          BOT_TOKEN: 'FAKE_TOKEN_FOR_TESTS',
          SUPABASE_RGOS_URL: undefined,
          SUPABASE_RGOS_SERVICE_KEY: undefined,
          BUS_RGOS_MIRROR_DISABLED: undefined,
          CTX_ROOT: undefined,
          CTX_AGENT_NAME: undefined,
          CTX_ORG: undefined,
          CTX_INSTANCE_ID: undefined,
          CTX_AGENT_DIR: undefined,
          ...env,
        },
        stdio: 'pipe',
      },
    );

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve({ exitCode: -1, elapsed: Date.now() - start });
    }, DEADLINE_MS);

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, elapsed: Date.now() - start });
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('send-telegram process exit', () => {
  /**
   * Baseline: mirror disabled, no drain queue. Should be the fastest path.
   */
  it('exits 0 within deadline — mirror disabled', async () => {
    const tmp = makeTempDir();
    try {
      const { exitCode, elapsed } = await runSendTelegram({
        TELEGRAM_API_BASE_URL: `http://127.0.0.1:${mockPort}`,
        BUS_RGOS_MIRROR_DISABLED: '1',
        CTX_ROOT: tmp.ctxRoot,
        CTX_AGENT_NAME: tmp.agentName,
        CTX_ORG: 'test-org',
        CTX_INSTANCE_ID: 'test-instance',
      });

      expect(exitCode, `process timed out or errored (elapsed ${elapsed}ms)`).toBe(0);
      expect(elapsed).toBeLessThan(DEADLINE_MS);
    } finally {
      tmp.cleanup();
    }
  });

  /**
   * Core regression: mirror ENABLED + Supabase unreachable + non-empty drain queue.
   * Before the fix, this would hang for (queue_size × 10s). After: exits in < 1s.
   */
  it('exits 0 within deadline — Supabase unreachable + 50-entry drain queue', async () => {
    const tmp = makeTempDir();
    try {
      // Pre-populate the retry queue with 50 stale entries. Without the fix,
      // the drain attempts each entry with a 10s AbortSignal → 500s hang.
      const queuePath = join(tmp.stateDir, 'mirror-retry.jsonl');
      const entries = Array.from({ length: 50 }, (_, i) => makeRetryEntry(i)).join('\n');
      writeFileSync(queuePath, entries + '\n', { encoding: 'utf-8', mode: 0o600 });

      const { exitCode, elapsed } = await runSendTelegram({
        TELEGRAM_API_BASE_URL: `http://127.0.0.1:${mockPort}`,
        SUPABASE_RGOS_URL: UNREACHABLE_HOST,
        SUPABASE_RGOS_SERVICE_KEY: 'fake-service-key',
        CTX_ROOT: tmp.ctxRoot,
        CTX_AGENT_NAME: tmp.agentName,
        CTX_ORG: 'test-org',
        CTX_INSTANCE_ID: 'test-instance',
      });

      expect(exitCode, `process timed out or errored (elapsed ${elapsed}ms)`).toBe(0);
      expect(elapsed).toBeLessThan(DEADLINE_MS);
    } finally {
      tmp.cleanup();
    }
  });

  /**
   * Healthy path: mirror enabled, Supabase reachable (mock), empty drain queue.
   */
  it('exits 0 within deadline — Supabase reachable, empty queue', async () => {
    const tmp = makeTempDir();
    try {
      const { exitCode, elapsed } = await runSendTelegram({
        TELEGRAM_API_BASE_URL: `http://127.0.0.1:${mockPort}`,
        // Point Supabase at the same local mock server — it'll return 200 for any request
        SUPABASE_RGOS_URL: `http://127.0.0.1:${mockPort}`,
        SUPABASE_RGOS_SERVICE_KEY: 'fake-service-key',
        CTX_ROOT: tmp.ctxRoot,
        CTX_AGENT_NAME: tmp.agentName,
        CTX_ORG: 'test-org',
        CTX_INSTANCE_ID: 'test-instance',
      });

      expect(exitCode, `process timed out or errored (elapsed ${elapsed}ms)`).toBe(0);
      expect(elapsed).toBeLessThan(DEADLINE_MS);
    } finally {
      tmp.cleanup();
    }
  });
});
