/**
 * F5: scoped secret-writer helpers for the add-org --pack installer.
 * Fills placeholder env files with collected values, preserves comments/other
 * keys, chmod 0600, and enforces the daemon's BOT_TOKEN-requires-ALLOWED_USER
 * rule at write time.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { upsertEnvFile, writeOrgSecrets, writeAgentEnv } from '../../../src/scaffold/secrets';

describe('F5 scaffold/secrets', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'f5-secrets-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  describe('upsertEnvFile', () => {
    it('fills an existing placeholder key in place and preserves comments + other keys', () => {
      const p = join(dir, 'secrets.env');
      writeFileSync(p, '# comment line\nGEMINI_API_KEY=\nOTHER=keep-me\n');
      upsertEnvFile(p, { GEMINI_API_KEY: 'abc123' });
      const out = readFileSync(p, 'utf-8');
      expect(out).toContain('# comment line');
      expect(out).toContain('GEMINI_API_KEY=abc123');
      expect(out).toContain('OTHER=keep-me');
    });

    it('appends keys that are not already present', () => {
      const p = join(dir, 'secrets.env');
      writeFileSync(p, '# header\nEXISTING=1\n');
      upsertEnvFile(p, { NEWKEY: 'v' });
      const out = readFileSync(p, 'utf-8');
      expect(out).toContain('EXISTING=1');
      expect(out).toMatch(/NEWKEY=v/);
    });

    it('creates the file if missing and chmods it 0600', () => {
      const p = join(dir, 'fresh.env');
      upsertEnvFile(p, { K: 'v' });
      expect(readFileSync(p, 'utf-8')).toContain('K=v');
      expect(statSync(p).mode & 0o777).toBe(0o600);
    });

    it('does not touch keys the caller did not provide', () => {
      const p = join(dir, 'secrets.env');
      writeFileSync(p, 'A=1\nB=2\n');
      upsertEnvFile(p, { A: '9' });
      const out = readFileSync(p, 'utf-8');
      expect(out).toContain('A=9');
      expect(out).toContain('B=2');
    });
  });

  describe('writeOrgSecrets', () => {
    it('writes into orgs/<org>/secrets.env', () => {
      writeFileSync(join(dir, 'secrets.env'), 'GEMINI_API_KEY=\n');
      writeOrgSecrets(dir, { GEMINI_API_KEY: 'key' });
      expect(readFileSync(join(dir, 'secrets.env'), 'utf-8')).toContain('GEMINI_API_KEY=key');
    });
  });

  describe('writeAgentEnv', () => {
    it('writes Telegram creds when ALLOWED_USER is provided alongside BOT_TOKEN', () => {
      writeAgentEnv(dir, { BOT_TOKEN: 't', CHAT_ID: '123', ALLOWED_USER: '999' });
      const out = readFileSync(join(dir, '.env'), 'utf-8');
      expect(out).toContain('BOT_TOKEN=t');
      expect(out).toContain('CHAT_ID=123');
      expect(out).toContain('ALLOWED_USER=999');
      expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o600);
    });

    it('throws when BOT_TOKEN is set without ALLOWED_USER (daemon would refuse Telegram)', () => {
      expect(() => writeAgentEnv(dir, { BOT_TOKEN: 't', CHAT_ID: '123' })).toThrow(/ALLOWED_USER/);
    });

    it('allows setting BOT_TOKEN when ALLOWED_USER already exists on disk', () => {
      writeFileSync(join(dir, '.env'), 'ALLOWED_USER=already\n');
      expect(() => writeAgentEnv(dir, { BOT_TOKEN: 't' })).not.toThrow();
      const out = readFileSync(join(dir, '.env'), 'utf-8');
      expect(out).toContain('BOT_TOKEN=t');
      expect(out).toContain('ALLOWED_USER=already');
    });

    it('does not require ALLOWED_USER when BOT_TOKEN is not being set', () => {
      expect(() => writeAgentEnv(dir, { CHAT_ID: '123' })).not.toThrow();
    });
  });
});
