import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  archiveClaudeProjectDirForLaunchDir,
  findClaudeSessionFile,
  getClaudeProjectDirForLaunchDir,
  getDeterministicAgentSessionId,
  validateClaudeWorkingDirectoryPolicy,
} from '../../../src/utils/agent-session-isolation.js';

describe('agent session isolation helpers', () => {
  let tmp: string;
  let projectRoot: string;
  let agentADir: string;
  let agentBDir: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cortextos-session-iso-'));
    projectRoot = join(tmp, 'framework');
    agentADir = join(projectRoot, 'orgs', 'acme', 'agents', 'alice');
    agentBDir = join(projectRoot, 'orgs', 'acme', 'agents', 'bob');
    mkdirSync(agentADir, { recursive: true });
    mkdirSync(agentBDir, { recursive: true });
    writeFileSync(join(agentADir, 'config.json'), JSON.stringify({ runtime: 'claude-code', working_directory: '' }));
    writeFileSync(join(agentBDir, 'config.json'), JSON.stringify({ runtime: 'claude-code', working_directory: '' }));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('deterministic session IDs are stable and distinct per agent', () => {
    const first = getDeterministicAgentSessionId('alice', 'acme');
    const second = getDeterministicAgentSessionId('alice', 'acme');
    const other = getDeterministicAgentSessionId('bob', 'acme');

    expect(first).toBe(second);
    expect(first).not.toBe(other);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('allows empty working_directory (agent-dir default)', () => {
    const result = validateClaudeWorkingDirectoryPolicy({
      agentName: 'alice',
      agentDir: agentADir,
      config: { runtime: 'claude-code', working_directory: '' },
      projectRoot,
      enabledAgents: {},
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.effectiveLaunchDir).toBe(agentADir);
    }
  });

  it('rejects external working_directory without --allow-external-cwd', () => {
    const result = validateClaudeWorkingDirectoryPolicy({
      agentName: 'alice',
      agentDir: agentADir,
      config: { runtime: 'claude-code', working_directory: '/Users/joshweiss/code/auditos' },
      projectRoot,
      enabledAgents: {},
      allowExternalCwd: false,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('--allow-external-cwd');
    }
  });

  it('rejects two enabled Claude agents sharing the same working_directory', () => {
    const sharedDir = join(tmp, 'shared-repo');
    mkdirSync(sharedDir, { recursive: true });
    writeFileSync(
      join(agentADir, 'config.json'),
      JSON.stringify({ runtime: 'claude-code', working_directory: sharedDir }),
    );

    const result = validateClaudeWorkingDirectoryPolicy({
      agentName: 'bob',
      agentDir: agentBDir,
      config: { runtime: 'claude-code', working_directory: sharedDir },
      projectRoot,
      enabledAgents: {
        alice: { enabled: true, org: 'acme' },
        bob: { enabled: true, org: 'acme' },
      },
      allowExternalCwd: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('already used by enabled Claude agent "alice (acme)"');
    }
  });

  it('finds the per-agent Claude session file by session ID, independent of cwd namespace', () => {
    const homeDir = join(tmp, 'home');
    const projectsRoot = join(homeDir, '.claude', 'projects');
    const unrelatedProject = join(projectsRoot, '-Users-joshweiss-code-auditos');
    mkdirSync(unrelatedProject, { recursive: true });
    const sessionId = getDeterministicAgentSessionId('auditmaster', 'clearworksai');
    const sessionPath = join(unrelatedProject, `${sessionId}.jsonl`);
    writeFileSync(sessionPath, '[]', 'utf-8');

    expect(findClaudeSessionFile(sessionId, homeDir)).toBe(sessionPath);
  });

  it('archives the cwd-keyed Claude project dir on disable', () => {
    const homeDir = join(tmp, 'home');
    const launchDir = '/Users/joshweiss/code/auditos';
    const projectDir = getClaudeProjectDirForLaunchDir(launchDir, homeDir);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'old.jsonl'), '[]', 'utf-8');

    const archived = archiveClaudeProjectDirForLaunchDir(launchDir, homeDir, new Date('2026-06-09T01:00:00.000Z'));

    expect(archived).not.toBeNull();
    expect(existsSync(projectDir)).toBe(false);
    expect(existsSync(archived!)).toBe(true);
    expect(archived).toContain('.disabled-2026-06-09T01-00-00-000Z');
  });
});
