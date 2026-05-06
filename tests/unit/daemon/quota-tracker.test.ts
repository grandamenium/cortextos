import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { QuotaTracker } from '../../../src/daemon/quota-tracker';

describe('QuotaTracker — per-agent daily cost load-shedding', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'quota-test-'));
  });

  afterEach(() => { rmSync(stateDir, { recursive: true, force: true }); });

  it('starts with zero spend and ok status', () => {
    const qt = new QuotaTracker('alice', stateDir, { daily_budget_usd: 10 });
    expect(qt.check()).toEqual({ status: 'ok' });
    expect(qt.isBlocked()).toBe(false);
    expect(qt.getState().spent_usd).toBe(0);
  });

  it('recordSpend accumulates and returns ok below soft threshold', () => {
    const qt = new QuotaTracker('alice', stateDir, { daily_budget_usd: 10, soft_pct: 80, hard_pct: 100 });
    const r = qt.recordSpend(5);
    expect(r.status).toBe('ok');
    expect(qt.getState().spent_usd).toBe(5);
  });

  it('triggers soft_warning at soft threshold', () => {
    const qt = new QuotaTracker('alice', stateDir, { daily_budget_usd: 10, soft_pct: 80, hard_pct: 100 });
    qt.recordSpend(7.9); // 79% — still ok
    expect(qt.check().status).toBe('ok');
    const r = qt.recordSpend(0.2); // 81% — triggers
    expect(r.status).toBe('soft_warning');
    expect(r.status === 'soft_warning' && r.pct).toBeGreaterThanOrEqual(80);
  });

  it('soft_warning fires only once (flag persisted)', () => {
    const qt = new QuotaTracker('alice', stateDir, { daily_budget_usd: 10, soft_pct: 80 });
    qt.recordSpend(8.5); // first trigger
    const second = qt.recordSpend(0.1); // still above 80% but already warned
    expect(second.status).toBe('ok');
  });

  it('triggers hard_blocked at hard threshold', () => {
    const qt = new QuotaTracker('alice', stateDir, { daily_budget_usd: 10, soft_pct: 80, hard_pct: 100 });
    qt.recordSpend(8.5); // soft
    const r = qt.recordSpend(2); // 105% — hard
    expect(r.status).toBe('hard_blocked');
    expect(qt.isBlocked()).toBe(true);
  });

  it('hard_blocked persists — isBlocked stays true after further checks', () => {
    const qt = new QuotaTracker('alice', stateDir, { daily_budget_usd: 10, soft_pct: 80, hard_pct: 100 });
    qt.recordSpend(8.5); // triggers soft_warning
    qt.recordSpend(2);   // triggers hard_blocked
    expect(qt.isBlocked()).toBe(true);
    // Further checks: soft already warned, hard already flagged — returns ok (no new event)
    expect(qt.check().status).toBe('ok');
    expect(qt.isBlocked()).toBe(true); // but still blocked
  });

  it('persists state to disk and reloads across instances', () => {
    const qt1 = new QuotaTracker('alice', stateDir, { daily_budget_usd: 10 });
    qt1.recordSpend(6);

    // New instance — same agent, same stateDir
    const qt2 = new QuotaTracker('alice', stateDir, { daily_budget_usd: 10 });
    expect(qt2.getState().spent_usd).toBe(6);
  });

  it('resets on a new day (daily budget cycle)', () => {
    const qt = new QuotaTracker('alice', stateDir, { daily_budget_usd: 10 });
    qt.recordSpend(9);
    // Simulate day change by modifying state file date
    const files = readdirSync(stateDir).filter(f => f.startsWith('quota-'));
    expect(files.length).toBe(1);
    const state = JSON.parse(readFileSync(join(stateDir, files[0]), 'utf-8'));
    state.date = '2020-01-01'; // force stale
    const { writeFileSync } = require('fs');
    writeFileSync(join(stateDir, files[0]), JSON.stringify(state));

    // New instance reads the stale date, should reset
    const qt2 = new QuotaTracker('alice', stateDir, { daily_budget_usd: 10 });
    expect(qt2.getState().spent_usd).toBe(0);
    expect(qt2.isBlocked()).toBe(false);
  });

  it('manual reset clears all state', () => {
    const qt = new QuotaTracker('alice', stateDir, { daily_budget_usd: 10, hard_pct: 100 });
    qt.recordSpend(15);
    expect(qt.isBlocked()).toBe(true);
    qt.reset();
    expect(qt.isBlocked()).toBe(false);
    expect(qt.getState().spent_usd).toBe(0);
  });
});
