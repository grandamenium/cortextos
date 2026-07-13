import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  getConfiguredVaultPath,
  getVaultRoot,
  getVaultStatus,
  resolveVaultPath,
} from '../vault';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('vault configuration', () => {
  it('reports not configured when CTX_VAULT_PATH is unset', () => {
    vi.stubEnv('CTX_VAULT_PATH', '');

    expect(getConfiguredVaultPath()).toBeNull();
    expect(getVaultRoot()).toBeNull();
    expect(getVaultStatus()).toEqual({ state: 'not-configured' });
  });

  it('uses only the configured member vault path when it exists', () => {
    const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'member-vault-'));
    vi.stubEnv('CTX_VAULT_PATH', vaultRoot);

    expect(getConfiguredVaultPath()).toBe(path.resolve(vaultRoot));
    expect(getVaultRoot()).toBe(path.resolve(vaultRoot));
    expect(getVaultStatus()).toEqual({ state: 'ready', root: path.resolve(vaultRoot) });
  });

  it('reports a clear missing state for a configured nonexistent path', () => {
    const missing = path.join(os.tmpdir(), `missing-vault-${Date.now()}`);
    vi.stubEnv('CTX_VAULT_PATH', missing);

    expect(getVaultRoot()).toBeNull();
    expect(getVaultStatus()).toEqual({
      state: 'missing',
      configuredPath: path.resolve(missing),
    });
  });
});

describe('resolveVaultPath', () => {
  it('allows notes inside PARA dirs', () => {
    const vaultRoot = path.join(os.tmpdir(), 'vault');

    expect(resolveVaultPath(vaultRoot, '00-inbox/today.md')).toBe(
      path.join(vaultRoot, '00-inbox', 'today.md'),
    );
  });

  it('rejects traversal and non-PARA paths', () => {
    const vaultRoot = path.join(os.tmpdir(), 'vault');

    expect(resolveVaultPath(vaultRoot, '../secret.md')).toBeNull();
    expect(resolveVaultPath(vaultRoot, '00-inbox/../secret.md')).toBeNull();
    expect(resolveVaultPath(vaultRoot, 'private/secret.md')).toBeNull();
  });
});
