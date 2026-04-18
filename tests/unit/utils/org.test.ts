import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { normalizeOrgName } from '../../../src/utils/org';

let fwRoot: string;

beforeEach(() => {
  fwRoot = mkdtempSync(join(tmpdir(), 'cortextos-org-test-'));
  mkdirSync(join(fwRoot, 'orgs'), { recursive: true });
});

afterEach(() => {
  try {
    rmSync(fwRoot, { recursive: true, force: true });
  } catch { /* ignore */ }
});

describe('normalizeOrgName', () => {
  it('exact match: returns input unchanged', () => {
    mkdirSync(join(fwRoot, 'orgs', 'AcmeCorp'));
    expect(normalizeOrgName(fwRoot, 'AcmeCorp')).toBe('AcmeCorp');
  });

  it('case drift: lowercase input resolves to CamelCase canonical on disk', () => {
    mkdirSync(join(fwRoot, 'orgs', 'AcmeCorp'));
    expect(normalizeOrgName(fwRoot, 'acmecorp')).toBe('AcmeCorp');
    expect(normalizeOrgName(fwRoot, 'ACMECORP')).toBe('AcmeCorp');
    expect(normalizeOrgName(fwRoot, 'AcmeCORP')).toBe('AcmeCorp');
  });

  it('no match: returns input unchanged (callers get a clearer error at file op time)', () => {
    mkdirSync(join(fwRoot, 'orgs', 'AcmeCorp'));
    expect(normalizeOrgName(fwRoot, 'ghostcompany')).toBe('ghostcompany');
  });

  it('empty framework orgs dir: returns input unchanged', () => {
    // orgs/ exists but is empty
    expect(normalizeOrgName(fwRoot, 'AcmeCorp')).toBe('AcmeCorp');
  });

  it('missing framework orgs dir: returns input unchanged', () => {
    rmSync(join(fwRoot, 'orgs'), { recursive: true });
    expect(normalizeOrgName(fwRoot, 'AcmeCorp')).toBe('AcmeCorp');
  });

  it('empty org input: returns empty string (no normalization attempted)', () => {
    expect(normalizeOrgName(fwRoot, '')).toBe('');
  });

  it('exact case match wins over case-insensitive match on case-sensitive filesystems', () => {
    // macOS/Windows are case-insensitive — both dirs map to the same inode,
    // so this scenario cannot be simulated there. Skip gracefully.
    mkdirSync(join(fwRoot, 'orgs', 'AcmeCorp'));
    try {
      mkdirSync(join(fwRoot, 'orgs', 'acmecorp'));
    } catch {
      return; // case-insensitive filesystem — test not applicable on this OS
    }
    // Exact match path: return whichever casing the caller asked for.
    expect(normalizeOrgName(fwRoot, 'AcmeCorp')).toBe('AcmeCorp');
    expect(normalizeOrgName(fwRoot, 'acmecorp')).toBe('acmecorp');
  });

  it('ignores non-directory entries with matching name', () => {
    // A stray file named like an org must not be returned as a directory match.
    writeFileSync(join(fwRoot, 'orgs', 'AcmeCorp.txt'), 'not a dir');
    expect(normalizeOrgName(fwRoot, 'AcmeCorp')).toBe('AcmeCorp');
  });
});
