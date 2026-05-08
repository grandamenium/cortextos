/**
 * BL-2026-05-08-003 phase 1 — profile registry loader.
 *
 * Tests the small loader/resolver in `src/utils/profiles.ts`. The
 * spawn path uses these to set CLAUDE_CONFIG_DIR per-agent; doctor
 * uses them for fleet-boot validation. Failure modes here = silent
 * agent misconfiguration in production, so the parse path is paranoid
 * about shape and tested for each return-null branch.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  loadProfileRegistry,
  resolveProfile,
  findDanglingReferences,
} from '../../../src/utils/profiles';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'profiles-test-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function writeRegistry(org: string, contents: string): void {
  const dir = join(tmpRoot, 'orgs', org);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'profiles.json'), contents, 'utf-8');
}

describe('loadProfileRegistry', () => {
  it('returns null when profiles.json does not exist', () => {
    const r = loadProfileRegistry(tmpRoot, 'absent-org');
    expect(r).toBeNull();
  });

  it('returns null on malformed JSON (parse error)', () => {
    writeRegistry('acme', '{ this is not json');
    expect(loadProfileRegistry(tmpRoot, 'acme')).toBeNull();
  });

  it('returns null when default_profile is missing or non-string', () => {
    writeRegistry('acme', JSON.stringify({ profiles: { x: { config_dir: '/a' } } }));
    expect(loadProfileRegistry(tmpRoot, 'acme')).toBeNull();
  });

  it('returns null when profiles map is missing', () => {
    writeRegistry('acme', JSON.stringify({ default_profile: 'x' }));
    expect(loadProfileRegistry(tmpRoot, 'acme')).toBeNull();
  });

  it('parses a well-formed registry', () => {
    writeRegistry('acme', JSON.stringify({
      default_profile: 'personal',
      profiles: {
        personal: { config_dir: '/Users/x/.claude' },
        work: { config_dir: '/Users/x/.claude-work' },
      },
    }));
    const r = loadProfileRegistry(tmpRoot, 'acme');
    expect(r).not.toBeNull();
    expect(r!.default_profile).toBe('personal');
    expect(r!.profiles.personal.config_dir).toBe('/Users/x/.claude');
    expect(r!.profiles.work.config_dir).toBe('/Users/x/.claude-work');
  });

  it('drops profile entries with missing or non-string config_dir', () => {
    writeRegistry('acme', JSON.stringify({
      default_profile: 'personal',
      profiles: {
        personal: { config_dir: '/Users/x/.claude' },
        broken: { not_config_dir: 'oops' },
        nullish: { config_dir: null },
      },
    }));
    const r = loadProfileRegistry(tmpRoot, 'acme')!;
    expect(Object.keys(r.profiles).sort()).toEqual(['personal']);
  });

  it('passes through a known failback_policy value', () => {
    writeRegistry('acme', JSON.stringify({
      default_profile: 'p',
      profiles: { p: { config_dir: '/x' } },
      failback_policy: 'auto',
    }));
    expect(loadProfileRegistry(tmpRoot, 'acme')!.failback_policy).toBe('auto');
  });

  it('drops an unknown failback_policy value (defensive)', () => {
    writeRegistry('acme', JSON.stringify({
      default_profile: 'p',
      profiles: { p: { config_dir: '/x' } },
      failback_policy: 'invalid',
    }));
    const r = loadProfileRegistry(tmpRoot, 'acme')!;
    expect(r.failback_policy).toBeUndefined();
  });
});

describe('resolveProfile', () => {
  const registry = {
    default_profile: 'personal',
    profiles: {
      personal: { config_dir: '/p' },
      work: { config_dir: '/w' },
    },
  };

  it('returns the named profile when present', () => {
    expect(resolveProfile(registry, 'work')!.config_dir).toBe('/w');
  });

  it('returns null when the named profile is absent (caller decides fallback)', () => {
    // Important: do NOT silently fall back to default. The caller can
    // still resolve(registry, undefined) if they want the default —
    // explicitly-asked-for-X-and-got-null is a distinct failure mode.
    expect(resolveProfile(registry, 'nonexistent')).toBeNull();
  });

  it('returns the default profile when name is omitted', () => {
    expect(resolveProfile(registry)!.config_dir).toBe('/p');
  });

  it('returns null when default_profile is itself dangling', () => {
    expect(resolveProfile({ default_profile: 'gone', profiles: {} })).toBeNull();
  });
});

describe('findDanglingReferences', () => {
  const registry = {
    default_profile: 'personal',
    profiles: {
      personal: { config_dir: '/p' },
      work: { config_dir: '/w' },
    },
  };

  it('returns [] when default + all referenced profiles resolve', () => {
    expect(findDanglingReferences(registry, ['personal', 'work'])).toEqual([]);
  });

  it('flags a dangling default_profile', () => {
    expect(findDanglingReferences({ default_profile: 'gone', profiles: {} }, []))
      .toEqual(['gone']);
  });

  it('flags a dangling per-agent reference', () => {
    expect(findDanglingReferences(registry, ['personal', 'enterprise']))
      .toEqual(['enterprise']);
  });

  it('does not double-list the same dangling name', () => {
    // If two agents both reference the same missing profile, surface
    // it once — the operator only needs to fix one config entry.
    expect(findDanglingReferences(registry, ['enterprise', 'enterprise']))
      .toEqual(['enterprise']);
  });
});
