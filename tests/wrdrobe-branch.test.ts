import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  isValidBranchName,
  setWrdrobeBranch,
} from '../src/bus/wrdrobe-branch.js';

describe('wrdrobe-branch: isValidBranchName', () => {
  it('accepts simple names', () => {
    expect(isValidBranchName('main')).toBe(true);
    expect(isValidBranchName('agent/wrdrobe-dev/foo')).toBe(true);
    expect(isValidBranchName('release-1.2.3')).toBe(true);
    expect(isValidBranchName('feature/x_y-z')).toBe(true);
  });

  it('rejects empty / over-long / dash-prefixed', () => {
    expect(isValidBranchName('')).toBe(false);
    expect(isValidBranchName('-rf')).toBe(false);
    expect(isValidBranchName('a'.repeat(256))).toBe(false);
  });

  it("rejects '..' path-traversal", () => {
    expect(isValidBranchName('foo/../bar')).toBe(false);
    expect(isValidBranchName('..')).toBe(false);
  });

  it('rejects characters outside [A-Za-z0-9._/-]', () => {
    expect(isValidBranchName('has space')).toBe(false);
    expect(isValidBranchName('foo;rm -rf /')).toBe(false);
    expect(isValidBranchName('foo$bar')).toBe(false);
    expect(isValidBranchName('foo\nbar')).toBe(false);
  });
});

describe('wrdrobe-branch: setWrdrobeBranch', () => {
  const testDir = join(tmpdir(), `cortextos-wrdrobe-branch-${Date.now()}`);
  let confPath: string;
  const alwaysExists = () => true;
  const neverExists = () => false;

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    confPath = join(testDir, 'wrdrobe-branch.conf');
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('throws on invalid branch name without touching the conf file', () => {
    expect(() =>
      setWrdrobeBranch('bad..name', {
        confPath,
        repoUrl: 'stub://',
        branchExists: alwaysExists,
      }),
    ).toThrow(/Invalid branch name/);
    expect(existsSync(confPath)).toBe(false);
  });

  it('throws when the branch is not on the remote', () => {
    expect(() =>
      setWrdrobeBranch('typo-branch', {
        confPath,
        repoUrl: 'stub://',
        branchExists: neverExists,
      }),
    ).toThrow(/not found on remote/);
    expect(existsSync(confPath)).toBe(false);
  });

  it('writes the branch on first call and reports change with from=null', () => {
    const result = setWrdrobeBranch('main', {
      confPath,
      repoUrl: 'stub://',
      branchExists: alwaysExists,
    });
    expect(result).toEqual({ kind: 'changed', from: null, to: 'main' });
    expect(readFileSync(confPath, 'utf-8')).toBe('main\n');
  });

  it('is idempotent when the conf already names the requested branch', () => {
    writeFileSync(confPath, 'main\n', 'utf-8');
    const result = setWrdrobeBranch('main', {
      confPath,
      repoUrl: 'stub://',
      branchExists: alwaysExists,
    });
    expect(result).toEqual({ kind: 'noop', branch: 'main' });
    expect(readFileSync(confPath, 'utf-8')).toBe('main\n');
  });

  it('reports the prior branch on a real switch', () => {
    writeFileSync(confPath, 'old-branch\n', 'utf-8');
    const result = setWrdrobeBranch('agent/wrdrobe-dev/x', {
      confPath,
      repoUrl: 'stub://',
      branchExists: alwaysExists,
    });
    expect(result).toEqual({
      kind: 'changed',
      from: 'old-branch',
      to: 'agent/wrdrobe-dev/x',
    });
    expect(readFileSync(confPath, 'utf-8')).toBe('agent/wrdrobe-dev/x\n');
  });
});
