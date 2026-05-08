/**
 * BL-2026-05-08-003 phase 3 — `cortextos profile-failover` CLI exit-code map.
 *
 * The CLI is a thin commander wrapper over `runFailover`; the tests
 * here verify that each `FailoverError.reason` lands on a distinct
 * exit code so boss runbook (community/skills/profile-failover/
 * SKILL.md) can branch on the failure mode without parsing stderr.
 *
 * Service-level behavior is exercised in
 * `tests/unit/services/profile-failover.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { profileFailoverCommand } from '../../../src/cli/profile-failover';

let tmpRoot: string;
const ORG = 'testorg';
const AGENT = 'engineer';

function spyExit() {
  return vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`__TEST_PROCESS_EXIT_${code ?? 0}__`);
  }) as never);
}

function silenceConsole() {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
}

function writeProfilesJson(contents: object): void {
  const dir = join(tmpRoot, 'orgs', ORG);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'profiles.json'), JSON.stringify(contents), 'utf-8');
}

function writeAgentConfig(contents: object): void {
  const dir = join(tmpRoot, 'orgs', ORG, 'agents', AGENT);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(contents), 'utf-8');
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'failover-cli-'));
  process.env.CTX_FRAMEWORK_ROOT = tmpRoot;
  process.env.CTX_ORG = ORG;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CTX_FRAMEWORK_ROOT;
  delete process.env.CTX_ORG;
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('profile-failover CLI exit-code map', () => {
  it('exits 2 when no fallback_profile is configured', async () => {
    writeProfilesJson({
      default_profile: 'p',
      profiles: { p: { config_dir: '/p' } },
    });
    writeAgentConfig({ agent_name: AGENT });
    const exitSpy = spyExit();
    silenceConsole();

    await expect(
      profileFailoverCommand.parseAsync(
        ['node', 'cli', '--agent', AGENT, '--trigger', 'e1'],
      ),
    ).rejects.toThrow(/__TEST_PROCESS_EXIT_2__/);
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it('exits 2 when the agent directory does not exist', async () => {
    writeProfilesJson({
      default_profile: 'p',
      profiles: { p: { config_dir: '/p' } },
    });
    const exitSpy = spyExit();
    silenceConsole();

    await expect(
      profileFailoverCommand.parseAsync(
        ['node', 'cli', '--agent', 'no-such-agent', '--trigger', 'e1'],
      ),
    ).rejects.toThrow(/__TEST_PROCESS_EXIT_2__/);
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it('exits 3 when the registry is missing', async () => {
    writeAgentConfig({ agent_name: AGENT, fallback_profile: 'work' });
    const exitSpy = spyExit();
    silenceConsole();

    await expect(
      profileFailoverCommand.parseAsync(
        ['node', 'cli', '--agent', AGENT, '--trigger', 'e1'],
      ),
    ).rejects.toThrow(/__TEST_PROCESS_EXIT_3__/);
    expect(exitSpy).toHaveBeenCalledWith(3);
  });

  it('exits 3 when fallback_profile is unknown to the registry', async () => {
    writeProfilesJson({
      default_profile: 'p',
      profiles: { p: { config_dir: '/p' } },
    });
    writeAgentConfig({ agent_name: AGENT, fallback_profile: 'enterprise' });
    const exitSpy = spyExit();
    silenceConsole();

    await expect(
      profileFailoverCommand.parseAsync(
        ['node', 'cli', '--agent', AGENT, '--trigger', 'e1'],
      ),
    ).rejects.toThrow(/__TEST_PROCESS_EXIT_3__/);
    expect(exitSpy).toHaveBeenCalledWith(3);
  });

  it('exits 1 with a clear error when CTX_ORG is unset and --org omitted', async () => {
    delete process.env.CTX_ORG;
    const exitSpy = spyExit();
    silenceConsole();

    await expect(
      profileFailoverCommand.parseAsync(
        ['node', 'cli', '--agent', AGENT, '--trigger', 'e1'],
      ),
    ).rejects.toThrow(/__TEST_PROCESS_EXIT_1__/);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
