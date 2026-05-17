import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SpawnLeaseCoordinator, type LeaseEventName, type LeaseEventSeverity } from '../../../src/daemon/spawn-lease-coordinator';

/**
 * Unit tests for SpawnLeaseCoordinator. Covers behavior that does NOT need
 * a live Postgres connection: enable/disable gating, event emission shape,
 * holder id construction, fail-open semantics on acquire/renew throws,
 * timer cleanup on release.
 *
 * Cross-process atomicity is covered in
 * tests/integration/daemon-spawn-lease-cross-process.test.ts.
 */

const MOCK_LEASE = {
  id: 42,
  project_id: '1evo',
  artifact_key: 'agent:test',
  task_class: 'spawn',
  holder_id: 'daemon-spawn:inst-A:test',
  acquired_at: '2026-05-17T00:00:00Z',
  expires_at: '2026-05-17T00:30:00Z',
  ttl_seconds: 1800,
  reason: 'daemon-spawn:inst-A',
  released_at: null,
  created_at: '2026-05-17T00:00:00Z',
  updated_at: '2026-05-17T00:00:00Z',
};

const acquireMock = vi.fn();
const renewMock = vi.fn();
const releaseSessionMock = vi.fn();

vi.mock('../../../src/bus/spawn-claim.js', () => ({
  acquireSpawnLease: (...args: unknown[]) => acquireMock(...args),
  renewSpawnLease: (...args: unknown[]) => renewMock(...args),
  releaseSessionLeases: (...args: unknown[]) => releaseSessionMock(...args),
}));

interface EmittedEvent {
  agent: string;
  name: LeaseEventName;
  severity: LeaseEventSeverity;
  meta: Record<string, unknown>;
  projectId: string | null;
}

function makeCoordinator(ttl = 30, renewMs = 100): { coord: SpawnLeaseCoordinator; events: EmittedEvent[] } {
  const events: EmittedEvent[] = [];
  const coord = new SpawnLeaseCoordinator(
    'inst-A',
    (agent, name, severity, meta, projectId) => {
      events.push({ agent, name, severity, meta, projectId });
    },
    ttl,
    renewMs,
  );
  return { coord, events };
}

