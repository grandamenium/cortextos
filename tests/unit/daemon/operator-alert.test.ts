/**
 * Tests for src/daemon/operator-alert.ts — the shared operator-Telegram
 * helper extracted from spawn-failure-tracker.ts as part of fleet-resilience
 * plan #1. Covers cooldown gating, cred resolution, state persistence, and
 * the no-creds / send-failure paths.
 *
 * Telegram delivery is short-circuited by stubbing creds and intercepting
 * the `curl` spawnSync via env shim (we never let curl run for real).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Capture spawnSync invocations and stub the Telegram POST. The module
// imports `spawnSync` from `child_process`; intercept via vi.mock.
const spawnSyncMock = vi.fn();
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
  };
});

import {
  emitOperatorAlert,
  readOperatorAlertState,
  operatorAlertStatePath,
  resolveOperatorChatCreds,
} from '../../../src/daemon/operator-alert';

let ctxRoot: string;
let frameworkRoot: string;

const ORIG_ENV_CHAT = process.env.CTX_OPERATOR_CHAT_ID;
const ORIG_ENV_TOKEN = process.env.CTX_OPERATOR_BOT_TOKEN;

beforeEach(() => {
  ctxRoot = mkdtempSync(join(tmpdir(), 'cortextos-opalert-ctx-'));
  frameworkRoot = mkdtempSync(join(tmpdir(), 'cortextos-opalert-fw-'));
  spawnSyncMock.mockReset();
  // Default: curl succeeds.
  spawnSyncMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });
  // Default creds: prefer env. Both must be present + token-shaped to be honored.
  process.env.CTX_OPERATOR_CHAT_ID = '12345';
  process.env.CTX_OPERATOR_BOT_TOKEN = '99999:fakefakefakefakefakeABCDEFGHIJ';
});

afterEach(() => {
  rmSync(ctxRoot, { recursive: true, force: true });
  rmSync(frameworkRoot, { recursive: true, force: true });
  if (ORIG_ENV_CHAT === undefined) delete process.env.CTX_OPERATOR_CHAT_ID;
  else process.env.CTX_OPERATOR_CHAT_ID = ORIG_ENV_CHAT;
  if (ORIG_ENV_TOKEN === undefined) delete process.env.CTX_OPERATOR_BOT_TOKEN;
  else process.env.CTX_OPERATOR_BOT_TOKEN = ORIG_ENV_TOKEN;
});

describe('resolveOperatorChatCreds', () => {
  it('returns env creds when both vars are valid', () => {
    expect(resolveOperatorChatCreds(frameworkRoot)).toEqual({
      chatId: '12345',
      botToken: '99999:fakefakefakefakefakeABCDEFGHIJ',
    });
  });

  it('falls back to scanning agent .env when env vars are missing', () => {
    delete process.env.CTX_OPERATOR_CHAT_ID;
    delete process.env.CTX_OPERATOR_BOT_TOKEN;
    const agentDir = join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, '.env'),
      'BOT_TOKEN=11111:tokenABCDEFGHIJKLMNOPQRSTUVWXYZ\nCHAT_ID=98765\n',
    );
    expect(resolveOperatorChatCreds(frameworkRoot)).toEqual({
      chatId: '98765',
      botToken: '11111:tokenABCDEFGHIJKLMNOPQRSTUVWXYZ',
    });
  });

  it('prefers activity-channel.env over agent .env when env vars are missing', () => {
    delete process.env.CTX_OPERATOR_CHAT_ID;
    delete process.env.CTX_OPERATOR_BOT_TOKEN;
    const orgDir = join(frameworkRoot, 'orgs', 'acme');
    const agentDir = join(orgDir, 'agents', 'alice');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(orgDir, 'activity-channel.env'),
      'ACTIVITY_BOT_TOKEN=22222:activityCHANNELTOKEN_ABCDEFGHIJ\nACTIVITY_CHAT_ID=-1009999\n',
    );
    // Agent .env exists — must be ignored because activity-channel takes priority.
    writeFileSync(
      join(agentDir, '.env'),
      'BOT_TOKEN=11111:tokenABCDEFGHIJKLMNOPQRSTUVWXYZ\nCHAT_ID=98765\n',
    );
    expect(resolveOperatorChatCreds(frameworkRoot)).toEqual({
      chatId: '-1009999',
      botToken: '22222:activityCHANNELTOKEN_ABCDEFGHIJ',
    });
  });

  it('uses activity-channel.env alone (no agent .env present)', () => {
    delete process.env.CTX_OPERATOR_CHAT_ID;
    delete process.env.CTX_OPERATOR_BOT_TOKEN;
    const orgDir = join(frameworkRoot, 'orgs', 'acme');
    mkdirSync(orgDir, { recursive: true });
    writeFileSync(
      join(orgDir, 'activity-channel.env'),
      'ACTIVITY_BOT_TOKEN=22222:activityCHANNELTOKEN_ABCDEFGHIJ\nACTIVITY_CHAT_ID=-1009999\n',
    );
    expect(resolveOperatorChatCreds(frameworkRoot)).toEqual({
      chatId: '-1009999',
      botToken: '22222:activityCHANNELTOKEN_ABCDEFGHIJ',
    });
  });

  it('env vars still beat activity-channel.env when both present', () => {
    // env vars left at default beforeEach values — should win.
    const orgDir = join(frameworkRoot, 'orgs', 'acme');
    mkdirSync(orgDir, { recursive: true });
    writeFileSync(
      join(orgDir, 'activity-channel.env'),
      'ACTIVITY_BOT_TOKEN=22222:activityCHANNELTOKEN_ABCDEFGHIJ\nACTIVITY_CHAT_ID=-1009999\n',
    );
    expect(resolveOperatorChatCreds(frameworkRoot)).toEqual({
      chatId: '12345',
      botToken: '99999:fakefakefakefakefakeABCDEFGHIJ',
    });
  });

  it('skips activity-channel.env with only one of ACTIVITY_BOT_TOKEN / ACTIVITY_CHAT_ID and falls through to agent .env', () => {
    delete process.env.CTX_OPERATOR_CHAT_ID;
    delete process.env.CTX_OPERATOR_BOT_TOKEN;
    const orgDir = join(frameworkRoot, 'orgs', 'acme');
    const agentDir = join(orgDir, 'agents', 'alice');
    mkdirSync(agentDir, { recursive: true });
    // Token present, chat_id missing — tier 2 must reject and fall through.
    writeFileSync(
      join(orgDir, 'activity-channel.env'),
      'ACTIVITY_BOT_TOKEN=22222:activityCHANNELTOKEN_ABCDEFGHIJ\n',
    );
    writeFileSync(
      join(agentDir, '.env'),
      'BOT_TOKEN=11111:tokenABCDEFGHIJKLMNOPQRSTUVWXYZ\nCHAT_ID=98765\n',
    );
    expect(resolveOperatorChatCreds(frameworkRoot)).toEqual({
      chatId: '98765',
      botToken: '11111:tokenABCDEFGHIJKLMNOPQRSTUVWXYZ',
    });

    // Now the inverse: chat_id present, token missing — also reject.
    writeFileSync(
      join(orgDir, 'activity-channel.env'),
      'ACTIVITY_CHAT_ID=-1009999\n',
    );
    expect(resolveOperatorChatCreds(frameworkRoot)).toEqual({
      chatId: '98765',
      botToken: '11111:tokenABCDEFGHIJKLMNOPQRSTUVWXYZ',
    });
  });

  it('skips activity-channel.env with malformed token and falls through to agent .env', () => {
    delete process.env.CTX_OPERATOR_CHAT_ID;
    delete process.env.CTX_OPERATOR_BOT_TOKEN;
    const orgDir = join(frameworkRoot, 'orgs', 'acme');
    const agentDir = join(orgDir, 'agents', 'alice');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(orgDir, 'activity-channel.env'),
      'ACTIVITY_BOT_TOKEN=not-a-real-token\nACTIVITY_CHAT_ID=-1009999\n',
    );
    writeFileSync(
      join(agentDir, '.env'),
      'BOT_TOKEN=11111:tokenABCDEFGHIJKLMNOPQRSTUVWXYZ\nCHAT_ID=98765\n',
    );
    expect(resolveOperatorChatCreds(frameworkRoot)).toEqual({
      chatId: '98765',
      botToken: '11111:tokenABCDEFGHIJKLMNOPQRSTUVWXYZ',
    });
  });

  it('returns null when env is missing and no agent .env is present', () => {
    delete process.env.CTX_OPERATOR_CHAT_ID;
    delete process.env.CTX_OPERATOR_BOT_TOKEN;
    expect(resolveOperatorChatCreds(frameworkRoot)).toBeNull();
  });

  it('rejects malformed token (env path)', () => {
    process.env.CTX_OPERATOR_BOT_TOKEN = 'not-a-real-token';
    // Falls back to file scan; no file → null.
    expect(resolveOperatorChatCreds(frameworkRoot)).toBeNull();
  });
});

describe('emitOperatorAlert', () => {
  it('sends on first call and persists the cooldown marker', () => {
    const r = emitOperatorAlert(ctxRoot, frameworkRoot, {
      kind: 'cron_dispatch_storm',
      severity: 'CRITICAL',
      text: 'storm',
      cooldownKey: 'cron_dispatch_storm-boss',
    });
    expect(r).toEqual({ sent: true, reason: 'ok' });
    expect(spawnSyncMock).toHaveBeenCalledOnce();
    expect(existsSync(operatorAlertStatePath(ctxRoot))).toBe(true);
    const state = readOperatorAlertState(ctxRoot);
    expect(state.lastSentAt['cron_dispatch_storm-boss']).toBeTruthy();
  });

  it('skips on second call within cooldown window', () => {
    const baseAlert = {
      kind: 'cron_dispatch_storm' as const,
      severity: 'CRITICAL' as const,
      text: 'storm',
      cooldownKey: 'cron_dispatch_storm-boss',
      cooldownMs: 60_000,
    };
    expect(emitOperatorAlert(ctxRoot, frameworkRoot, baseAlert).sent).toBe(true);
    spawnSyncMock.mockClear();
    const r = emitOperatorAlert(ctxRoot, frameworkRoot, baseAlert);
    expect(r).toEqual({ sent: false, reason: 'cooldown' });
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('sends again after the cooldown window elapses', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-15T10:00:00Z'));
    try {
      const alert = {
        kind: 'cron_dispatch_storm' as const,
        severity: 'CRITICAL' as const,
        text: 'storm',
        cooldownKey: 'cron_dispatch_storm-boss',
        cooldownMs: 60_000,
      };
      expect(emitOperatorAlert(ctxRoot, frameworkRoot, alert).sent).toBe(true);
      vi.setSystemTime(new Date('2026-05-15T10:00:30Z'));
      expect(emitOperatorAlert(ctxRoot, frameworkRoot, alert).reason).toBe('cooldown');
      vi.setSystemTime(new Date('2026-05-15T10:01:30Z'));
      expect(emitOperatorAlert(ctxRoot, frameworkRoot, alert).sent).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('separate cooldownKeys do not interfere', () => {
    const r1 = emitOperatorAlert(ctxRoot, frameworkRoot, {
      kind: 'cron_dispatch_storm', severity: 'CRITICAL', text: 'one',
      cooldownKey: 'cron_dispatch_storm-boss',
    });
    const r2 = emitOperatorAlert(ctxRoot, frameworkRoot, {
      kind: 'cron_dispatch_storm', severity: 'CRITICAL', text: 'two',
      cooldownKey: 'cron_dispatch_storm-analyst',
    });
    expect(r1.sent).toBe(true);
    expect(r2.sent).toBe(true);
    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
  });

  it('returns no_creds when no creds resolved (no env, no .env)', () => {
    delete process.env.CTX_OPERATOR_CHAT_ID;
    delete process.env.CTX_OPERATOR_BOT_TOKEN;
    const r = emitOperatorAlert(ctxRoot, frameworkRoot, {
      kind: 'spawn_storm', severity: 'CRITICAL', text: 'x',
      cooldownKey: 'spawn_storm',
    });
    expect(r).toEqual({ sent: false, reason: 'no_creds' });
    expect(spawnSyncMock).not.toHaveBeenCalled();
    // Cooldown not recorded — caller may retry once creds are available.
    expect(readOperatorAlertState(ctxRoot).lastSentAt).toEqual({});
  });

  it('returns send_failed when curl exits non-zero, BUT still records cooldown', () => {
    spawnSyncMock.mockReturnValue({ status: 7, stdout: '', stderr: 'network down' });
    const r = emitOperatorAlert(ctxRoot, frameworkRoot, {
      kind: 'spawn_storm', severity: 'CRITICAL', text: 'x',
      cooldownKey: 'spawn_storm',
    });
    expect(r).toEqual({ sent: false, reason: 'send_failed' });
    // Cooldown IS recorded — without this a flapping Telegram outage would
    // cause every watchdog tick to re-attempt and flood logs.
    expect(readOperatorAlertState(ctxRoot).lastSentAt['spawn_storm']).toBeTruthy();
  });
});

describe('readOperatorAlertState', () => {
  it('returns empty map when file is missing', () => {
    expect(readOperatorAlertState(ctxRoot)).toEqual({ lastSentAt: {} });
  });

  it('returns empty map on corrupt JSON', () => {
    mkdirSync(join(ctxRoot, 'state'), { recursive: true });
    writeFileSync(operatorAlertStatePath(ctxRoot), '{not json');
    expect(readOperatorAlertState(ctxRoot)).toEqual({ lastSentAt: {} });
  });

  it('round-trips through emitOperatorAlert', () => {
    emitOperatorAlert(ctxRoot, frameworkRoot, {
      kind: 'heartbeat_stale', severity: 'CRITICAL', text: 'x',
      cooldownKey: 'heartbeat_stale-boss',
    });
    const onDisk = JSON.parse(readFileSync(operatorAlertStatePath(ctxRoot), 'utf-8'));
    expect(onDisk.lastSentAt['heartbeat_stale-boss']).toBeTruthy();
  });
});
