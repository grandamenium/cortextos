import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { Pool } from 'pg';
import { join } from 'path';
import { existsSync } from 'fs';

/**
 * Δ1 (Phase 2e) cross-process spawn-lease test — validates the cortextos.
 * spawn_leases atomic-acquire invariant across two distinct OS processes
 * (distinct pg Pools, distinct PIDs, distinct holder ids) racing against
 * the same Seoul Supabase Postgres row.
 *
 * This is the contract the daemon spawn-path wire-up depends on: if two
 * daemons start the same agent simultaneously, exactly one wins; the other
 * sees the winner's holder_id in the lease row and aborts cleanly.
 *
 * Why a separate test from spawn-lease.test.ts: that suite covers in-process
 * concurrency (multiple Promise.all() acquires on one Pool). This one
 * proves the contract holds when each "daemon" has its own pg connection +
 * its own PID, which is the actual production shape.
 *
 * Gate: SUPABASE_GBRAIN_DATABASE_URL (or TEST_DATABASE_URL) must be set.
 */

const DB_URL =
  process.env.SUPABASE_GBRAIN_DATABASE_URL || process.env.TEST_DATABASE_URL;
const HAS_DB = !!DB_URL;
const describeIfDb = HAS_DB ? describe : describe.skip;

// Resolve tsx binary inside the worktree's node_modules. Cwd-independent so
// the test works regardless of the directory vitest was invoked from.
const TSX_BIN = join(__dirname, '..', '..', 'node_modules', '.bin', 'tsx');
const WORKER_PATH = join(__dirname, '..', 'fixtures', 'spawn-lease-worker.ts');

interface WorkerHandle {
  child: ChildProcessWithoutNullStreams;
  send(cmd: string): Promise<Record<string, unknown>>;
  shutdown(): Promise<void>;
}

/**
 * Spawn a child process with the lease worker. Each command sent via send()
 * resolves with the next JSON line on stdout — the worker emits exactly one
 * reply per command.
 */
function spawnWorker(args: string[]): Promise<WorkerHandle> {
  return new Promise((resolveOuter, rejectOuter) => {
    const child = spawn(TSX_BIN, [WORKER_PATH, ...args], {
      // PGSSL_NO_VERIFY=1: Seoul Supabase serves a self-signed cert in its
      // chain that node-postgres' default verified TLS path rejects. The
      // in-process tests use setPgPool() to inject a relaxed pool; the
      // cross-process worker takes the standard getPgPool() path, so we
      // pass the env-flag escape hatch here. Same posture as the
      // in-process tests — production daemons run with verified TLS.
      env: { ...process.env, PGSSL_NO_VERIFY: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let buf = '';
    const pending: Array<(reply: Record<string, unknown>) => void> = [];
    let ready = false;

    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(line); }
        catch { continue; }
        if (parsed.kind === 'ready' && !ready) {
          ready = true;
          resolveOuter({
            child,
            send(cmd: string): Promise<Record<string, unknown>> {
              return new Promise((resolveCmd, rejectCmd) => {
                pending.push((reply) => {
                  // Surface worker-side errors as rejections instead of
                  // letting them silently resolve to {kind:"error",...} and
                  // fail downstream assertions as "expected false to be
                  // true" with no context.
                  if (reply.kind === 'error') {
                    rejectCmd(new Error(
                      `worker error on ${String(reply.cmd ?? cmd)}: ${String(reply.message ?? 'unknown')}`,
                    ));
                  } else {
                    resolveCmd(reply);
                  }
                });
                child.stdin.write(cmd + '\n');
              });
            },
            async shutdown(): Promise<void> {
              return new Promise((resolveExit) => {
                child.once('exit', () => resolveExit());
                try { child.stdin.write('EXIT\n'); } catch { /* ignore */ }
                setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 3000);
              });
            },
          });
          continue;
        }
        const next = pending.shift();
        if (next) next(parsed);
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      // Surface child stderr to vitest output so a worker crash is visible.
      process.stderr.write(`[lease-worker stderr] ${chunk.toString('utf8')}`);
    });

    child.on('error', (err) => rejectOuter(err));
    child.on('exit', (code) => {
      if (!ready) rejectOuter(new Error(`worker exited before ready (code ${code})`));
    });
  });
}

