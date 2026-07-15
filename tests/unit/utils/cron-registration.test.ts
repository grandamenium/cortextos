/**
 * tests/unit/utils/cron-registration.test.ts
 *
 * Negative controls for the registration reconcile. A liveness check that cannot be
 * SHOWN TO FIRE is a vacuous gate — and a liveness check is the last place to ship one,
 * because its entire job is to fire when everything else looks fine.
 */
import { describe, it, expect } from 'vitest';
import { reconcileAgentCrons, reconcileLiveSchedule } from '../../../src/utils/cron-registration';

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

describe('reconcileLiveSchedule — the third surface (disk vs running scheduler)', () => {
  it('disk and scheduler agree -> no drift', () => {
    const { drift, examined } = reconcileLiveSchedule(
      'dev',
      [{ name: 'handoff', schedule: '13 14 * * *', enabled: true }],
      [{ name: 'handoff', schedule: '13 14 * * *' }],
    );
    expect(drift).toEqual([]);
    expect(examined).toBe(1);
  });

  it('★ NEGATIVE CONTROL — THE HAND-EDIT THAT NEVER RELOADED: disk changed, scheduler stale', () => {
    // This is the exact 2026-07-15 incident: crons.json was edited to "13 14 * * *" but the
    // running scheduler still holds "13 14,20,1 * * *" because the edit skipped the reload
    // signal. Invisible to the file-vs-file check (both files agree) and to list-crons (reads
    // disk). ONLY this catches it.
    const { drift } = reconcileLiveSchedule(
      'dev',
      [{ name: 'handoff', schedule: '13 14 * * *', enabled: true }],       // disk: fixed
      [{ name: 'handoff', schedule: '13 14,20,1 * * *' }],                 // scheduler: stale
    );
    expect(drift).toHaveLength(1);
    expect(drift[0].kind).toBe('schedule-stale');
    expect(drift[0].detail).toMatch(/without a reload/);
  });

  it('NEGATIVE CONTROL — enabled on disk but scheduler has no entry (added without reload)', () => {
    const { drift } = reconcileLiveSchedule(
      'dev',
      [{ name: 'newcron', schedule: '0 9 * * *', enabled: true }],
      [],  // scheduler never picked it up
    );
    expect(drift).toHaveLength(1);
    expect(drift[0].kind).toBe('declared-not-registered');
  });

  it('a DISABLED cron absent from the scheduler is NOT drift (disabled crons are not scheduled)', () => {
    const { drift } = reconcileLiveSchedule(
      'dev',
      [{ name: 'off', schedule: '0 9 * * *', enabled: false }],
      [],
    );
    expect(drift).toEqual([]);   // correctly silent — no false alarm
  });

  it('★ NEGATIVE CONTROL — ORPHAN: removed from crons.json but the scheduler still fires it', () => {
    // The inverse of the incident: a hand-removal that skipped the reload. The scheduler
    // keeps firing a cron that no longer exists on disk. `examined` counts it, so without
    // this direction the count would claim coverage over an unchecked case.
    const { drift } = reconcileLiveSchedule(
      'dev',
      [],                                                 // disk: gone
      [{ name: 'ghost', schedule: '0 3 * * *' }],         // scheduler: still firing it
    );
    expect(drift).toHaveLength(1);
    expect(drift[0].kind).toBe('scheduler-orphan');
    expect(drift[0].detail).toMatch(/removed without a reload/);
  });

  it('ZERO COVERAGE reports examined:0, not all-clear', () => {
    const { drift, examined } = reconcileLiveSchedule('dev', [], []);
    expect(drift).toEqual([]);
    expect(examined).toBe(0);
  });
});
