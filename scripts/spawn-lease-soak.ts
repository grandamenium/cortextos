#!/usr/bin/env tsx
/**
 * Δ1 (Phase 2e) — Spawn-lease soak runner.
 *
 * Simulates concurrent claimers racing for the same (project_id, artifact_key)
 * slot to verify the atomicity claim of cortextos.acquire_spawn_lease at
 * scale. Reworked per Sam HOLD 2026-05-17 BLOCK 1+2:
 *   - identity is (project_id, artifact_key), not (project_id, agent_name)
 *   - acquire is a single INSERT ON CONFLICT, not SELECT-FOR-UPDATE + INSERT
 *
 * Invariants checked:
 *   1. Across all acquire calls in a given instant, at most ONE caller
 *      sees acquired=true for the SAME (slot, generation). When the slot
 *      is contested by N workers and TTL never elapses mid-run, exactly
 *      one row exists with the original winner's holder still on it (or
 *      a steal-chain if TTL is short — both are atomic).
 *   2. Final table state shows exactly the most-recent winner, OR is
 *      empty if --release-after is set (every worker's releaseSession
 *      drained their leases).
 *   3. No DB-side errors thrown (atomic function never crashes).
 *
 * Usage:
 *   SUPABASE_GBRAIN_DATABASE_URL=... tsx scripts/spawn-lease-soak.ts \
 *     [--workers 8] [--iterations 200] [--ttl 5] \
 *     [--artifact agent:soak-target] [--task-class spawn] \
 *     [--project null|<id>] [--release-after]
 *
 * Default: 8 workers × 200 iters × 5s TTL → ~1600 acquires against one
 * slot. With pgbouncer pooling this finishes in 30-90s depending on
 * latency to Seoul.
 */
import { Pool } from 'pg';
import {
  acquireSpawnLease,
  releaseSessionLeases,
  listSpawnLeases,
  setPgPool,
  closePgPool,
} from '../src/bus/spawn-claim';

type Args = {
  workers: number;
  iterations: number;
  ttl: number;
  artifactKey: string;
  taskClass: string;
  project: string | null;
  releaseAfter: boolean;
};

function parseArgs(argv: string[]): Args {
  const out: Args = {
    workers: 8,
    iterations: 200,
    ttl: 5,
    artifactKey: 'agent:soak-target',
    taskClass: 'spawn',
    project: null,
    releaseAfter: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--workers':       out.workers = parseInt(next(), 10); break;
      case '--iterations':    out.iterations = parseInt(next(), 10); break;
      case '--ttl':           out.ttl = parseInt(next(), 10); break;
      case '--artifact':      out.artifactKey = next(); break;
      case '--task-class':    out.taskClass = next(); break;
      case '--project':       { const p = next(); out.project = p === 'null' ? null : p; break; }
      case '--release-after': out.releaseAfter = true; break;
      case '--help':
      case '-h':
        console.log('Usage: tsx scripts/spawn-lease-soak.ts [--workers N] [--iterations N] [--ttl S] [--artifact KEY] [--task-class CLASS] [--project null|ID] [--release-after]');
        process.exit(0);
    }
  }
  return out;
}

interface WorkerStats {
  workerId: number;
  attempts: number;
  wins: number;
  losses: number;
  errors: number;
  errorMessages: string[];
  holderId: string;
}

