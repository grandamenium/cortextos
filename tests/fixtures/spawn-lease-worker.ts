#!/usr/bin/env tsx
/**
 * Cross-process worker for tests/integration/daemon-spawn-lease-cross-process.test.ts.
 *
 * Each worker simulates one daemon racing on a (project_id, artifact_key)
 * slot. Distinct process = distinct pg Pool = distinct holder_id = cross-host
 * lock semantics test.
 *
 * Wire protocol (parent → worker via stdin lines):
 *   ACQUIRE                   acquire the lease (single-shot at boot)
 *   RENEW                     renew the lease
 *   RELEASE                   mass-release via releaseSessionLeases(holder)
 *   EXIT                      close pool + exit 0
 *
 * Reply protocol (worker → parent via stdout JSON lines, one per command):
 *   {kind:"acquire", acquired:bool, lease_id:number, holder_id:string, ...}
 *   {kind:"renew", renewed:bool, expires_at?:string}
 *   {kind:"release", count:number}
 *
 * Args (positional):
 *   --artifact <key>          required
 *   --holder   <id>           required (caller-chosen, e.g. test-process-A)
 *   --project  <id|null>      required (literal string 'null' for unscoped)
 *   --ttl      <seconds>      default 30
 *   --reason   <text>         default null
 */
import { createInterface } from 'readline';
import { Pool } from 'pg';
import {
  acquireSpawnLease,
  renewSpawnLease,
  releaseSessionLeases,
  closePgPool,
  setPgPool,
} from '../../src/bus/spawn-claim';

interface Args {
  artifact: string;
  holder: string;
  project: string | null;
  ttl: number;
  reason: string | null;
}

function parseArgs(argv: string[]): Args {
  let artifact = '';
  let holder = '';
  let project: string | null = null;
  let ttl = 30;
  let reason: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--artifact') artifact = next();
    else if (a === '--holder') holder = next();
    else if (a === '--project') { const p = next(); project = p === 'null' ? null : p; }
    else if (a === '--ttl') ttl = parseInt(next(), 10);
    else if (a === '--reason') reason = next();
  }
  if (!artifact || !holder) {
    console.error('spawn-lease-worker: --artifact and --holder are required');
    process.exit(2);
  }
  return { artifact, holder, project, ttl, reason };
}

function send(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let currentLeaseId: number | null = null;

  // Cap this worker's pg pool at max=2 connections. The worker only ever
  // has a single command in flight at a time, so 2 conns is plenty. The
  // default getPgPool() opens up to 10 — when multiple integration test
  // files run in parallel against Seoul Supabase, the aggregate connection
  // count saturates the upstream pooler and acquires/releases fail with
  // generic connection errors. Capping per-worker keeps the test envelope
  // bounded.
  // Accept both env var names — parent gates on
  // `SUPABASE_GBRAIN_DATABASE_URL || TEST_DATABASE_URL` (see
  // daemon-spawn-lease-cross-process.test.ts:22-27). Without the second
  // fallback here, a worker spawned in a TEST_DATABASE_URL-only environment
  // would silently take the default getPgPool() path and ignore the test DB
  // routing the parent set up. Surfaced by Sam HOLD verdict 2026-05-17.
  const connStr =
    process.env.SUPABASE_GBRAIN_DATABASE_URL ||
    process.env.TEST_DATABASE_URL;
  if (connStr) {
    const insecure = process.env.PGSSL_NO_VERIFY === '1';
    // PGSSL_DISABLE=1 — vanilla pg in CI has no TLS at all; relaxed-cert
    // still attempts handshake. Symmetric to spawn-claim.ts production path.
    const disableSsl = process.env.PGSSL_DISABLE === '1';
    setPgPool(new Pool({
      connectionString: connStr,
      max: 2,
      idleTimeoutMillis: 5_000,
      ssl: disableSsl ? false : insecure ? { rejectUnauthorized: false } : { rejectUnauthorized: true },
    }));
  }

  const rl = createInterface({ input: process.stdin });
  rl.on('line', async (raw) => {
    const cmd = raw.trim();
    try {
      if (cmd === 'ACQUIRE') {
        const r = await acquireSpawnLease({
          projectId: args.project,
          artifactKey: args.artifact,
          taskClass: 'spawn',
          holderId: args.holder,
          ttlSeconds: args.ttl,
          reason: args.reason,
        });
        if (r.acquired) currentLeaseId = r.lease.id;
        send({
          kind: 'acquire',
          acquired: r.acquired,
          lease_id: r.lease.id,
          holder_id: r.lease.holder_id,
          held_by: r.lease.holder_id,
          expires_at: r.lease.expires_at,
          project_id: r.lease.project_id,
          artifact_key: r.lease.artifact_key,
        });
      } else if (cmd === 'RENEW') {
        if (currentLeaseId === null) {
          send({ kind: 'renew', renewed: false, error: 'no_lease' });
          return;
        }
        const r = await renewSpawnLease(currentLeaseId, args.holder, args.ttl);
        send({
          kind: 'renew',
          renewed: r !== null,
          expires_at: r?.expires_at,
        });
      } else if (cmd === 'RELEASE') {
        const n = await releaseSessionLeases(args.holder);
        currentLeaseId = null;
        send({ kind: 'release', count: n });
      } else if (cmd === 'EXIT') {
        await closePgPool().catch(() => undefined);
        process.exit(0);
      }
    } catch (err) {
      send({
        kind: 'error',
        cmd,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // Worker is ready — parent waits for this before sending the first command.
  send({ kind: 'ready', pid: process.pid, holder: args.holder });
}

main().catch((err) => {
  console.error('spawn-lease-worker fatal:', err);
  closePgPool().catch(() => undefined).finally(() => process.exit(1));
});
