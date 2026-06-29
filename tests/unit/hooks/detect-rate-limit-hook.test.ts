/**
 * Regression tests for detectRateLimitInLog (src/hooks/hook-crash-alert.ts).
 *
 * Root cause: bare prose substrings 'rate limit' and 'rate-limit' caused
 * session titles like "Rate Limit Guard" to be misclassified as rate-limited.
 * Fix: removed those two bare phrases; all precise API/CLI signatures retained.
 *
 * This file uses the real fs (no mock) because detectRateLimitInLog reads
 * a real file path. Tests write content to a temp dir and clean up after.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { detectRateLimitInLog } from '../../../src/hooks/hook-crash-alert.js';

describe('detectRateLimitInLog — false-positive guard (prose titles must NOT match)', () => {
  let tmp: string;
  let logPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ratelimit-hook-fp-'));
    logPath = join(tmp, 'stdout.log');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('does NOT classify "Reverted comms-check Step 0 Rate Limit Guard" as rate-limited', () => {
    writeFileSync(logPath, 'Reverted comms-check Step 0 Rate Limit Guard\n', 'utf-8');
    expect(detectRateLimitInLog(logPath)).toBe(false);
  });

  it('does NOT classify "crash loop caused by rate limiting" as rate-limited', () => {
    writeFileSync(logPath, 'Diagnosed and fixed comms-check worker crash loop caused by rate limiting\n', 'utf-8');
    expect(detectRateLimitInLog(logPath)).toBe(false);
  });

  it('does NOT classify "Comms-check worker crash loop (rate limit) investigation" as rate-limited', () => {
    writeFileSync(logPath, 'Comms-check worker crash loop (rate limit) investigation\n', 'utf-8');
    expect(detectRateLimitInLog(logPath)).toBe(false);
  });
});

describe('detectRateLimitInLog — true-positive guard (real API/CLI signatures must STILL match)', () => {
  let tmp: string;
  let logPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ratelimit-hook-tp-'));
    logPath = join(tmp, 'stdout.log');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('DOES classify a log containing "rate_limit_error" as rate-limited', () => {
    writeFileSync(logPath, 'API Error: rate_limit_error: too many tokens\n', 'utf-8');
    expect(detectRateLimitInLog(logPath)).toBe(true);
  });

  it('DOES classify a log containing "overloaded_error" as rate-limited', () => {
    writeFileSync(logPath, 'API Error: overloaded_error: system overloaded\n', 'utf-8');
    expect(detectRateLimitInLog(logPath)).toBe(true);
  });

  it('DOES classify "Claude usage limit reached" as rate-limited', () => {
    writeFileSync(logPath, 'Claude usage limit reached. Please upgrade your plan.\n', 'utf-8');
    expect(detectRateLimitInLog(logPath)).toBe(true);
  });

  it('DOES classify "reached your weekly limit" as rate-limited', () => {
    writeFileSync(logPath, "You've reached your weekly limit. Resets Monday.\n", 'utf-8');
    expect(detectRateLimitInLog(logPath)).toBe(true);
  });

  it('DOES classify "used 95% of your limit" as rate-limited', () => {
    writeFileSync(logPath, "You've used 95% of your limit for this week.\n", 'utf-8');
    expect(detectRateLimitInLog(logPath)).toBe(true);
  });

  it('returns false when log file does not exist', () => {
    expect(detectRateLimitInLog(join(tmp, 'nonexistent.log'))).toBe(false);
  });
});
