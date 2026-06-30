/**
 * tests/unit/utils/env.test.ts
 *
 * Unit tests for resolveCronTimezone — the resolver that decides which IANA
 * timezone an org's cron EXPRESSIONS are interpreted in. It must default to
 * "UTC" whenever the org has not explicitly opted into a zone, so a cron's
 * firing instant never depends on the daemon's process timezone.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { resolveCronTimezone } from '../../../src/utils/env';

describe('resolveCronTimezone', () => {
  let projectRoot: string;
  const origEnv = process.env.CTX_CRON_TIMEZONE;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'crontz-'));
    delete process.env.CTX_CRON_TIMEZONE;
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    if (origEnv === undefined) delete process.env.CTX_CRON_TIMEZONE;
    else process.env.CTX_CRON_TIMEZONE = origEnv;
  });

  function writeContext(org: string, ctx: Record<string, unknown>): void {
    const dir = join(projectRoot, 'orgs', org);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'context.json'), JSON.stringify(ctx), 'utf-8');
  }

  it('returns the org context.json cron_timezone when set', () => {
    writeContext('acme', { name: 'acme', cron_timezone: 'America/New_York' });
    expect(resolveCronTimezone('acme', projectRoot)).toBe('America/New_York');
  });

  it('defaults to UTC when cron_timezone is absent from context.json', () => {
    writeContext('acme', { name: 'acme', timezone: 'America/Chicago' });
    // `timezone` (day/night-mode) must NOT be used as the cron zone.
    expect(resolveCronTimezone('acme', projectRoot)).toBe('UTC');
  });

  it('defaults to UTC when context.json is missing', () => {
    expect(resolveCronTimezone('acme', projectRoot)).toBe('UTC');
  });

  it('defaults to UTC when context.json is malformed', () => {
    const dir = join(projectRoot, 'orgs', 'acme');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'context.json'), '{ not valid json', 'utf-8');
    expect(resolveCronTimezone('acme', projectRoot)).toBe('UTC');
  });

  it('defaults to UTC when org or projectRoot is empty', () => {
    expect(resolveCronTimezone('', projectRoot)).toBe('UTC');
    expect(resolveCronTimezone('acme', '')).toBe('UTC');
  });

  it('CTX_CRON_TIMEZONE env var overrides the org context.json', () => {
    writeContext('acme', { name: 'acme', cron_timezone: 'America/New_York' });
    process.env.CTX_CRON_TIMEZONE = 'Europe/London';
    expect(resolveCronTimezone('acme', projectRoot)).toBe('Europe/London');
  });

  it('falls back to UTC when cron_timezone is not a valid IANA zone', () => {
    // A typo must degrade safely, not silently drop every cron-expression cron.
    writeContext('acme', { name: 'acme', cron_timezone: 'EST5EDT-typo' });
    expect(resolveCronTimezone('acme', projectRoot)).toBe('UTC');
  });
});
