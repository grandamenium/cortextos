/**
 * Tests for resolveLegacyTelegramEnablement — the gate that PR1 extracted
 * from the inline block at agent-manager.ts:208-249. Must be byte-identical
 * with today's behavior, including the exact WARNING/SECURITY log strings.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveLegacyTelegramEnablement } from '../../../src/daemon/agent-manager.js';

describe('resolveLegacyTelegramEnablement', () => {
  let tmpDir: string;
  let envFile: string;
  let logs: string[];
  const log = (msg: string) => { logs.push(msg); };

  beforeEach(() => {
    tmpDir = join(tmpdir(), `connector-resolver-${Date.now()}-${Math.random()}`);
    mkdirSync(tmpDir, { recursive: true });
    envFile = join(tmpDir, '.env');
    logs = [];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('all three vars valid → enabled: true, no logs', () => {
    writeFileSync(envFile, 'BOT_TOKEN=123456:ABC-def_123\nCHAT_ID=12345\nALLOWED_USER=67890\n');
    const r = resolveLegacyTelegramEnablement(envFile, log);
    expect(r.enabled).toBe(true);
    if (r.enabled) {
      expect(r.botToken).toBe('123456:ABC-def_123');
      expect(r.chatId).toBe('12345');
      expect(r.allowedUserId).toBe('67890');
    }
    expect(logs).toHaveLength(0);
  });

  it('invalid BOT_TOKEN format → enabled: false + exact WARNING string', () => {
    writeFileSync(envFile, 'BOT_TOKEN=not-a-token\nCHAT_ID=12345\nALLOWED_USER=67890\n');
    const r = resolveLegacyTelegramEnablement(envFile, log);
    expect(r.enabled).toBe(false);
    expect(logs).toContain(
      'WARNING: BOT_TOKEN format invalid (expected: 123456:ABC...). Telegram will not start.',
    );
  });

  it('non-numeric ALLOWED_USER → enabled: false + exact SECURITY string', () => {
    writeFileSync(envFile, 'BOT_TOKEN=123:abc_DEF\nCHAT_ID=12345\nALLOWED_USER=daniel\n');
    const r = resolveLegacyTelegramEnablement(envFile, log);
    expect(r.enabled).toBe(false);
    expect(logs).toContain(
      'SECURITY: ALLOWED_USER is not a numeric ID. Telegram user IDs are numbers (e.g. 123456789). Refusing to enable Telegram. Fix the .env file.',
    );
  });

  it('BOT_TOKEN set but ALLOWED_USER missing → enabled: false + exact SECURITY string', () => {
    writeFileSync(envFile, 'BOT_TOKEN=123:abc_DEF\nCHAT_ID=12345\n');
    const r = resolveLegacyTelegramEnablement(envFile, log);
    expect(r.enabled).toBe(false);
    expect(logs).toContain(
      'SECURITY: BOT_TOKEN is set but ALLOWED_USER is missing. Refusing to enable Telegram. Set ALLOWED_USER to your numeric Telegram user ID in .env, or remove BOT_TOKEN to start the agent without Telegram.',
    );
  });

  it('no .env file → enabled: false + no logs (silent)', () => {
    const r = resolveLegacyTelegramEnablement(join(tmpDir, 'does-not-exist'), log);
    expect(r.enabled).toBe(false);
    expect(logs).toHaveLength(0);
  });

  it('optional LogFn default is a no-op — callers can omit it for silent runs', () => {
    writeFileSync(envFile, 'BOT_TOKEN=not-a-token\nCHAT_ID=12345\nALLOWED_USER=67890\n');
    // No log arg → resolver still rejects but doesn't crash.
    const r = resolveLegacyTelegramEnablement(envFile);
    expect(r.enabled).toBe(false);
  });

  it('missing CHAT_ID with valid BOT_TOKEN + ALLOWED_USER → enabled: false', () => {
    writeFileSync(envFile, 'BOT_TOKEN=123:abc_DEF\nALLOWED_USER=67890\n');
    const r = resolveLegacyTelegramEnablement(envFile, log);
    expect(r.enabled).toBe(false);
  });
});
