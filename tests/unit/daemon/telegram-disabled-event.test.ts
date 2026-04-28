import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { emitTelegramDisabled, type TelegramDisabledReason } from '../../../src/daemon/agent-manager';
import type { BusPaths } from '../../../src/types';

/**
 * Locks the shape of the `error/telegram_disabled` event so the dashboard
 * (and Rubi's recurrence detector) keep working as the daemon evolves.
 *
 * Background: Lucy/health was silently inbound-disabled for days because
 * the daemon's security check refused Telegram (missing ALLOWED_USER) but
 * only logged to stdout. The operator never saw it. The fix emits a
 * warning event at every refusal site so the dashboard surfaces it
 * immediately. These tests guard the event shape and the four refusal
 * reasons.
 */
describe('emitTelegramDisabled', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-tg-disabled-test-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'spark'),
      inflight: join(testDir, 'inflight', 'spark'),
      processed: join(testDir, 'processed', 'spark'),
      logDir: join(testDir, 'logs', 'spark'),
      stateDir: join(testDir, 'state', 'spark'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
    mkdirSync(paths.stateDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it.each<TelegramDisabledReason>([
    'missing_allowed_user',
    'bad_token_format',
    'bad_allowed_user_format',
    'missing_chat_id',
  ])('persists a category=error event=telegram_disabled severity=warning event for reason %s', (reason) => {
    const log = vi.fn();
    emitTelegramDisabled(paths, 'health', 'eros-os', reason, log);

    const today = new Date().toISOString().split('T')[0];
    const eventFile = join(paths.analyticsDir, 'events', 'health', `${today}.jsonl`);
    const entries = readFileSync(eventFile, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      agent: 'health',
      org: 'eros-os',
      category: 'error',
      event: 'telegram_disabled',
      severity: 'warning',
      metadata: { reason },
    });
    expect(log).not.toHaveBeenCalled();
  });

  it('surfaces logEvent failures via the log callback without throwing', () => {
    // Force an unwritable analytics dir by stuffing a regular file at the
    // path mkdirSync recursive needs. logEvent's inner ensureDir then
    // throws ENOTDIR.
    const fileAtAnalyticsPath = join(testDir, 'analytics');
    require('fs').writeFileSync(fileAtAnalyticsPath, 'i am a file', 'utf-8');

    const log = vi.fn();
    expect(() => {
      emitTelegramDisabled(paths, 'health', 'eros-os', 'missing_allowed_user', log);
    }).not.toThrow();

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('logEvent(telegram_disabled, missing_allowed_user) failed');
  });

  it('does not pollute errors_today: severity=warning is excluded from the metrics-collector error count', () => {
    // Documents the symbiosis with PR#266 (metrics severity filter):
    // category=error severity=warning is intentional — the dashboard can
    // group these as "warnings" without inflating errors_today, and the
    // metrics collector's filter (severity ∈ {error, critical}) skips them.
    // We assert the event shape; the metrics collector's own tests cover
    // the filter logic.
    const log = vi.fn();
    emitTelegramDisabled(paths, 'health', 'eros-os', 'missing_allowed_user', log);

    const today = new Date().toISOString().split('T')[0];
    const eventFile = join(paths.analyticsDir, 'events', 'health', `${today}.jsonl`);
    const entry = JSON.parse(readFileSync(eventFile, 'utf-8').trim());
    expect(entry.severity).toBe('warning');
    // category=error so a "show me everything broken" filter still sees it.
    expect(entry.category).toBe('error');
  });
});
