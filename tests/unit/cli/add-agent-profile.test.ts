/**
 * BL-2026-05-08-003 phase 1 — `add-agent --profile` validation.
 *
 * Boss decision #4 (2026-05-08T18:00Z): cheap fail-fast. Reject the
 * agent creation BEFORE any filesystem write when --profile names a
 * profile not present in `orgs/<org>/profiles.json`. Misconfiguration
 * caught here surfaces immediately; the alternative (silent fallback
 * at first spawn) buries the bug as "why is this agent on the wrong
 * account?" hours later.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { addAgentCommand } from '../../../src/cli/add-agent';

let tmpRoot: string;
let originalCwd: string;
let originalFrameworkRoot: string | undefined;
let originalProjectRoot: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'add-agent-profile-'));
  mkdirSync(join(tmpRoot, 'orgs', 'testorg'), { recursive: true });
  originalCwd = process.cwd();
  originalFrameworkRoot = process.env.CTX_FRAMEWORK_ROOT;
  originalProjectRoot = process.env.CTX_PROJECT_ROOT;
  process.env.CTX_FRAMEWORK_ROOT = tmpRoot;
  process.env.CTX_PROJECT_ROOT = tmpRoot;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(originalCwd);
  if (originalFrameworkRoot === undefined) delete process.env.CTX_FRAMEWORK_ROOT;
  else process.env.CTX_FRAMEWORK_ROOT = originalFrameworkRoot;
  if (originalProjectRoot === undefined) delete process.env.CTX_PROJECT_ROOT;
  else process.env.CTX_PROJECT_ROOT = originalProjectRoot;
  rmSync(tmpRoot, { recursive: true, force: true });
});

function writeProfilesJson(contents: object): void {
  writeFileSync(
    join(tmpRoot, 'orgs', 'testorg', 'profiles.json'),
    JSON.stringify(contents),
    'utf-8',
  );
}

function spyExit() {
  return vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`__TEST_PROCESS_EXIT_${code}__`);
  }) as never);
}

describe('add-agent --profile validation (BL-003 phase 1)', () => {
  it('rejects --profile when orgs/<org>/profiles.json is missing', async () => {
    const exitSpy = spyExit();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      addAgentCommand.parseAsync(
        ['node', 'cli', 'newagent', '--template', 'agent', '--org', 'testorg', '--profile', 'work'],
      ),
    ).rejects.toThrow(/__TEST_PROCESS_EXIT_1__/);

    const err = consoleErrorSpy.mock.calls.flat().join(' ');
    expect(err).toMatch(/profiles\.json is missing or malformed/);
    expect(exitSpy).toHaveBeenCalledWith(1);

    // No agent dir written — the fail-fast guarantee.
    expect(existsSync(join(tmpRoot, 'orgs', 'testorg', 'agents', 'newagent'))).toBe(false);
  });

  it('rejects --profile when the named profile is not in the registry', async () => {
    writeProfilesJson({
      default_profile: 'personal',
      profiles: { personal: { config_dir: '/Users/x/.claude' } },
    });
    const exitSpy = spyExit();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      addAgentCommand.parseAsync(
        ['node', 'cli', 'newagent', '--template', 'agent', '--org', 'testorg', '--profile', 'enterprise'],
      ),
    ).rejects.toThrow(/__TEST_PROCESS_EXIT_1__/);

    const err = consoleErrorSpy.mock.calls.flat().join(' ');
    expect(err).toMatch(/profile "enterprise" not in/);
    expect(err).toMatch(/Known: personal/);
    expect(exitSpy).toHaveBeenCalledWith(1);

    expect(existsSync(join(tmpRoot, 'orgs', 'testorg', 'agents', 'newagent'))).toBe(false);
  });

  it('omitting --profile skips registry validation entirely', async () => {
    // The validation only runs when --profile is given; omitting it
    // means the agent uses the registry default (or pre-BL-003
    // behaviour if no registry). Useful for backward compat — a fleet
    // that hasn't created profiles.json yet shouldn't fail add-agent.
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await addAgentCommand.parseAsync(
      ['node', 'cli', 'newagent', '--template', 'agent', '--org', 'testorg'],
    );

    // Agent dir created, config.json has no claude_profile field.
    const agentDir = join(tmpRoot, 'orgs', 'testorg', 'agents', 'newagent');
    expect(existsSync(agentDir)).toBe(true);
    const cfg = JSON.parse(
      (await import('fs')).readFileSync(join(agentDir, 'config.json'), 'utf-8'),
    );
    expect(cfg.claude_profile).toBeUndefined();
  });

  it('valid --profile writes claude_profile into config.json', async () => {
    writeProfilesJson({
      default_profile: 'personal',
      profiles: {
        personal: { config_dir: '/Users/x/.claude' },
        work: { config_dir: '/Users/x/.claude-work' },
      },
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await addAgentCommand.parseAsync(
      ['node', 'cli', 'newagent', '--template', 'agent', '--org', 'testorg', '--profile', 'work'],
    );

    const agentDir = join(tmpRoot, 'orgs', 'testorg', 'agents', 'newagent');
    expect(existsSync(agentDir)).toBe(true);
    const cfg = JSON.parse(
      (await import('fs')).readFileSync(join(agentDir, 'config.json'), 'utf-8'),
    );
    expect(cfg.claude_profile).toBe('work');
    // The new field doesn't replace the existing fields:
    expect(cfg.agent_name).toBe('newagent');
    expect(cfg.enabled).toBe(true);
  });
});
