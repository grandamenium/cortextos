import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Create temp dirs and pin CTX_ROOT / CTX_FRAMEWORK_ROOT BEFORE modules load,
// so config.ts evaluates against the isolated dirs (mirrors sync.test.ts).
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-root-'));
const tmpFramework = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-fw-'));
process.env.CTX_ROOT = tmpRoot;
process.env.CTX_FRAMEWORK_ROOT = tmpFramework;
// Ensure no leftover env override from the host shell.
delete process.env.CTX_VAULT_PATH;

// Every mkdtemp dir created by a test is tracked here and removed in afterAll
// (council: mmax medium — temp-dir leak across repeated test runs).
const tmpDirs: string[] = [tmpRoot, tmpFramework];
function trackedTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

let getVaultRoot: typeof import('../vault')['getVaultRoot'];
let PARA_DIRS: typeof import('../vault')['PARA_DIRS'];
let CTX_ROOT: string;

beforeAll(async () => {
  const vaultMod = await import('../vault');
  getVaultRoot = vaultMod.getVaultRoot;
  PARA_DIRS = vaultMod.PARA_DIRS;

  const configMod = await import('../config');
  CTX_ROOT = configMod.CTX_ROOT;

  // Guard: if a prior suite loaded config.ts with a different CTX_ROOT, the
  // cached module would point elsewhere and these assertions would be bogus.
  expect(CTX_ROOT).toBe(tmpRoot);
});

afterEach(() => {
  delete process.env.CTX_VAULT_PATH;
});

afterAll(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Provision an org dir under CTX_ROOT (what `cortextos init` does — context.json
// etc. omitted; only the directory's existence matters to getVaultRoot).
function provisionOrg(org: string): void {
  fs.mkdirSync(path.join(tmpRoot, 'orgs', org), { recursive: true });
}

// Write a knowledge.md under the framework root for `org`.
function writeKnowledge(org: string, body: string): void {
  const dir = path.join(tmpFramework, 'orgs', org);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'knowledge.md'), body);
}

