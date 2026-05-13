import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { checkUpstream } from '../../../src/bus/metrics';

function exec(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: 'pipe' });
}

function setupUpstream(base: string): string {
  const upstreamDir = join(base, 'upstream');
  mkdirSync(upstreamDir, { recursive: true });
  exec('git init', upstreamDir);
  exec('git config user.email "t@t.com"', upstreamDir);
  exec('git config user.name "Test"', upstreamDir);
  writeFileSync(join(upstreamDir, 'README.md'), '# Upstream\n');
  exec('git add README.md', upstreamDir);
  exec('git commit -m "init"', upstreamDir);
  // Ensure branch is named 'main' regardless of git default
  exec('git branch -M main', upstreamDir);
  return upstreamDir;
}

function setupLocal(base: string, upstreamDir: string): string {
  const localDir = join(base, 'local');
  mkdirSync(localDir, { recursive: true });
  exec('git init', localDir);
  exec('git config user.email "t@t.com"', localDir);
  exec('git config user.name "Test"', localDir);
  exec(`git remote add upstream ${upstreamDir}`, localDir);
  exec('git fetch upstream main', localDir);
  exec('git checkout -b main upstream/main', localDir);
  return localDir;
}

function addUpstreamCommit(
  upstreamDir: string,
  relpath: string,
  content: string,
  message: string,
): void {
  const fullPath = join(upstreamDir, relpath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
  exec('git add .', upstreamDir);
  exec(`git commit -m "${message}"`, upstreamDir);
}

describe('checkUpstream', () => {
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'ctx-checkupstream-'));
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
    delete process.env['CORTEXTOS_CONFIRM_UPSTREAM_MERGE'];
  });

  it('returns error when directory is not a git repository', () => {
    const dir = join(tmpBase, 'plain');
    mkdirSync(dir);
    expect(checkUpstream(dir)).toEqual({ status: 'error', error: 'not a git repository' });
  });

  it('returns error with hint when no upstream remote is configured', () => {
    const dir = join(tmpBase, 'noremote');
    mkdirSync(dir);
    exec('git init', dir);
    exec('git config user.email "t@t.com"', dir);
    exec('git config user.name "Test"', dir);
    const result = checkUpstream(dir);
    expect(result.status).toBe('error');
    expect(result.error).toBe('no upstream remote configured');
    expect(result.hint).toContain('git remote add upstream');
  });

  it('returns error with hint when fetch fails (non-existent upstream path)', () => {
    const dir = join(tmpBase, 'badfetch');
    mkdirSync(dir);
    exec('git init', dir);
    exec('git config user.email "t@t.com"', dir);
    exec('git config user.name "Test"', dir);
    exec('git remote add upstream /nonexistent/does-not-exist', dir);
    const result = checkUpstream(dir);
    expect(result.status).toBe('error');
    expect(result.error).toBe('failed to fetch upstream');
    expect(result.hint).toContain('Check network');
  });

  it('returns up_to_date when local HEAD matches upstream/main', () => {
    const upstreamDir = setupUpstream(tmpBase);
    const localDir = setupLocal(tmpBase, upstreamDir);
    const result = checkUpstream(localDir);
    expect(result.status).toBe('up_to_date');
    expect(result.message).toBe('No upstream changes available');
  });

  it('returns updates_available with commit count when upstream has new commits', () => {
    const upstreamDir = setupUpstream(tmpBase);
    const localDir = setupLocal(tmpBase, upstreamDir);
    addUpstreamCommit(upstreamDir, 'new-feature.ts', 'export const x = 1;\n', 'feat: new feature');
    const result = checkUpstream(localDir);
    expect(result.status).toBe('updates_available');
    expect(result.commits).toBe(1);
    expect(result.commit_log).toContain('feat: new feature');
  });

  it('categorizes changed files into bus/scripts/templates/other buckets', () => {
    const upstreamDir = setupUpstream(tmpBase);
    const localDir = setupLocal(tmpBase, upstreamDir);
    // Add files in distinct categories
    addUpstreamCommit(upstreamDir, 'bus/new-module.ts', 'export {};\n', 'feat: bus module');
    const result = checkUpstream(localDir);
    expect(result.status).toBe('updates_available');
    expect(result.changes?.bus).toContain('bus/new-module.ts');
    // README.md is shared in both histories — only the new file appears in the diff
    expect(result.changes?.other).toHaveLength(0);
  });

  it('returns error when apply is true but CORTEXTOS_CONFIRM_UPSTREAM_MERGE is not set', () => {
    const upstreamDir = setupUpstream(tmpBase);
    const localDir = setupLocal(tmpBase, upstreamDir);
    addUpstreamCommit(upstreamDir, 'new.ts', 'export {};\n', 'feat: new');
    const result = checkUpstream(localDir, { apply: true });
    expect(result.status).toBe('error');
    expect(result.error).toContain('CORTEXTOS_CONFIRM_UPSTREAM_MERGE');
  });

  it('returns merged status when apply is true and CORTEXTOS_CONFIRM_UPSTREAM_MERGE=yes', () => {
    const upstreamDir = setupUpstream(tmpBase);
    const localDir = setupLocal(tmpBase, upstreamDir);
    addUpstreamCommit(upstreamDir, 'new.ts', 'export {};\n', 'feat: new');
    process.env['CORTEXTOS_CONFIRM_UPSTREAM_MERGE'] = 'yes';
    const result = checkUpstream(localDir, { apply: true });
    expect(result.status).toBe('merged');
    expect(result.commits).toBe(1);
    expect(result.message).toContain('applied successfully');
  });
});
