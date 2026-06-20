import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveVaultRoot, discoverPrimaryOrgIn } from '../../../src/utils/paths';

describe('resolveVaultRoot', () => {
  let root: string;
  const savedVaultEnv = process.env.CTX_VAULT_ROOT;

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ctx-vault-')); delete process.env.CTX_VAULT_ROOT; });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (savedVaultEnv === undefined) delete process.env.CTX_VAULT_ROOT;
    else process.env.CTX_VAULT_ROOT = savedVaultEnv;
  });

  it('prefers the repo-root vault over an empty worktree vault (the deployment bug)', () => {
    // Populated vault at repo root; empty placeholder vault inside the worktree.
    mkdirSync(join(root, 'obsidian-vault', 'agent-shared'), { recursive: true });
    const frameworkRoot = join(root, '.claude', 'worktrees', 'objective-mclaren');
    mkdirSync(join(frameworkRoot, 'obsidian-vault'), { recursive: true }); // empty, no agent-shared
    expect(resolveVaultRoot(frameworkRoot)).toBe(join(root, 'obsidian-vault'));
  });

  it('uses <frameworkRoot>/obsidian-vault when IT has the populated agent-shared', () => {
    const frameworkRoot = join(root, 'fw');
    mkdirSync(join(frameworkRoot, 'obsidian-vault', 'agent-shared'), { recursive: true });
    expect(resolveVaultRoot(frameworkRoot)).toBe(join(frameworkRoot, 'obsidian-vault'));
  });

  it('honors CTX_VAULT_ROOT when it has a populated agent-shared', () => {
    const override = join(root, 'explicit-vault');
    mkdirSync(join(override, 'agent-shared'), { recursive: true });
    process.env.CTX_VAULT_ROOT = override;
    expect(resolveVaultRoot(join(root, 'fw'))).toBe(override);
  });

  it('falls back to the first candidate when none have agent-shared yet', () => {
    const frameworkRoot = join(root, 'fresh');
    expect(resolveVaultRoot(frameworkRoot)).toBe(join(frameworkRoot, 'obsidian-vault'));
  });
});

describe('discoverPrimaryOrgIn', () => {
  let orgsDir: string;
  beforeEach(() => { orgsDir = mkdtempSync(join(tmpdir(), 'ctx-orgs-')); });
  afterEach(() => rmSync(orgsDir, { recursive: true, force: true }));

  it('returns null when the orgs dir is missing or empty', () => {
    expect(discoverPrimaryOrgIn(join(orgsDir, 'nope'))).toBeNull();
    expect(discoverPrimaryOrgIn(orgsDir)).toBeNull();
  });

  it('returns the sole org when exactly one exists', () => {
    mkdirSync(join(orgsDir, 'phytomedic', 'tasks'), { recursive: true });
    expect(discoverPrimaryOrgIn(orgsDir)).toBe('phytomedic');
  });

  it('returns the org with the most tasks when several exist', () => {
    mkdirSync(join(orgsDir, 'small', 'tasks'), { recursive: true });
    mkdirSync(join(orgsDir, 'big', 'tasks'), { recursive: true });
    mkdirSync(join(orgsDir, 'small', 'tasks', 'task_1.json'), { recursive: true });
    mkdirSync(join(orgsDir, 'big', 'tasks', 'task_1.json'), { recursive: true });
    mkdirSync(join(orgsDir, 'big', 'tasks', 'task_2.json'), { recursive: true });
    expect(discoverPrimaryOrgIn(orgsDir)).toBe('big');
  });
});
