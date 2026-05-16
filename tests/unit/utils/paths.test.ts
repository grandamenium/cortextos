import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { isAgentDirScaffolded, resolveAgentCwd } from '../../../src/utils/paths.js';

describe('isAgentDirScaffolded', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-paths-scaffold-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns true when AGENTS.md exists in the dir', () => {
    writeFileSync(join(testDir, 'AGENTS.md'), '# agent');
    expect(isAgentDirScaffolded(testDir)).toBe(true);
  });

  it('returns false when AGENTS.md is missing (bare dir)', () => {
    expect(isAgentDirScaffolded(testDir)).toBe(false);
  });

  it('returns false when the dir itself does not exist', () => {
    const missing = join(testDir, 'never-created');
    expect(isAgentDirScaffolded(missing)).toBe(false);
  });

  it('returns false for undefined input', () => {
    expect(isAgentDirScaffolded(undefined)).toBe(false);
  });
});

describe('resolveAgentCwd', () => {
  let testDir: string;
  let agentDir: string;
  let overrideDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-paths-cwd-'));
    agentDir = join(testDir, 'agent');
    overrideDir = join(testDir, 'override');
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(overrideDir, { recursive: true });
    // Default: agentDir is scaffolded (so it's a valid fallback target).
    writeFileSync(join(agentDir, 'AGENTS.md'), '# agent');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns agentDir when no working_directory override is set', () => {
    expect(resolveAgentCwd(agentDir, undefined)).toBe(agentDir);
    expect(resolveAgentCwd(agentDir, '')).toBe(agentDir);
    expect(resolveAgentCwd(agentDir, '   ')).toBe(agentDir);
  });

  it('honors working_directory when the override dir has AGENTS.md', () => {
    writeFileSync(join(overrideDir, 'AGENTS.md'), '# override');
    expect(resolveAgentCwd(agentDir, overrideDir)).toBe(overrideDir);
  });

  it('falls back to agentDir when working_directory has no AGENTS.md and warns', () => {
    // 2026-05-15 regression: director/analyst config.json pointed at
    // /Users/.../work/team-brain which has its own AGENTS.md for a different
    // system. The override dir not being a scaffolded agent must be treated
    // the same as a typo — fall back, do not silently misroute.
    const warn = vi.fn();
    // overrideDir exists but lacks AGENTS.md
    expect(resolveAgentCwd(agentDir, overrideDir, warn)).toBe(agentDir);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/not a scaffolded agent dir/);
  });

  it('falls back to agentDir when working_directory does not exist and warns', () => {
    const warn = vi.fn();
    const missing = join(testDir, 'never-created');
    expect(resolveAgentCwd(agentDir, missing, warn)).toBe(agentDir);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('falls back to process.cwd() when both override and agentDir are unusable', () => {
    expect(resolveAgentCwd(undefined, undefined)).toBe(process.cwd());
  });

  it('does not invoke warn when the override is empty/whitespace', () => {
    const warn = vi.fn();
    resolveAgentCwd(agentDir, '   ', warn);
    expect(warn).not.toHaveBeenCalled();
  });
});
