/**
 * vault-getvaultroot.test.ts — getVaultRoot() org→vault resolution.
 *
 * Covers the per-org vault-path config field: getVaultRoot() prefers
 * orgs/<org>/context.json { "vaultPath": "…" } and falls back to the legacy
 * "Obsidian vault" prose line in knowledge.md when the field is absent or
 * points at an invalid path.
 *
 * Coverage:
 *   - context.json vaultPath is preferred when it points at a real dir
 *   - absent vaultPath falls back to the knowledge.md regex
 *   - a configured-but-invalid vaultPath falls through to the regex
 *
 * CTX_FRAMEWORK_ROOT is a module-load const in config.ts, so we set it in
 * beforeAll and import vault.ts dynamically afterwards.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = path.join(os.tmpdir(), `vaultroot-test-${process.pid}`);
const fw = path.join(tmp, 'fw');
// Vault dirs must END in "vault" — the fallback regex captures `…vault/?`.
const vaultCfg = path.join(tmp, 'orgA', 'vault');
const vaultKnow = path.join(tmp, 'orgB', 'vault');

function makeVault(dir: string) {
  fs.mkdirSync(path.join(dir, '00-inbox'), { recursive: true });
}

function writeOrg(org: string, context: object, knowledge?: string) {
  const dir = path.join(fw, 'orgs', org);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'context.json'), JSON.stringify(context));
  if (knowledge !== undefined) {
    fs.writeFileSync(path.join(dir, 'knowledge.md'), knowledge);
  }
}

describe('getVaultRoot() per-org vault-path resolution', () => {
  beforeAll(() => {
    makeVault(vaultCfg);
    makeVault(vaultKnow);
    // org1: context.json vaultPath -> real dir (config-first wins)
    writeOrg('org1', { vaultPath: vaultCfg });
    // org2: no vaultPath, knowledge.md manifest -> fallback
    writeOrg('org2', { name: 'org2' }, `## Wiki\n- Obsidian vault: \`${vaultKnow}\`\n`);
    // org3: vaultPath -> nonexistent, knowledge.md manifest -> fall through to regex
    writeOrg(
      'org3',
      { vaultPath: path.join(tmp, 'nope', 'vault') },
      `## Wiki\n- Obsidian vault: \`${vaultKnow}\`\n`,
    );
    process.env.CTX_FRAMEWORK_ROOT = fw;
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('prefers context.json vaultPath when it points at a real directory', async () => {
    const { getVaultRoot } = await import('../vault');
    expect(getVaultRoot('org1')).toBe(vaultCfg);
  });

  it('falls back to the knowledge.md regex when vaultPath is absent', async () => {
    const { getVaultRoot } = await import('../vault');
    expect(getVaultRoot('org2')).toBe(vaultKnow);
  });

  it('falls through to the knowledge.md regex when configured vaultPath is invalid', async () => {
    const { getVaultRoot } = await import('../vault');
    expect(getVaultRoot('org3')).toBe(vaultKnow);
  });
});
