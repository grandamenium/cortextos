/**
 * Tests for `seedTrustDialog` — the pre-spawn helper that writes
 * `hasTrustDialogAccepted: true` into `<CLAUDE_CONFIG_DIR>/.claude.json`
 * so headless agents don't wedge on the workspace-trust prompt.
 *
 * Behavioural invariants this suite locks in (per the deep-eval
 * punch list): create-when-absent, preserve-siblings, idempotent
 * early-return-when-true, silent-no-op on malformed JSON, and
 * recovery from `projects` field present but not an object.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { seedTrustDialog } from '../../../src/utils/claude-config';

let tmpRoot: string;
let claudeJsonPath: string;
const CWD = '/Volumes/MacStorage/agents/test-agent';

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'claude-config-test-'));
  claudeJsonPath = join(tmpRoot, '.claude.json');
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('seedTrustDialog', () => {
  it('creates a fresh .claude.json with the seeded entry when the file is absent', () => {
    expect(existsSync(claudeJsonPath)).toBe(false);
    seedTrustDialog(claudeJsonPath, CWD);
    expect(existsSync(claudeJsonPath)).toBe(true);
    const obj = JSON.parse(readFileSync(claudeJsonPath, 'utf-8'));
    expect(obj.projects[CWD].hasTrustDialogAccepted).toBe(true);
  });

  it('preserves existing top-level fields (oauth, theme, etc.) and unrelated project entries', () => {
    const otherCwd = '/Volumes/other-project';
    const initial = {
      theme: 'dark',
      hasCompletedOnboarding: true,
      oauthAccount: { emailAddress: 'rujen_c@yirifi.com' },
      projects: {
        [otherCwd]: { hasTrustDialogAccepted: true, allowedTools: ['Bash'] },
      },
    };
    writeFileSync(claudeJsonPath, JSON.stringify(initial));

    seedTrustDialog(claudeJsonPath, CWD);

    const obj = JSON.parse(readFileSync(claudeJsonPath, 'utf-8'));
    expect(obj.theme).toBe('dark');
    expect(obj.hasCompletedOnboarding).toBe(true);
    expect(obj.oauthAccount.emailAddress).toBe('rujen_c@yirifi.com');
    expect(obj.projects[otherCwd].hasTrustDialogAccepted).toBe(true);
    expect(obj.projects[otherCwd].allowedTools).toEqual(['Bash']);
    expect(obj.projects[CWD].hasTrustDialogAccepted).toBe(true);
  });

  it('preserves an existing project entry\'s sibling fields when adding hasTrustDialogAccepted', () => {
    const initial = {
      projects: {
        [CWD]: { allowedTools: ['Bash', 'Read'], hasClaudeMdExternalIncludesApproved: false },
      },
    };
    writeFileSync(claudeJsonPath, JSON.stringify(initial));

    seedTrustDialog(claudeJsonPath, CWD);

    const obj = JSON.parse(readFileSync(claudeJsonPath, 'utf-8'));
    expect(obj.projects[CWD].hasTrustDialogAccepted).toBe(true);
    expect(obj.projects[CWD].allowedTools).toEqual(['Bash', 'Read']);
    expect(obj.projects[CWD].hasClaudeMdExternalIncludesApproved).toBe(false);
  });

  it('is a no-op early-return when hasTrustDialogAccepted is already true (does not bump mtime)', () => {
    const initial = {
      theme: 'dark',
      projects: {
        [CWD]: { hasTrustDialogAccepted: true },
      },
    };
    const initialJson = JSON.stringify(initial);
    writeFileSync(claudeJsonPath, initialJson);
    const beforeStat = readFileSync(claudeJsonPath, 'utf-8');

    seedTrustDialog(claudeJsonPath, CWD);

    // File should be byte-identical — no atomic write performed.
    expect(readFileSync(claudeJsonPath, 'utf-8')).toBe(beforeStat);
  });

  it('silently no-ops on malformed JSON and does NOT clobber the file', () => {
    const malformed = '{ not valid json';
    writeFileSync(claudeJsonPath, malformed);

    expect(() => seedTrustDialog(claudeJsonPath, CWD)).not.toThrow();
    // Critical: the malformed file is still on disk untouched.
    // Clobbering would be worse than the runtime trust-dialog fallback.
    expect(readFileSync(claudeJsonPath, 'utf-8')).toBe(malformed);
  });

  it('recovers when projects field exists but is not an object (e.g. operator typed an array)', () => {
    const initial = { theme: 'dark', projects: ['nope'] };
    writeFileSync(claudeJsonPath, JSON.stringify(initial));

    seedTrustDialog(claudeJsonPath, CWD);

    const obj = JSON.parse(readFileSync(claudeJsonPath, 'utf-8'));
    expect(obj.theme).toBe('dark');
    expect(obj.projects[CWD].hasTrustDialogAccepted).toBe(true);
    // The bogus array got replaced by a fresh object map. Operator
    // would have hit other claude-startup failures with the array
    // anyway; better to recover than to abort the seed.
    expect(Array.isArray(obj.projects)).toBe(false);
  });

  it('recovers when the existing project entry value is not an object', () => {
    const initial = { projects: { [CWD]: 'oops' } };
    writeFileSync(claudeJsonPath, JSON.stringify(initial));

    seedTrustDialog(claudeJsonPath, CWD);

    const obj = JSON.parse(readFileSync(claudeJsonPath, 'utf-8'));
    expect(obj.projects[CWD].hasTrustDialogAccepted).toBe(true);
  });

  it('upgrades a false hasTrustDialogAccepted to true (the operator may have rejected once historically)', () => {
    const initial = {
      projects: {
        [CWD]: { hasTrustDialogAccepted: false, allowedTools: ['Bash'] },
      },
    };
    writeFileSync(claudeJsonPath, JSON.stringify(initial));

    seedTrustDialog(claudeJsonPath, CWD);

    const obj = JSON.parse(readFileSync(claudeJsonPath, 'utf-8'));
    expect(obj.projects[CWD].hasTrustDialogAccepted).toBe(true);
    expect(obj.projects[CWD].allowedTools).toEqual(['Bash']);
  });
});
