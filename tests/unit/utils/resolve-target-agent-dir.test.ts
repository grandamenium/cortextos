import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveTargetAgentDir } from '../../../src/utils/env.js';
import type { CtxEnv } from '../../../src/types/index.js';

describe('resolveTargetAgentDir', () => {
  const testRoot = join(tmpdir(), `cortextos-target-dir-${Date.now()}`);
  const agentsDir = join(testRoot, 'orgs', 'testorg', 'agents');

  const baseEnv = (overrides?: Partial<CtxEnv>): CtxEnv => ({
    instanceId: 'default',
    ctxRoot: join(testRoot, '.cortextos'),
    frameworkRoot: testRoot,
    agentName: 'caller',
    agentDir: join(agentsDir, 'caller'),
    org: 'testorg',
    projectRoot: testRoot,
    ...overrides,
  });

  beforeEach(() => {
    mkdirSync(join(agentsDir, 'caller'), { recursive: true });
    mkdirSync(join(agentsDir, 'target'), { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('returns the caller agentDir when target is the caller', () => {
    expect(resolveTargetAgentDir(baseEnv(), 'caller')).toBe(join(agentsDir, 'caller'));
  });

  it('resolves a sibling agent of the caller agentDir', () => {
    expect(resolveTargetAgentDir(baseEnv(), 'target')).toBe(join(agentsDir, 'target'));
  });

  it('falls back to projectRoot org convention when caller agentDir is empty', () => {
    const env = baseEnv({ agentDir: '' });
    expect(resolveTargetAgentDir(env, 'target')).toBe(join(agentsDir, 'target'));
  });

  it('falls back to flat agents layout without org', () => {
    const flatDir = join(testRoot, 'agents', 'flatbot');
    mkdirSync(flatDir, { recursive: true });
    const env = baseEnv({ agentDir: '', org: '' });
    expect(resolveTargetAgentDir(env, 'flatbot')).toBe(flatDir);
  });

  it('returns null when the target directory does not exist', () => {
    expect(resolveTargetAgentDir(baseEnv(), 'ghost')).toBeNull();
  });

  it('returns null when env has no usable roots', () => {
    const env = baseEnv({ agentDir: '', projectRoot: '', org: '' });
    expect(resolveTargetAgentDir(env, 'target')).toBeNull();
  });

  it('throws on path-traversal agent names', () => {
    expect(() => resolveTargetAgentDir(baseEnv(), '../evil')).toThrow('Invalid agent name');
    expect(() => resolveTargetAgentDir(baseEnv(), 'a/b')).toThrow('Invalid agent name');
    expect(() => resolveTargetAgentDir(baseEnv(), '')).toThrow('Invalid agent name');
  });
});
