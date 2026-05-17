import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import {
  acquireSpawnLease,
  releaseSpawnLease,
  renewSpawnLease,
  releaseSessionLeases,
  listSpawnLeases,
  expireSpawnLeases,
  setPgPool,
  closePgPool,
} from '../../src/bus/spawn-claim';

/**
 * Δ1 (Phase 2e) integration tests — exercise the real cortextos.spawn_leases
 * table via the SQL functions in migration 0003. Reworked per Sam HOLD verdict
 * 2026-05-17: identity is now (project_id, artifact_key); renew/release by
 * surrogate lease_id; released rows are soft-delete tombstones.
 *
 * Gate: TEST_DATABASE_URL or SUPABASE_GBRAIN_DATABASE_URL must be set. CI
 * without a configured Postgres skips the whole suite. Local dev points at
 * Seoul (TRUNCATEs between tests so there is no cross-run pollution).
 *
 * NOTE: this suite ASSUMES the cortextos schema migrations (0001-0003) have
 * already been applied to the target DB. Run `supabase db push` first.
 */

const dbUrl = process.env.TEST_DATABASE_URL || process.env.SUPABASE_GBRAIN_DATABASE_URL;

describe.skipIf(!dbUrl)('Δ1 spawn-lease integration', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({
      connectionString: dbUrl!,
      ssl: { rejectUnauthorized: false },
      max: 20,
    });
    setPgPool(pool);
  });

  afterAll(async () => {
    setPgPool(null);
    await pool.end();
    await closePgPool().catch(() => undefined);
  });

  beforeEach(async () => {
    await pool.query('truncate cortextos.spawn_leases restart identity');
  });

  describe('acquire', () => {
    it('first acquire on empty slot wins and stamps expires_at to now + ttl', async () => {
      const result = await acquireSpawnLease({
        projectId: null,
        artifactKey: 'agent:alpha',
        taskClass: 'spawn',
        holderId: 'holder-A',
        ttlSeconds: 60,
        reason: 'first',
      });
      expect(result.acquired).toBe(true);
      expect(result.lease.holder_id).toBe('holder-A');
      expect(result.lease.project_id).toBeNull();
      expect(result.lease.artifact_key).toBe('agent:alpha');
      expect(result.lease.task_class).toBe('spawn');
      expect(result.lease.ttl_seconds).toBe(60);
      expect(result.lease.reason).toBe('first');
      expect(result.lease.released_at).toBeNull();
      expect(result.lease.id).toBeGreaterThan(0);

      // expires_at ≈ acquired_at + 60s
      const acquired = new Date(result.lease.acquired_at).getTime();
      const expires = new Date(result.lease.expires_at).getTime();
      expect(expires - acquired).toBeCloseTo(60_000, -3);
    });

    it('different holder on live lease loses; returned row is the live holder', async () => {
      const first = await acquireSpawnLease({
        projectId: null, artifactKey: 'agent:alpha', taskClass: 'spawn',
        holderId: 'holder-A', ttlSeconds: 60,
      });
      const second = await acquireSpawnLease({
        projectId: null, artifactKey: 'agent:alpha', taskClass: 'spawn',
        holderId: 'holder-B', ttlSeconds: 60,
      });

      expect(second.acquired).toBe(false);
      expect(second.lease.holder_id).toBe('holder-A');
      expect(second.lease.id).toBe(first.lease.id);
      expect(second.lease.expires_at).toBe(first.lease.expires_at);
      expect(second.lease.acquired_at).toBe(first.lease.acquired_at);
    });

    it('same holder re-acquire slides expires_at forward but keeps acquired_at sticky', async () => {
      const first = await acquireSpawnLease({
        projectId: null, artifactKey: 'agent:alpha', taskClass: 'spawn',
        holderId: 'holder-A', ttlSeconds: 60,
      });
      await new Promise((r) => setTimeout(r, 50)); // ensure clock moves
      const second = await acquireSpawnLease({
        projectId: null, artifactKey: 'agent:alpha', taskClass: 'spawn',
        holderId: 'holder-A', ttlSeconds: 120, reason: 'refresh',
      });

      expect(second.acquired).toBe(true);
      expect(second.lease.id).toBe(first.lease.id);
      expect(second.lease.holder_id).toBe('holder-A');
      expect(second.lease.acquired_at).toBe(first.lease.acquired_at); // sticky
      expect(new Date(second.lease.expires_at).getTime())
        .toBeGreaterThan(new Date(first.lease.expires_at).getTime());
      expect(second.lease.ttl_seconds).toBe(120);
      expect(second.lease.reason).toBe('refresh');
    });

    it('expired live lease is stealable by a different holder (same row id)', async () => {
      const original = await acquireSpawnLease({
        projectId: null, artifactKey: 'agent:alpha', taskClass: 'spawn',
        holderId: 'holder-A', ttlSeconds: 1, reason: 'short',
      });
      await new Promise((r) => setTimeout(r, 1100));

      const stolen = await acquireSpawnLease({
        projectId: null, artifactKey: 'agent:alpha', taskClass: 'spawn',
        holderId: 'holder-B', ttlSeconds: 60, reason: 'steal',
      });
      expect(stolen.acquired).toBe(true);
      expect(stolen.lease.id).toBe(original.lease.id); // never released → same row
      expect(stolen.lease.holder_id).toBe('holder-B');
      expect(stolen.lease.reason).toBe('steal');
    });

    it('released slot can be re-acquired (new row, partial-unique tombstone drops out)', async () => {
      const first = await acquireSpawnLease({
        projectId: null, artifactKey: 'agent:alpha', taskClass: 'spawn',
        holderId: 'holder-A', ttlSeconds: 60,
      });
      await releaseSpawnLease(first.lease.id, 'holder-A');

      const second = await acquireSpawnLease({
        projectId: null, artifactKey: 'agent:alpha', taskClass: 'spawn',
        holderId: 'holder-B', ttlSeconds: 60,
      });
      expect(second.acquired).toBe(true);
      expect(second.lease.id).not.toBe(first.lease.id); // fresh row, tombstone still on disk
      expect(second.lease.holder_id).toBe('holder-B');
    });

    it('different artifact_key is a distinct slot (no conflict)', async () => {
      const a = await acquireSpawnLease({
        projectId: null, artifactKey: 'agent:alpha', taskClass: 'spawn',
        holderId: 'holder-A', ttlSeconds: 60,
      });
      const b = await acquireSpawnLease({
        projectId: null, artifactKey: 'agent:beta', taskClass: 'spawn',
        holderId: 'holder-A', ttlSeconds: 60,
      });
      expect(a.acquired).toBe(true);
      expect(b.acquired).toBe(true);
      expect(b.lease.id).not.toBe(a.lease.id);
    });

    it('different project_id is a distinct slot for same artifact_key', async () => {
      const a = await acquireSpawnLease({
        projectId: null, artifactKey: 'file:/x.ts', taskClass: 'refactor',
        holderId: 'holder-A', ttlSeconds: 60,
      });
      const b = await acquireSpawnLease({
        projectId: '1evo', artifactKey: 'file:/x.ts', taskClass: 'refactor',
        holderId: 'holder-B', ttlSeconds: 60,
      });
      expect(a.acquired).toBe(true);
      expect(b.acquired).toBe(true);
      expect(a.lease.project_id).toBeNull();
      expect(b.lease.project_id).toBe('1evo');
    });

    it('rejects empty artifact_key', async () => {
      await expect(acquireSpawnLease({
        projectId: null, artifactKey: '', taskClass: 'spawn',
        holderId: 'holder-A', ttlSeconds: 60,
      })).rejects.toThrow(/artifact_key/);
    });

    it('rejects empty task_class', async () => {
      await expect(acquireSpawnLease({
        projectId: null, artifactKey: 'agent:alpha', taskClass: '',
        holderId: 'holder-A', ttlSeconds: 60,
      })).rejects.toThrow(/task_class/);
    });

    it('rejects empty holder_id', async () => {
      await expect(acquireSpawnLease({
        projectId: null, artifactKey: 'agent:alpha', taskClass: 'spawn',
        holderId: '', ttlSeconds: 60,
      })).rejects.toThrow(/holder_id/);
    });

    it('rejects non-positive ttl_seconds', async () => {
      await expect(acquireSpawnLease({
        projectId: null, artifactKey: 'agent:alpha', taskClass: 'spawn',
        holderId: 'holder-A', ttlSeconds: 0,
      })).rejects.toThrow(/ttl_seconds must be positive/);
      await expect(acquireSpawnLease({
        projectId: null, artifactKey: 'agent:alpha', taskClass: 'spawn',
        holderId: 'holder-A', ttlSeconds: -5,
      })).rejects.toThrow(/ttl_seconds must be positive/);
    });
  });

  describe('concurrent first-acquire (Sam BLOCK 2 verification)', () => {
    it('race N callers against a fresh slot → exactly one wins, zero errors', async () => {
      const N = 24;
      const calls = Array.from({ length: N }, (_, i) =>
        acquireSpawnLease({
          projectId: null,
          artifactKey: 'agent:race',
          taskClass: 'spawn',
          holderId: `holder-${i}`,
          ttlSeconds: 60,
        }),
      );
      const results = await Promise.all(calls);
      const winners = results.filter((r) => r.acquired);
      const losers = results.filter((r) => !r.acquired);

      // Atomicity invariant: exactly one INSERT survives the partial-unique
      // conflict serialization. Losers all see the same winning row.
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(N - 1);

      const winningRowId = winners[0].lease.id;
      for (const loser of losers) {
        expect(loser.lease.id).toBe(winningRowId);
        expect(loser.lease.holder_id).toBe(winners[0].lease.holder_id);
      }

      // And only one active row in the table.
      const list = await listSpawnLeases({ artifactKey: 'agent:race' });
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(winningRowId);
    });
  });

  describe('release (by lease_id)', () => {
    it('current holder can release (true) — row becomes tombstone, drops out of active list', async () => {
      const acq = await acquireSpawnLease({
        projectId: null, artifactKey: 'agent:alpha', taskClass: 'spawn',
        holderId: 'holder-A', ttlSeconds: 60,
      });
      const released = await releaseSpawnLease(acq.lease.id, 'holder-A');
      expect(released).toBe(true);

      const active = await listSpawnLeases({ artifactKey: 'agent:alpha' });
      expect(active).toHaveLength(0);

      const all = await listSpawnLeases({ artifactKey: 'agent:alpha', state: 'all' });
      expect(all).toHaveLength(1);
      expect(all[0].released_at).not.toBeNull();
    });

    it('non-holder cannot release (false)', async () => {
      const acq = await acquireSpawnLease({
        projectId: null, artifactKey: 'agent:alpha', taskClass: 'spawn',
        holderId: 'holder-A', ttlSeconds: 60,
      });
      const released = await releaseSpawnLease(acq.lease.id, 'holder-B');
      expect(released).toBe(false);

      const list = await listSpawnLeases({ artifactKey: 'agent:alpha' });
      expect(list).toHaveLength(1); // still active under A
    });

    it('second release by same holder is false (idempotent)', async () => {
      const acq = await acquireSpawnLease({
        projectId: null, artifactKey: 'agent:alpha', taskClass: 'spawn',
        holderId: 'holder-A', ttlSeconds: 60,
      });
      await releaseSpawnLease(acq.lease.id, 'holder-A');
      const second = await releaseSpawnLease(acq.lease.id, 'holder-A');
      expect(second).toBe(false);
    });

    it('release on never-existed lease_id is false', async () => {
      const released = await releaseSpawnLease(999_999_999, 'holder-X');
      expect(released).toBe(false);
    });
  });

  describe('release-session (mass-release by holder_id)', () => {
    it('drains every active lease for the holder; returns count', async () => {
      await acquireSpawnLease({
        projectId: null, artifactKey: 'agent:a1', taskClass: 'spawn',
        holderId: 'session-1', ttlSeconds: 60,
      });
      await acquireSpawnLease({
        projectId: null, artifactKey: 'agent:a2', taskClass: 'spawn',
        holderId: 'session-1', ttlSeconds: 60,
      });
      await acquireSpawnLease({
        projectId: null, artifactKey: 'agent:a3', taskClass: 'spawn',
        holderId: 'session-2', ttlSeconds: 60,
      });

      const count = await releaseSessionLeases('session-1');
      expect(count).toBe(2);

      const remaining = await listSpawnLeases();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].holder_id).toBe('session-2');
    });

    it('returns 0 for unknown holder', async () => {
      const count = await releaseSessionLeases('does-not-exist');
      expect(count).toBe(0);
    });

    it('idempotent — second call on same holder returns 0', async () => {
      await acquireSpawnLease({
        projectId: null, artifactKey: 'agent:a', taskClass: 'spawn',
        holderId: 'session-1', ttlSeconds: 60,
      });
      const first = await releaseSessionLeases('session-1');
      const second = await releaseSessionLeases('session-1');
      expect(first).toBe(1);
      expect(second).toBe(0);
    });
  });

  describe('renew (by lease_id)', () => {
    it('current holder can renew → returns refreshed lease, expires_at moved forward', async () => {
      const acq = await acquireSpawnLease({
        projectId: null, artifactKey: 'agent:alpha', taskClass: 'spawn',
        holderId: 'holder-A', ttlSeconds: 60,
      });
      await new Promise((r) => setTimeout(r, 50));
      const hb = await renewSpawnLease(acq.lease.id, 'holder-A', 120);

      expect(hb).not.toBeNull();
      expect(hb!.id).toBe(acq.lease.id);
      expect(hb!.holder_id).toBe('holder-A');
      expect(hb!.ttl_seconds).toBe(120);
      expect(new Date(hb!.expires_at).getTime())
        .toBeGreaterThan(new Date(acq.lease.expires_at).getTime());
      expect(hb!.acquired_at).toBe(acq.lease.acquired_at); // sticky
    });

    it('non-holder renew returns null', async () => {
      const acq = await acquireSpawnLease({
        projectId: null, artifactKey: 'agent:alpha', taskClass: 'spawn',
        holderId: 'holder-A', ttlSeconds: 60,
      });
      const hb = await renewSpawnLease(acq.lease.id, 'holder-B', 60);
      expect(hb).toBeNull();
    });

    it('expired lease renew returns null even for original holder', async () => {
      const acq = await acquireSpawnLease({
        projectId: null, artifactKey: 'agent:alpha', taskClass: 'spawn',
        holderId: 'holder-A', ttlSeconds: 1,
      });
      await new Promise((r) => setTimeout(r, 1100));
      const hb = await renewSpawnLease(acq.lease.id, 'holder-A', 60);
      expect(hb).toBeNull();
    });

    it('renew on absent lease_id returns null', async () => {
      const hb = await renewSpawnLease(999_999_999, 'holder-X', 60);
      expect(hb).toBeNull();
    });

    it('renew on released (tombstone) lease returns null', async () => {
      const acq = await acquireSpawnLease({
        projectId: null, artifactKey: 'agent:alpha', taskClass: 'spawn',
        holderId: 'holder-A', ttlSeconds: 60,
      });
      await releaseSpawnLease(acq.lease.id, 'holder-A');
      const hb = await renewSpawnLease(acq.lease.id, 'holder-A', 60);
      expect(hb).toBeNull();
    });
  });

  describe('list', () => {
    it('returns empty when table empty', async () => {
      const list = await listSpawnLeases();
      expect(list).toHaveLength(0);
    });

    it('returns active rows by default', async () => {
      await acquireSpawnLease({
        projectId: null, artifactKey: 'agent:alpha', taskClass: 'spawn',
        holderId: 'holder-A', ttlSeconds: 60,
      });
      await acquireSpawnLease({
        projectId: '1evo', artifactKey: 'agent:beta', taskClass: 'spawn',
        holderId: 'holder-B', ttlSeconds: 60,
      });
      const list = await listSpawnLeases();
      expect(list).toHaveLength(2);
    });

    it('state=released returns only tombstones', async () => {
      const a = await acquireSpawnLease({
        projectId: null, artifactKey: 'agent:alpha', taskClass: 'spawn',
        holderId: 'holder-A', ttlSeconds: 60,
      });
      await acquireSpawnLease({
        projectId: null, artifactKey: 'agent:beta', taskClass: 'spawn',
        holderId: 'holder-B', ttlSeconds: 60,
      });
      await releaseSpawnLease(a.lease.id, 'holder-A');

      const released = await listSpawnLeases({ state: 'released' });
      expect(released).toHaveLength(1);
      expect(released[0].artifact_key).toBe('agent:alpha');
      expect(released[0].released_at).not.toBeNull();
    });

    it('state=all returns both active and tombstones', async () => {
      const a = await acquireSpawnLease({
        projectId: null, artifactKey: 'agent:alpha', taskClass: 'spawn',
        holderId: 'holder-A', ttlSeconds: 60,
      });
      await acquireSpawnLease({
        projectId: null, artifactKey: 'agent:beta', taskClass: 'spawn',
        holderId: 'holder-B', ttlSeconds: 60,
      });
      await releaseSpawnLease(a.lease.id, 'holder-A');

      const all = await listSpawnLeases({ state: 'all' });
      expect(all).toHaveLength(2);
    });

    it('filters by artifact_key', async () => {
      await acquireSpawnLease({
        projectId: null, artifactKey: 'agent:alpha', taskClass: 'spawn',
        holderId: 'h', ttlSeconds: 60,
      });
      await acquireSpawnLease({
        projectId: null, artifactKey: 'agent:beta', taskClass: 'spawn',
        holderId: 'h', ttlSeconds: 60,
      });
      const list = await listSpawnLeases({ artifactKey: 'agent:alpha' });
      expect(list).toHaveLength(1);
      expect(list[0].artifact_key).toBe('agent:alpha');
    });

    it('filters by task_class', async () => {
      await acquireSpawnLease({
        projectId: null, artifactKey: 'kb:slug-a', taskClass: 'ingest',
        holderId: 'h', ttlSeconds: 60,
      });
      await acquireSpawnLease({
        projectId: null, artifactKey: 'agent:alpha', taskClass: 'spawn',
        holderId: 'h', ttlSeconds: 60,
      });
      const list = await listSpawnLeases({ taskClass: 'ingest' });
      expect(list).toHaveLength(1);
      expect(list[0].task_class).toBe('ingest');
    });

    it('filters by holder_id', async () => {
      await acquireSpawnLease({
        projectId: null, artifactKey: 'agent:alpha', taskClass: 'spawn',
        holderId: 'session-1', ttlSeconds: 60,
      });
      await acquireSpawnLease({
        projectId: null, artifactKey: 'agent:beta', taskClass: 'spawn',
        holderId: 'session-2', ttlSeconds: 60,
      });
      const list = await listSpawnLeases({ holderId: 'session-1' });
      expect(list).toHaveLength(1);
      expect(list[0].holder_id).toBe('session-1');
    });

    it('filters by project_id (string)', async () => {
      await acquireSpawnLease({
        projectId: null, artifactKey: 'agent:alpha', taskClass: 'spawn',
        holderId: 'h', ttlSeconds: 60,
      });
      await acquireSpawnLease({
        projectId: '1evo', artifactKey: 'agent:alpha', taskClass: 'spawn',
        holderId: 'h', ttlSeconds: 60,
      });
      const list = await listSpawnLeases({ projectId: '1evo' });
      expect(list).toHaveLength(1);
      expect(list[0].project_id).toBe('1evo');
    });

    it('filters by project_id NULL slot explicitly', async () => {
      await acquireSpawnLease({
        projectId: null, artifactKey: 'agent:alpha', taskClass: 'spawn',
        holderId: 'h', ttlSeconds: 60,
      });
      await acquireSpawnLease({
        projectId: '1evo', artifactKey: 'agent:alpha', taskClass: 'spawn',
        holderId: 'h', ttlSeconds: 60,
      });
      const list = await listSpawnLeases({ projectId: null });
      expect(list).toHaveLength(1);
      expect(list[0].project_id).toBeNull();
    });

    it('sorts NULLS first, then by artifact_key', async () => {
      await acquireSpawnLease({
        projectId: 'xena', artifactKey: 'art-z', taskClass: 'spawn',
        holderId: 'h', ttlSeconds: 60,
      });
      await acquireSpawnLease({
        projectId: null, artifactKey: 'art-y', taskClass: 'spawn',
        holderId: 'h', ttlSeconds: 60,
      });
      await acquireSpawnLease({
        projectId: null, artifactKey: 'art-x', taskClass: 'spawn',
        holderId: 'h', ttlSeconds: 60,
      });
      await acquireSpawnLease({
        projectId: 'apple', artifactKey: 'art-w', taskClass: 'spawn',
        holderId: 'h', ttlSeconds: 60,
      });

      const list = await listSpawnLeases();
      expect(list.map((l) => [l.project_id, l.artifact_key])).toEqual([
        [null, 'art-x'],
        [null, 'art-y'],
        ['apple', 'art-w'],
        ['xena', 'art-z'],
      ]);
    });
  });

  describe('expire', () => {
    it('returns 0 when nothing is old enough to purge', async () => {
      await acquireSpawnLease({
        projectId: null, artifactKey: 'agent:alpha', taskClass: 'spawn',
        holderId: 'holder-A', ttlSeconds: 60,
      });
      const purged = await expireSpawnLeases();
      expect(purged).toBe(0);

      const list = await listSpawnLeases();
      expect(list).toHaveLength(1); // still active
    });

    it('does NOT purge live rows whose TTL has elapsed — acquire steal handles those', async () => {
      // 1s TTL, wait it out: row is still live (just expired), released_at IS NULL.
      // expire_spawn_leases only purges stale-expired rows >24h past expiry.
      await acquireSpawnLease({
        projectId: null, artifactKey: 'agent:alpha', taskClass: 'spawn',
        holderId: 'holder-A', ttlSeconds: 1,
      });
      await new Promise((r) => setTimeout(r, 1100));
      const purged = await expireSpawnLeases();
      expect(purged).toBe(0);

      const all = await listSpawnLeases({ state: 'all' });
      expect(all).toHaveLength(1);
    });

    it('purges tombstones older than 24h', async () => {
      // Insert a fake old tombstone directly. The expire sweeper only purges
      // tombstones older than 24h, so we backdate released_at to 25h ago.
      const acq = await acquireSpawnLease({
        projectId: null, artifactKey: 'agent:alpha', taskClass: 'spawn',
        holderId: 'holder-A', ttlSeconds: 60,
      });
      await releaseSpawnLease(acq.lease.id, 'holder-A');
      await pool.query(
        `update cortextos.spawn_leases set released_at = now() - interval '25 hours' where id = $1`,
        [acq.lease.id],
      );

      const purged = await expireSpawnLeases();
      expect(purged).toBe(1);

      const all = await listSpawnLeases({ state: 'all' });
      expect(all).toHaveLength(0);
    });

    it('purges stale-expired-never-released rows older than 24h past expiry', async () => {
      const acq = await acquireSpawnLease({
        projectId: null, artifactKey: 'agent:zombie', taskClass: 'spawn',
        holderId: 'holder-A', ttlSeconds: 60,
      });
      // Backdate expires_at to 25h ago and leave released_at NULL.
      await pool.query(
        `update cortextos.spawn_leases
            set expires_at = now() - interval '25 hours'
          where id = $1`,
        [acq.lease.id],
      );

      const purged = await expireSpawnLeases();
      expect(purged).toBe(1);
    });
  });
});
