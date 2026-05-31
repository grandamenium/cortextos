/**
 * F3b: direct tests for the extracted initOrg() — specifically the
 * installer-only regenerateExistingSystemMd toggle the CLI wrapper never sets
 * (the wrapper relies on the default true).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initOrg } from '../../../src/scaffold/org';

describe('F3b scaffold/initOrg (direct)', () => {
  let tempRoot: string;
  let tempHome: string;
  let originalHome: string | undefined;
  const STALE = '# System Context\n\nSTALE-MARKER\n';

  function seedExistingAgentWithSystemMd(org: string, agent: string) {
    const agentDir = join(tempRoot, 'orgs', org, 'agents', agent);
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'SYSTEM.md'), STALE);
    return join(agentDir, 'SYSTEM.md');
  }

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'f3b-org-rt-'));
    tempHome = mkdtempSync(join(tmpdir(), 'f3b-org-home-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    // Pre-create the org with a context.json so initOrg backfills rather than creating.
    mkdirSync(join(tempRoot, 'orgs', 'testorg'), { recursive: true });
    writeFileSync(
      join(tempRoot, 'orgs', 'testorg', 'context.json'),
      JSON.stringify({ name: 'testorg', timezone: 'UTC', orchestrator: 'boss' })
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('regenerates an existing agent SYSTEM.md by default', () => {
    const sysPath = seedExistingAgentWithSystemMd('testorg', 'a1');
    initOrg({ orgName: 'testorg', instance: 'f3b-i', projectRoot: tempRoot });
    const out = readFileSync(sysPath, 'utf-8');
    expect(out).not.toContain('STALE-MARKER');
    expect(out).toContain('**Orchestrator:** boss');
  });

  it('does NOT touch existing SYSTEM.md when regenerateExistingSystemMd is false', () => {
    const sysPath = seedExistingAgentWithSystemMd('testorg', 'a1');
    initOrg({ orgName: 'testorg', instance: 'f3b-i', projectRoot: tempRoot, regenerateExistingSystemMd: false });
    expect(readFileSync(sysPath, 'utf-8')).toBe(STALE);
  });
});
