/**
 * Fleet-wide spawn-failure alert dedup (gen-B): one alert per failure-class per
 * 15min window, with affected-agent COUNT (not per-agent / per-retry spam),
 * escalating window number on persistence.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordSpawnFailure,
  collectPendingAlerts,
  formatSpawnFailureAlert,
  _resetSpawnFailureAlerter,
  SPAWN_ALERT_WINDOW_MS,
} from '../../../src/daemon/spawn-failure-alerter';

describe('spawn-failure-alerter — fleet-wide dedup', () => {
  beforeEach(() => _resetSpawnFailureAlerter());

  it('collapses the gen-B batch (14 agents) into ONE alert naming the count', () => {
    const t = 1_000_000;
    for (let i = 1; i <= 14; i++) recordSpawnFailure(`agent-${i}`, 'posix_spawnp', t);
    const alerts = collectPendingAlerts(t);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].affectedCount).toBe(14);
    expect(alerts[0].failureClass).toBe('posix_spawnp');
    expect(alerts[0].windowNumber).toBe(1);
  });

  it('counts each agent once even across multiple retries', () => {
    const t = 1_000_000;
    recordSpawnFailure('paul', 'posix_spawnp', t);
    recordSpawnFailure('paul', 'posix_spawnp', t + 100); // retry 2
    recordSpawnFailure('paul', 'posix_spawnp', t + 200); // retry 3
    const alerts = collectPendingAlerts(t + 300);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].affectedCount).toBe(1); // paul counted once, not 3×
  });

  it('does NOT re-alert within the same window after draining', () => {
    const t = 1_000_000;
    recordSpawnFailure('donna', 'posix_spawnp', t);
    expect(collectPendingAlerts(t)).toHaveLength(1);
    // more failures same window → no new alert
    recordSpawnFailure('nick', 'posix_spawnp', t + 1000);
    expect(collectPendingAlerts(t + 2000)).toHaveLength(0);
  });

  it('re-alerts in a later window with an escalating window number', () => {
    const t = 1_000_000;
    recordSpawnFailure('paul', 'posix_spawnp', t);
    expect(collectPendingAlerts(t)[0].windowNumber).toBe(1);
    // next window
    const t2 = t + SPAWN_ALERT_WINDOW_MS + 1;
    recordSpawnFailure('paul', 'posix_spawnp', t2);
    const a2 = collectPendingAlerts(t2);
    expect(a2).toHaveLength(1);
    expect(a2[0].windowNumber).toBe(2); // escalation
  });

  it('tracks distinct failure classes independently', () => {
    const t = 1_000_000;
    recordSpawnFailure('paul', 'posix_spawnp', t);
    recordSpawnFailure('donna', 'ENOMEM', t);
    const alerts = collectPendingAlerts(t);
    expect(alerts.map(a => a.failureClass).sort()).toEqual(['ENOMEM', 'posix_spawnp']);
  });

  it('formats an operator alert that states the count, class, and not-running truth', () => {
    const text = formatSpawnFailureAlert({ failureClass: 'posix_spawnp', affectedCount: 14, agents: ['a', 'b'], windowNumber: 1 });
    expect(text).toContain('14 agent(s)');
    expect(text).toContain('posix_spawnp');
    expect(text).toContain('NOT running');
  });
});
