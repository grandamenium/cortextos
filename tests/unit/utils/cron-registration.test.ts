/**
 * tests/unit/utils/cron-registration.test.ts
 *
 * Negative controls for the registration reconcile. A liveness check that cannot be
 * SHOWN TO FIRE is a vacuous gate — and a liveness check is the last place to ship one,
 * because its entire job is to fire when everything else looks fine.
 */
import { describe, it, expect } from 'vitest';
import { reconcileAgentCrons } from '../../../src/utils/cron-registration';

describe('reconcileAgentCrons', () => {
  it('agrees -> no drift', () => {
    const { drift, examined } = reconcileAgentCrons(
      'dev',
      [{ name: 'heartbeat' }, { name: 'security-sweep' }],
      [{ name: 'heartbeat', enabled: true }, { name: 'security-sweep', enabled: true }],
    );
    expect(drift).toEqual([]);
    expect(examined).toBe(2);
  });

  it('NEGATIVE CONTROL — cron REMOVED from live: declared but never registered, so it will never fire', () => {
    // No fire-gap check can ever see this: the cron has no fires to be late for.
    const { drift } = reconcileAgentCrons(
      'dev',
      [{ name: 'weekly-security-sweep' }],
      [],
    );
    expect(drift).toHaveLength(1);
    expect(drift[0].kind).toBe('declared-not-registered');
    expect(drift[0].cron).toBe('weekly-security-sweep');
  });

  it('NEGATIVE CONTROL — THE DRIFT WE ACTUALLY HIT: live but absent from config.json', () => {
    // safetystack-handoff-check was exactly this on 2026-07-14: registered and firing,
    // but missing from config.json — so a rebuild-from-config would have deleted it and
    // nothing would have said a word. Found by hand. This is that check.
    const { drift } = reconcileAgentCrons(
      'dev',
      [{ name: 'heartbeat' }],
      [{ name: 'heartbeat' }, { name: 'safetystack-handoff-check' }],
    );
    expect(drift).toHaveLength(1);
    expect(drift[0].kind).toBe('registered-not-declared');
    expect(drift[0].cron).toBe('safetystack-handoff-check');
    expect(drift[0].detail).toMatch(/silently DELETE/);
  });

  it('NEGATIVE CONTROL — registered but DISABLED: present, and still never fires', () => {
    const { drift } = reconcileAgentCrons(
      'dev',
      [{ name: 'weekly-security-sweep' }],
      [{ name: 'weekly-security-sweep', enabled: false }],
    );
    expect(drift).toHaveLength(1);
    expect(drift[0].kind).toBe('registered-but-disabled');
  });

  it('ZERO COVERAGE IS NOT AN ALL-CLEAR — empty vs empty reports examined:0, not "healthy"', () => {
    // A reconcile that compared two empty lists and returned "no drift" would be a tick
    // over nothing. The caller must key off `examined`, never off an empty drift array.
    const { drift, examined } = reconcileAgentCrons('dev', [], []);
    expect(drift).toEqual([]);
    expect(examined).toBe(0);   // <- the caller's cue that it learned NOTHING
  });
});