describe('SpawnLeaseCoordinator', () => {
  let originalDbUrl: string | undefined;

  beforeEach(() => {
    acquireMock.mockReset();
    renewMock.mockReset();
    releaseSessionMock.mockReset();
    originalDbUrl = process.env.SUPABASE_GBRAIN_DATABASE_URL;
    process.env.SUPABASE_GBRAIN_DATABASE_URL = 'postgres://mock';
  });

  afterEach(() => {
    if (originalDbUrl === undefined) delete process.env.SUPABASE_GBRAIN_DATABASE_URL;
    else process.env.SUPABASE_GBRAIN_DATABASE_URL = originalDbUrl;
  });

  describe('enable gating', () => {
    it('isEnabled() returns false when SUPABASE_GBRAIN_DATABASE_URL is unset', () => {
      delete process.env.SUPABASE_GBRAIN_DATABASE_URL;
      const { coord } = makeCoordinator();
      expect(coord.isEnabled()).toBe(false);
    });

    it('acquireAgentSpawn returns acquired=true as a no-op when disabled', async () => {
      delete process.env.SUPABASE_GBRAIN_DATABASE_URL;
      const { coord, events } = makeCoordinator();
      const r = await coord.acquireAgentSpawn('vid-g', '1evo');
      expect(r.acquired).toBe(true);
      expect(r.lease).toBeNull();
      expect(r.holderId).toBe('daemon-spawn:inst-A:vid-g');
      expect(acquireMock).not.toHaveBeenCalled();
      expect(events).toEqual([]);
    });

    it('isEnabled() returns true when SUPABASE_GBRAIN_DATABASE_URL is set', () => {
      const { coord } = makeCoordinator();
      expect(coord.isEnabled()).toBe(true);
    });
  });

  describe('acquire — success path', () => {
    it('emits spawn_lease_acquired info on win + populates registry', async () => {
      acquireMock.mockResolvedValueOnce({ acquired: true, lease: MOCK_LEASE });
      const { coord, events } = makeCoordinator();

      const r = await coord.acquireAgentSpawn('vid-g', '1evo');

      expect(r.acquired).toBe(true);
      expect(r.lease).toEqual(MOCK_LEASE);
      expect(r.holderId).toBe('daemon-spawn:inst-A:vid-g');
      expect(coord.size()).toBe(1);
      expect(coord.getHolderId('vid-g')).toBe('daemon-spawn:inst-A:vid-g');
      expect(coord.getLeaseId('vid-g')).toBe(42);

      expect(events).toHaveLength(1);
      expect(events[0].name).toBe('spawn_lease_acquired');
      expect(events[0].severity).toBe('info');
      expect(events[0].projectId).toBe('1evo');
      expect(events[0].meta).toMatchObject({
        lease_id: 42,
        artifact: 'agent:vid-g',
        holder: 'daemon-spawn:inst-A:vid-g',
        ttl_seconds: 30,
        by: 'daemon-spawn:inst-A',
      });

      // Stop the renew timer.
      releaseSessionMock.mockResolvedValueOnce(1);
      await coord.releaseAgentSpawn('vid-g');
    });

    it('passes correct args to acquireSpawnLease (artifact prefix + task_class spawn)', async () => {
      acquireMock.mockResolvedValueOnce({ acquired: true, lease: MOCK_LEASE });
      const { coord } = makeCoordinator(120);

      await coord.acquireAgentSpawn('design-g', null);

      expect(acquireMock).toHaveBeenCalledWith({
        projectId: null,
        artifactKey: 'agent:design-g',
        taskClass: 'spawn',
        holderId: 'daemon-spawn:inst-A:design-g',
        ttlSeconds: 120,
        reason: 'daemon-spawn:inst-A',
      });

      releaseSessionMock.mockResolvedValueOnce(0);
      await coord.releaseAgentSpawn('design-g');
    });
  });

  describe('acquire — rejected path', () => {
    it('emits spawn_rejected warning when acquired=false and does NOT start a renew loop', async () => {
      const otherHolder = 'daemon-spawn:inst-B:vid-g';
      acquireMock.mockResolvedValueOnce({
        acquired: false,
        lease: { ...MOCK_LEASE, holder_id: otherHolder },
      });
      const { coord, events } = makeCoordinator();

      const r = await coord.acquireAgentSpawn('vid-g', '1evo');

      expect(r.acquired).toBe(false);
      expect(coord.size()).toBe(0);
      expect(coord.getHolderId('vid-g')).toBeNull();
      expect(events).toHaveLength(1);
      expect(events[0].name).toBe('spawn_rejected');
      expect(events[0].severity).toBe('warning');
      expect(events[0].meta).toMatchObject({
        reason: 'lock-held',
        artifact: 'agent:vid-g',
        held_by: otherHolder,
        by: 'daemon-spawn:inst-A',
      });
    });
  });

  describe('acquire — fail-open on throw', () => {
    it('returns acquired=true + emits spawn_lease_expired warning when acquireSpawnLease throws', async () => {
      acquireMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
      const { coord, events } = makeCoordinator();

      const r = await coord.acquireAgentSpawn('vid-g', '1evo');

      expect(r.acquired).toBe(true); // fail-open: daemon must keep working
      expect(r.lease).toBeNull();
      expect(coord.size()).toBe(0);
      expect(events).toHaveLength(1);
      expect(events[0].name).toBe('spawn_lease_expired');
      expect(events[0].severity).toBe('warning');
      expect(events[0].meta).toMatchObject({
        reason: 'acquire_threw',
        artifact: 'agent:vid-g',
      });
    });
  });

  describe('release', () => {
    it('clears the renew timer + calls releaseSessionLeases + emits release event', async () => {
      acquireMock.mockResolvedValueOnce({ acquired: true, lease: MOCK_LEASE });
      releaseSessionMock.mockResolvedValueOnce(1);
      const { coord, events } = makeCoordinator();

      await coord.acquireAgentSpawn('vid-g', '1evo');
      await coord.releaseAgentSpawn('vid-g');

      expect(releaseSessionMock).toHaveBeenCalledWith('daemon-spawn:inst-A:vid-g');
      expect(coord.size()).toBe(0);
      const releaseEvents = events.filter((e) => e.name === 'spawn_lease_released');
      expect(releaseEvents).toHaveLength(1);
      expect(releaseEvents[0].severity).toBe('info');
      expect(releaseEvents[0].meta.released_count).toBe(1);
    });

    it('is a no-op when no lease is held', async () => {
      const { coord } = makeCoordinator();
      await coord.releaseAgentSpawn('not-held');
      expect(releaseSessionMock).not.toHaveBeenCalled();
    });

    it('releaseAll releases every held lease', async () => {
      acquireMock
        .mockResolvedValueOnce({ acquired: true, lease: { ...MOCK_LEASE, id: 1 } })
        .mockResolvedValueOnce({ acquired: true, lease: { ...MOCK_LEASE, id: 2 } });
      releaseSessionMock.mockResolvedValue(1);
      const { coord } = makeCoordinator();

      await coord.acquireAgentSpawn('vid-g', '1evo');
      await coord.acquireAgentSpawn('dev-g', '1evo');
      expect(coord.size()).toBe(2);

      await coord.releaseAll();
      expect(coord.size()).toBe(0);
      expect(releaseSessionMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('renew loop', () => {
    it('renews on cadence + emits sampled info events', async () => {
      vi.useFakeTimers();
      acquireMock.mockResolvedValueOnce({ acquired: true, lease: MOCK_LEASE });
      // Each renew returns the same lease but with a fresh expires_at.
      renewMock.mockResolvedValue({ ...MOCK_LEASE, expires_at: '2026-05-17T00:31:00Z' });
      const { coord, events } = makeCoordinator(30, 10);

      await coord.acquireAgentSpawn('vid-g', '1evo');

      // Advance through 11 renew ticks. Each tick fires renew once.
      for (let i = 0; i < 11; i++) {
        await vi.advanceTimersByTimeAsync(10);
      }
      // Drain any microtasks from the last tick.
      await vi.advanceTimersByTimeAsync(1);

      expect(renewMock).toHaveBeenCalledTimes(11);
      const renewedEvents = events.filter((e) => e.name === 'spawn_lease_renewed');
      // Sampling: 1-of-10 = tick #1 and tick #11 emit; ticks 2-10 don't.
      expect(renewedEvents.length).toBeGreaterThanOrEqual(1);
      expect(renewedEvents.length).toBeLessThanOrEqual(3);

      vi.useRealTimers();
      releaseSessionMock.mockResolvedValueOnce(1);
      await coord.releaseAgentSpawn('vid-g');
    });

    it('emits spawn_lease_expired + stops the loop when renew returns null', async () => {
      vi.useFakeTimers();
      acquireMock.mockResolvedValueOnce({ acquired: true, lease: MOCK_LEASE });
      renewMock.mockResolvedValueOnce(null);
      const { coord, events } = makeCoordinator(30, 10);

      await coord.acquireAgentSpawn('vid-g', '1evo');
      await vi.advanceTimersByTimeAsync(15);
      await vi.advanceTimersByTimeAsync(1);

      expect(renewMock).toHaveBeenCalledTimes(1);
      const expiredEvents = events.filter((e) => e.name === 'spawn_lease_expired');
      expect(expiredEvents).toHaveLength(1);
      expect(expiredEvents[0].meta.reason).toBe('renew_returned_null');
      // Loop self-cleans the registry entry on expiry.
      expect(coord.size()).toBe(0);

      vi.useRealTimers();
    });
  });
});