describeIfDb('daemon spawn-lease — cross-process atomicity', { timeout: 60_000 }, () => {
  let auditPool: Pool;
  // Per-test artifact key so test 1's release status can't shadow test 2's
  // slot under parallel-test load. The describe-shared timestamp + pid keeps
  // separate CI runs from colliding; the per-test suffix isolates within the
  // same run.
  const runScope = `${Date.now()}-${process.pid}`;
  let artifactKey: string;
  let testCounter = 0;

  beforeAll(async () => {
    if (!existsSync(TSX_BIN)) {
      throw new Error(`tsx binary not found at ${TSX_BIN} — run npm install`);
    }
    if (!existsSync(WORKER_PATH)) {
      throw new Error(`worker script not found at ${WORKER_PATH}`);
    }
    auditPool = new Pool({
      connectionString: DB_URL,
      ssl: { rejectUnauthorized: false },
      max: 2,
    });
  });

  beforeEach(async () => {
    testCounter += 1;
    artifactKey = `agent:test-cross-${runScope}-t${testCounter}`;
    // Clean slate for THIS test's slot — guarantees independence regardless
    // of whether a prior test's RELEASE landed cleanly.
    await auditPool.query(
      'delete from cortextos.spawn_leases where artifact_key = $1',
      [artifactKey],
    );
  });

  afterAll(async () => {
    // Tombstone everything the suite created so subsequent runs start clean.
    await auditPool.query(
      "delete from cortextos.spawn_leases where artifact_key like $1",
      [`agent:test-cross-${runScope}-%`],
    );
    await auditPool.end();
  });

  it('two daemons racing on the same artifact: exactly one wins, the loser sees the winner\'s holder', async () => {
    const holderA = `daemon-spawn:test-instance-A:${process.pid}-${Date.now()}`;
    const holderB = `daemon-spawn:test-instance-B:${process.pid}-${Date.now()}`;

    const [workerA, workerB] = await Promise.all([
      spawnWorker(['--artifact', artifactKey, '--holder', holderA, '--project', '1evo', '--ttl', '30']),
      spawnWorker(['--artifact', artifactKey, '--holder', holderB, '--project', '1evo', '--ttl', '30']),
    ]);

    try {
      // Fire both ACQUIREs concurrently. The partial unique on
      // (project_id, artifact_key) WHERE released_at IS NULL serializes
      // them at the index — exactly one wins.
      const [replyA, replyB] = await Promise.all([
        workerA.send('ACQUIRE'),
        workerB.send('ACQUIRE'),
      ]);

      expect(replyA.kind).toBe('acquire');
      expect(replyB.kind).toBe('acquire');
      const winners = [replyA, replyB].filter((r) => r.acquired === true);
      const losers  = [replyA, replyB].filter((r) => r.acquired === false);
      expect(winners.length).toBe(1);
      expect(losers.length).toBe(1);

      const winner = winners[0];
      const loser  = losers[0];

      // Loser must see the WINNER's holder id in the lease row.
      expect(loser.held_by).toBe(winner.holder_id);

      // Audit: exactly one active row in the table for this artifact.
      const { rows: active } = await auditPool.query(
        'select holder_id from cortextos.spawn_leases where artifact_key = $1 and released_at is null',
        [artifactKey],
      );
      expect(active.length).toBe(1);
      expect(active[0].holder_id).toBe(winner.holder_id);
    } finally {
      // Always release + exit both workers so the slot is clean for the
      // re-acquire test below.
      await Promise.all([
        workerA.send('RELEASE').catch(() => undefined),
        workerB.send('RELEASE').catch(() => undefined),
      ]);
      await Promise.all([workerA.shutdown(), workerB.shutdown()]);
    }
  });

  it('renew from the holder slides expires_at; release frees the slot for re-acquire by a new process', async () => {
    const holderA = `daemon-spawn:test-renew-A:${Date.now()}`;
    const holderB = `daemon-spawn:test-renew-B:${Date.now()}`;

    const workerA = await spawnWorker(['--artifact', artifactKey, '--holder', holderA, '--project', '1evo', '--ttl', '60']);
    try {
      const acquire1 = await workerA.send('ACQUIRE');
      expect(acquire1.acquired).toBe(true);
      const firstExpiry = String(acquire1.expires_at);

      // Sleep just long enough that the timestamp can advance, then renew.
      await new Promise((r) => setTimeout(r, 1100));
      const renew1 = await workerA.send('RENEW');
      expect(renew1.renewed).toBe(true);
      expect(String(renew1.expires_at)).not.toBe(firstExpiry);

      // Now release. The slot should be free for a NEW process to acquire.
      const release1 = await workerA.send('RELEASE');
      expect((release1.count as number) >= 1).toBe(true);

      // Confirm via audit Pool: no active row.
      const { rows: midState } = await auditPool.query(
        'select id from cortextos.spawn_leases where artifact_key = $1 and released_at is null',
        [artifactKey],
      );
      expect(midState.length).toBe(0);
    } finally {
      await workerA.shutdown();
    }

    // Fresh process (distinct PID, distinct pg Pool) acquires the slot post-release.
    const workerB = await spawnWorker(['--artifact', artifactKey, '--holder', holderB, '--project', '1evo', '--ttl', '30']);
    try {
      const acquire2 = await workerB.send('ACQUIRE');
      expect(acquire2.acquired).toBe(true);
      expect(acquire2.holder_id).toBe(holderB);

      // Audit: exactly one active row, holder is B.
      const { rows: postState } = await auditPool.query(
        'select holder_id from cortextos.spawn_leases where artifact_key = $1 and released_at is null',
        [artifactKey],
      );
      expect(postState.length).toBe(1);
      expect(postState[0].holder_id).toBe(holderB);

      await workerB.send('RELEASE');
    } finally {
      await workerB.shutdown();
    }
  });
});
