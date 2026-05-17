/**
 * tests/unit/cli/spawn-claim-ttl.test.ts — TTL parser contract tests.
 *
 * Covers the CLI-layer enforcement of direct-spawn rule G1: default 30 min
 * (1800s), hard ceiling 60 min (3600s). Added per Sam HOLD verdict 2026-05-17
 * BLOCK 1 — the original `> 0` check let multi-day TTLs through.
 *
 * Three-layer cap (SQL fn raise / table CHECK / CLI parseTtl / coordinator
 * default) is intentional — each enforces independently so a misconfigured
 * caller hits a clear error before the malformed value reaches the DB.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseTtl, TTL_DEFAULT, TTL_HARD_CEILING } from '../../../src/cli/bus';

describe('parseTtl (CLI TTL contract)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // process.exit -> throw so we can assert it was called without killing
    // the test runner. Cast to never to satisfy the original signature.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('exposes G1 contract constants: default 1800, ceiling 3600', () => {
    expect(TTL_DEFAULT).toBe(1800);
    expect(TTL_HARD_CEILING).toBe(3600);
  });

  it('returns TTL_DEFAULT (1800) when raw is undefined', () => {
    expect(parseTtl(undefined)).toBe(1800);
  });

  it('parses a valid in-range integer', () => {
    expect(parseTtl('60')).toBe(60);
    expect(parseTtl('1800')).toBe(1800);
    expect(parseTtl('3599')).toBe(3599);
  });

  it('accepts the boundary value 3600 (== hard ceiling)', () => {
    expect(parseTtl('3600')).toBe(3600);
  });

  it('rejects 0 (must be positive)', () => {
    expect(() => parseTtl('0')).toThrow(/process\.exit\(1\)/);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/positive integer/));
  });

  it('rejects negative values', () => {
    expect(() => parseTtl('-5')).toThrow(/process\.exit\(1\)/);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/positive integer/));
  });

  it('rejects non-integer / non-numeric strings', () => {
    expect(() => parseTtl('abc')).toThrow(/process\.exit\(1\)/);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/positive integer/));
  });

  it('rejects 3601 (one over hard ceiling)', () => {
    expect(() => parseTtl('3601')).toThrow(/process\.exit\(1\)/);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/exceeds hard ceiling 3600s/));
  });

  it('rejects very large values (multi-day TTL)', () => {
    expect(() => parseTtl('86400')).toThrow(/process\.exit\(1\)/);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/exceeds hard ceiling/));
  });

  it('uses the provided flag name in error messages', () => {
    expect(() => parseTtl('99999', '--lease-ttl')).toThrow();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/--lease-ttl '99999'/),
    );
  });
});
