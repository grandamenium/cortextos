import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import {
  acquireSpawnLease,
  releaseSpawnLease,
  heartbeatSpawnLease,
  listSpawnLeases,
  expireSpawnLeases,
  setPgPool,
  closePgPool,
} from '../../src/bus/spawn-claim';

/**
 * Δ1 (Phase 2e) integration tests — exercise the real cortextos.spawn_leases
 * table via the SQL functions in migration 0003.
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
      max: 5,
    });
    setPgPool(pool);
  });

  afterAll(async () => {
    setPgPool(null);
    await pool.end();
    await closePgPool().catch(() => undefined);
  });

  beforeEach(async () => {
    await pool.query('truncate cortextos.spawn_leases');
  });

  describe('acquire', () => {
    it('first acquire on empty slot wins and sets expires_at to now + ttl', async () => {
      const result = await acquireSpawnLease(null, 'alpha', 'holder-A', 60, 'first');
      expect(result.acquired).toBe(true);
      expect(result.lease.holder_id).toBe('holder-A');
      expect(result.lease.project_id).toBeNull();
      expect(result.lease.agent_name).toBe('alpha');
      expect(result.lease.ttl_seconds).toBe(60);
      expect(result.lease.reason).toBe('first');

      // expires_at ≈ acquired_at + 60s
      const acquired = new Date(result.lease.acquired_at).getTime();
      const expires = new Date(result.lease.expires_at).getTime();
      expect(expires - acquired).toBeCloseTo(60_000, -3);
    });

    it('different holder on live lease loses; returns existing row unchanged', async () => {
      const first = await acquireSpawnLease(null, 'alpha', 'holder-A', 60);
      const second = await acquireSpawnLease(null, 'alpha', 'holder-B', 60);

      expect(second.acquired).toBe(false);
      expect(second.lease.holder_id).toBe('holder-A');
      expect(second.lease.expires_at).toBe(first.lease.expires_at);
      expect(second.lease.acquired_at).toBe(first.lease.acquired_at);
    });

    it('same holder re-acquire slides expires_at forward but keeps acquired_at', async () => {
      const first = await acquireSpawnLease(null, 'alpha', 'holder-A', 60);
      await new Promise((r) => setTimeout(r, 50)); // ensure clock moves
      const second = await acquireSpawnLease(null, 'alpha', 'holder-A', 120, 'refresh');

      expect(second.acquired).toBe(true);
      expect(second.lease.holder_id).toBe('holder-A');
      expect(second.lease.acquired_at).toBe(first.lease.acquired_at); // sticky
      expect(new Date(second.lease.expires_at).getTime())
        .toBeGreaterThan(new Date(first.lease.expires_at).getTime());
      expect(second.lease.ttl_seconds).toBe(120);
      expect(second.lease.reason).toBe('refresh');
    });

    it('expired lease is stealable by a different holder', async () => {
      // Acquire with 1s TTL, wait it out.
      await acquireSpawnLease(null, 'alpha', 'holder-A', 1, 'short');
      await new Promise((r) => setTimeout(r, 1100));

      const stolen = await acquireSpawnLease(null, 'alpha', 'holder-B', 60, 'steal');
      expect(stolen.acquired).toBe(true);
      expect(stolen.lease.holder_id).toBe('holder-B');
    });

    it('different project_id is a distinct partition (no conflict)', async () => {
      const a = await acquireSpawnLease(null, 'alpha', 'holder-A', 60);
      const b = await acquireSpawnLease('1evo', 'alpha', 'holder-B', 60);
      expect(a.acquired).toBe(true);
      expect(b.acquired).toBe(true);
      expect(a.lease.project_id).toBeNull();
      expect(b.lease.project_id).toBe('1evo');
    });

    it('rejects empty agent_name', async () => {
      await expect(acquireSpawnLease(null, '', 'holder-A', 60))
        .rejects.toThrow(/agent_name/);
    });

    it('rejects empty holder_id', async () => {
      await expect(acquireSpawnLease(null, 'alpha', '', 60))
        .rejects.toThrow(/holder_id/);
    });

    it('rejects non-positive ttl_seconds', async () => {
      await expect(acquireSpawnLease(null, 'alpha', 'holder-A', 0))
        .rejects.toThrow(/ttl_seconds must be positive/);
      await expect(acquireSpawnLease(null, 'alpha', 'holder-A', -5))
        .rejects.toThrow(/ttl_seconds must be positive/);
    });
  });

  describe('release', () => {
    it('current holder can release (true)', async () => {
      await acquireSpawnLease(null, 'alpha', 'holder-A', 60);
      const released = await releaseSpawnLease(null, 'alpha', 'holder-A');
      expect(released).toBe(true);

      const list = await listSpawnLeases({ agentName: 'alpha' });
      expect(list).toHaveLength(0);
    });

    it('non-holder cannot release (false)', async () => {
      await acquireSpawnLease(null, 'alpha', 'holder-A', 60);
      const released = await releaseSpawnLease(null, 'alpha', 'holder-B');
      expect(released).toBe(false);

      const list = await listSpawnLeases({ agentName: 'alpha' });
      expect(list).toHaveLength(1); // still held by A
    });

    it('second release by same holder is false (idempotent)', async () => {
      await acquireSpawnLease(null, 'alpha', 'holder-A', 60);
      await releaseSpawnLease(null, 'alpha', 'holder-A');
      const second = await releaseSpawnLease(null, 'alpha', 'holder-A');
      expect(second).toBe(false);
    });

    it('release on never-acquired slot is false', async () => {
      const released = await releaseSpawnLease(null, 'nope', 'holder-X');
      expect(released).toBe(false);
    });

    it('different project_id partitions release independently', async () => {
      await acquireSpawnLease(null, 'alpha', 'holder-A', 60);
      await acquireSpawnLease('1evo', 'alpha', 'holder-A', 60);

      const a = await releaseSpawnLease(null, 'alpha', 'holder-A');
      expect(a).toBe(true);

      const list = await listSpawnLeases({ agentName: 'alpha' });
      expect(list).toHaveLength(1);
      expect(list[0].project_id).toBe('1evo');
    });
  });

  describe('heartbeat', () => {
    it('current holder can extend (returns refreshed lease)', async () => {
      const first = await acquireSpawnLease(null, 'alpha', 'holder-A', 60);
      await new Promise((r) => setTimeout(r, 50));
      const hb = await heartbeatSpawnLease(null, 'alpha', 'holder-A', 120);

      expect(hb).not.toBeNull();
      expect(hb!.holder_id).toBe('holder-A');
      expect(hb!.ttl_seconds).toBe(120);
      expect(new Date(hb!.expires_at).getTime())
        .toBeGreaterThan(new Date(first.lease.expires_at).getTime());
      // acquired_at sticky across heartbeats
      expect(hb!.acquired_at).toBe(first.lease.acquired_at);
    });

    it('non-holder heartbeat returns null', async () => {
      await acquireSpawnLease(null, 'alpha', 'holder-A', 60);
      const hb = await heartbeatSpawnLease(null, 'alpha', 'holder-B', 60);
      expect(hb).toBeNull();
    });

    it('expired lease heartbeat returns null even for original holder', async () => {
      await acquireSpawnLease(null, 'alpha', 'holder-A', 1);
      await new Promise((r) => setTimeout(r, 1100));
      const hb = await heartbeatSpawnLease(null, 'alpha', 'holder-A', 60);
      expect(hb).toBeNull();
    });

    it('heartbeat on absent slot returns null', async () => {
      const hb = await heartbeatSpawnLease(null, 'nope', 'holder-X', 60);
      expect(hb).toBeNull();
    });
  });

  describe('list', () => {
    it('returns empty when table empty', async () => {
      const list = await listSpawnLeases();
      expect(list).toHaveLength(0);
    });

    it('returns all rows when no filter', async () => {
      await acquireSpawnLease(null, 'alpha', 'holder-A', 60);
      await acquireSpawnLease('1evo', 'beta', 'holder-B', 60);
      const list = await listSpawnLeases();
      expect(list).toHaveLength(2);
    });

    it('filters by agent_name', async () => {
      await acquireSpawnLease(null, 'alpha', 'holder-A', 60);
      await acquireSpawnLease(null, 'beta', 'holder-B', 60);
      const list = await listSpawnLeases({ agentName: 'alpha' });
      expect(list).toHaveLength(1);
      expect(list[0].agent_name).toBe('alpha');
    });

    it('filters by project_id (string)', async () => {
      await acquireSpawnLease(null, 'alpha', 'holder-A', 60);
      await acquireSpawnLease('1evo', 'alpha', 'holder-B', 60);
      const list = await listSpawnLeases({ projectId: '1evo' });
      expect(list).toHaveLength(1);
      expect(list[0].project_id).toBe('1evo');
    });

    it('filters by project_id NULL slot explicitly', async () => {
      await acquireSpawnLease(null, 'alpha', 'holder-A', 60);
      await acquireSpawnLease('1evo', 'alpha', 'holder-B', 60);
      const list = await listSpawnLeases({ projectId: null });
      expect(list).toHaveLength(1);
      expect(list[0].project_id).toBeNull();
    });

    it('sorts NULLS first, then by agent_name', async () => {
      await acquireSpawnLease('xena', 'agent-z', 'h', 60);
      await acquireSpawnLease(null, 'agent-y', 'h', 60);
      await acquireSpawnLease(null, 'agent-x', 'h', 60);
      await acquireSpawnLease('apple', 'agent-w', 'h', 60);

      const list = await listSpawnLeases();
      expect(list.map((l) => [l.project_id, l.agent_name])).toEqual([
        [null, 'agent-x'],
        [null, 'agent-y'],
        ['apple', 'agent-w'],
        ['xena', 'agent-z'],
      ]);
    });
  });

  describe('expire', () => {
    it('returns 0 when no expired rows', async () => {
      await acquireSpawnLease(null, 'alpha', 'holder-A', 60);
      const purged = await expireSpawnLeases();
      expect(purged).toBe(0);

      const list = await listSpawnLeases();
      expect(list).toHaveLength(1); // still alive
    });

    it('purges only the rows where expires_at <= now()', async () => {
      await acquireSpawnLease(null, 'alpha', 'holder-A', 1);
      await acquireSpawnLease(null, 'beta', 'holder-B', 600);
      await new Promise((r) => setTimeout(r, 1100));

      const purged = await expireSpawnLeases();
      expect(purged).toBe(1);

      const list = await listSpawnLeases();
      expect(list).toHaveLength(1);
      expect(list[0].agent_name).toBe('beta');
    });
  });
});