describe('getVaultRoot resolution order', () => {
  it('creates $CTX_ROOT/orgs/<org>/vault + PARA skeleton for a provisioned org (fresh install, #41)', () => {
    const org = 'sondre-hq'; // the wiki's default org — provisioned but vault-less on a fresh install
    provisionOrg(org);
    const expected = path.join(tmpRoot, 'orgs', org, 'vault');

    // Fresh install: org dir exists, vault dir does not.
    expect(fs.existsSync(expected)).toBe(false);

    const result = getVaultRoot(org);
    expect(result).toBe(expected);

    // Vault root and every PARA dir must now exist.
    expect(fs.existsSync(expected)).toBe(true);
    for (const dir of PARA_DIRS) {
      expect(fs.statSync(path.join(expected, dir)).isDirectory()).toBe(true);
    }
  });

  it('returns null for an unprovisioned org and creates nothing (GET must not spray dirs)', () => {
    const org = 'never-provisioned-org';

    const result = getVaultRoot(org);
    expect(result).toBeNull();
    // Nothing may have been created for it.
    expect(fs.existsSync(path.join(tmpRoot, 'orgs', org))).toBe(false);
  });

  it('handles org names with hyphens and underscores (parity with dashboard VALID_NAME)', () => {
    for (const org of ['my-multi-word-org', 'org_with_underscores', 'mixed-org_name1']) {
      provisionOrg(org);
      const expected = path.join(tmpRoot, 'orgs', org, 'vault');
      expect(getVaultRoot(org)).toBe(expected);
      for (const dir of PARA_DIRS) {
        expect(fs.statSync(path.join(expected, dir)).isDirectory()).toBe(true);
      }
    }
  });

  it('is idempotent / safe to call repeatedly (concurrent races)', () => {
    const org = 'repeat-org';
    provisionOrg(org);
    const first = getVaultRoot(org);
    const second = getVaultRoot(org);
    expect(first).toBe(second);
    expect(first).not.toBeNull();
    // The vault and all PARA dirs exist after repeated calls (real creation,
    // not a vacuous null === null).
    expect(fs.existsSync(first as string)).toBe(true);
    for (const dir of PARA_DIRS) {
      expect(fs.statSync(path.join(first as string, dir)).isDirectory()).toBe(true);
    }
  });

  it('returns null when the default vault path is obstructed by a regular file', () => {
    const org = 'obstructed-org';
    provisionOrg(org);
    // Squat a regular file where the vault dir would go.
    fs.writeFileSync(path.join(tmpRoot, 'orgs', org, 'vault'), 'not a directory');

    expect(getVaultRoot(org)).toBeNull();
    // Still a file — nothing replaced or deleted it.
    expect(fs.statSync(path.join(tmpRoot, 'orgs', org, 'vault')).isFile()).toBe(true);
  });

  it('prefers CTX_VAULT_PATH env override and does NOT write into it (user-managed)', () => {
    const override = trackedTmpDir('vault-override-');
    process.env.CTX_VAULT_PATH = override;

    const result = getVaultRoot('override-org');
    expect(result).toBe(override);
    // User-managed vault: the dashboard must not create PARA dirs inside it.
    for (const dir of PARA_DIRS) {
      expect(fs.existsSync(path.join(override, dir))).toBe(false);
    }
    // The default CTX_ROOT vault for this org must NOT be created either.
    expect(fs.existsSync(path.join(tmpRoot, 'orgs', 'override-org', 'vault'))).toBe(false);
  });

  it('ignores CTX_VAULT_PATH when it does not exist and falls through to default', () => {
    process.env.CTX_VAULT_PATH = path.join(tmpRoot, 'does-not-exist');

    const org = 'env-miss-org';
    provisionOrg(org);
    const result = getVaultRoot(org);
    expect(result).toBe(path.join(tmpRoot, 'orgs', org, 'vault'));
  });

  it('honours a backtick-wrapped Obsidian vault path declared in knowledge.md and does NOT write into it', () => {
    const org = 'kb-backtick-org';
    const declaredVault = trackedTmpDir('vault-kb-');
    writeKnowledge(org, `# Knowledge\n\nObsidian vault lives at \`${declaredVault}/\`\n`);

    const result = getVaultRoot(org);
    expect(result).toBe(declaredVault);
    // User-managed vault: no PARA dirs created inside it.
    for (const dir of PARA_DIRS) {
      expect(fs.existsSync(path.join(declaredVault, dir))).toBe(false);
    }
    // CTX_ROOT default for this org must not have been created.
    expect(fs.existsSync(path.join(tmpRoot, 'orgs', org, 'vault'))).toBe(false);
  });

  it('honours a plain (no-backtick) Obsidian vault declaration in knowledge.md', () => {
    const org = 'kb-plain-org';
    const declaredVault = trackedTmpDir('vault-plain-');
    writeKnowledge(org, `# Knowledge\n\nObsidian vault: ${declaredVault}\n`);

    const result = getVaultRoot(org);
    expect(result).toBe(declaredVault);
  });

  it('strips trailing sentence punctuation from a plain knowledge.md declaration', () => {
    const org = 'kb-prose-org';
    const declaredVault = trackedTmpDir('vault-prose-');
    // Prose form with a trailing period — the captured path must not include it.
    writeKnowledge(org, `# Knowledge\n\nThe Obsidian vault is at ${declaredVault}.\n`);

    const result = getVaultRoot(org);
    expect(result).toBe(declaredVault);
  });

  it('falls through to the default when knowledge.md has no Obsidian vault line', () => {
    const org = 'kb-empty-org';
    provisionOrg(org);
    // Template-style knowledge.md with no vault declaration (the bug scenario).
    writeKnowledge(org, '# Knowledge\n\nTODO\n');

    const result = getVaultRoot(org);
    expect(result).toBe(path.join(tmpRoot, 'orgs', org, 'vault'));
    expect(result).not.toBeNull();
    expect(fs.existsSync(result as string)).toBe(true);
  });

  it('falls through to the default when knowledge.md is empty or whitespace-only', () => {
    const org = 'kb-blank-org';
    provisionOrg(org);
    writeKnowledge(org, '   \n\n  ');

    const result = getVaultRoot(org);
    expect(result).toBe(path.join(tmpRoot, 'orgs', org, 'vault'));
  });

  it('falls through to the default when the declared knowledge.md vault does not exist', () => {
    const org = 'kb-stale-org';
    provisionOrg(org);
    writeKnowledge(org, '# Knowledge\n\nObsidian vault: `/no/such/vault`\n');

    const result = getVaultRoot(org);
    expect(result).toBe(path.join(tmpRoot, 'orgs', org, 'vault'));
    // The stale declared path must not have been created.
    expect(fs.existsSync('/no/such/vault')).toBe(false);
  });

  it('returns null for an invalid org name (path-traversal guard)', () => {
    expect(getVaultRoot('../escape')).toBeNull();
    expect(getVaultRoot('has/slash')).toBeNull();
    expect(getVaultRoot('UPPER')).toBeNull();
    expect(getVaultRoot('')).toBeNull();
    // No stray vault dir created for a rejected name.
    expect(fs.existsSync(path.join(tmpRoot, 'orgs', 'UPPER', 'vault'))).toBe(false);
  });
});