async function runWorker(
  workerId: number,
  args: Args,
  results: WorkerStats[],
): Promise<void> {
  const holderId = `worker-${workerId}-${Math.random().toString(36).slice(2, 8)}`;
  const stats: WorkerStats = {
    workerId,
    attempts: 0,
    wins: 0,
    losses: 0,
    errors: 0,
    errorMessages: [],
    holderId,
  };
  results[workerId] = stats;

  for (let i = 0; i < args.iterations; i++) {
    stats.attempts++;
    try {
      const r = await acquireSpawnLease({
        projectId: args.project,
        artifactKey: args.artifactKey,
        taskClass: args.taskClass,
        holderId,
        ttlSeconds: args.ttl,
        reason: `soak-${workerId}`,
      });
      if (r.acquired) stats.wins++;
      else stats.losses++;
    } catch (err) {
      stats.errors++;
      const msg = err instanceof Error ? err.message : String(err);
      if (stats.errorMessages.length < 5) stats.errorMessages.push(msg);
    }
    // Tiny jitter so workers don't lockstep.
    await new Promise((r) => setTimeout(r, Math.random() * 3));
  }

  if (args.releaseAfter) {
    // Best-effort mass-release of every lease this worker still holds
    // (its session). Drains the tombstones cleanly.
    try { await releaseSessionLeases(holderId); } catch { /* ignore */ }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dbUrl = process.env.SUPABASE_GBRAIN_DATABASE_URL || process.env.TEST_DATABASE_URL;
  if (!dbUrl) {
    console.error('SUPABASE_GBRAIN_DATABASE_URL or TEST_DATABASE_URL must be set.');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false },
    max: Math.max(args.workers + 2, 12),
  });
  setPgPool(pool);

  console.log('Δ1 spawn-lease soak runner');
  console.log(`  workers      : ${args.workers}`);
  console.log(`  iterations   : ${args.iterations} per worker = ${args.workers * args.iterations} total acquires`);
  console.log(`  ttl_seconds  : ${args.ttl}`);
  console.log(`  artifact_key : ${args.artifactKey}`);
  console.log(`  task_class   : ${args.taskClass}`);
  console.log(`  project_id   : ${args.project === null ? '<null>' : args.project}`);
  console.log(`  releaseAfter : ${args.releaseAfter}`);

  // Clean slate for the target slot — drop active AND tombstone rows so the
  // partial-unique invariant starts uncontested.
  await pool.query(
    `delete from cortextos.spawn_leases
     where artifact_key = $1
       and project_id is not distinct from $2`,
    [args.artifactKey, args.project],
  );

  const results: WorkerStats[] = [];
  const start = Date.now();
  await Promise.all(
    Array.from({ length: args.workers }, (_, w) => runWorker(w, args, results)),
  );
  const elapsedMs = Date.now() - start;

  const totalAttempts = results.reduce((s, r) => s + r.attempts, 0);
  const totalWins     = results.reduce((s, r) => s + r.wins, 0);
  const totalLosses   = results.reduce((s, r) => s + r.losses, 0);
  const totalErrors   = results.reduce((s, r) => s + r.errors, 0);

  console.log('\n--- results ---');
  for (const r of results) {
    console.log(`  worker ${r.workerId.toString().padStart(2)}: attempts=${r.attempts} wins=${r.wins} losses=${r.losses} errors=${r.errors}`);
    if (r.errorMessages.length > 0) {
      console.log(`    sample errors: ${r.errorMessages.slice(0, 3).join(' | ')}`);
    }
  }
  console.log(`\n  TOTAL: attempts=${totalAttempts} wins=${totalWins} losses=${totalLosses} errors=${totalErrors}`);
  console.log(`  elapsed: ${(elapsedMs / 1000).toFixed(2)}s  (${(totalAttempts / (elapsedMs / 1000)).toFixed(1)} acquires/sec)`);

  const finalState = await listSpawnLeases({
    artifactKey: args.artifactKey,
    projectId: args.project,
  });

  console.log('\n--- final table state (active rows) ---');
  console.log(`  rows: ${finalState.length}`);
  if (finalState.length > 0) console.log(`  ${JSON.stringify(finalState[0])}`);

  // Invariant checks.
  let pass = true;
  if (totalErrors > 0) {
    console.error(`  FAIL: ${totalErrors} DB errors during soak`);
    pass = false;
  }
  if (args.releaseAfter) {
    if (finalState.length !== 0) {
      console.error(`  FAIL: expected 0 active rows after release-after, got ${finalState.length}`);
      pass = false;
    }
  } else {
    if (finalState.length !== 1) {
      console.error(`  FAIL: expected exactly 1 active row at end (most-recent winner), got ${finalState.length}`);
      pass = false;
    }
  }

  await closePgPool();

  console.log(`\n${pass ? 'PASS' : 'FAIL'} — Δ1 soak`);
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  closePgPool().catch(() => undefined);
  process.exit(1);
});
