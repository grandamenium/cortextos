/**
 * BUG-041 regression test: `cortextos add-agent` must reject invalid agent
 * names (mixed-case, spaces, path traversal, etc.) BEFORE creating any
 * filesystem artifacts.
 *
 * Before the fix, `cortextos add-agent CortextDesigner --template agent --org testorg`
 * succeeded at the CLI level, wrote the agent dir to disk, registered the
 * agent in `enabled-agents.json`, and THEN failed every `cortextos bus *`
 * command at runtime because `resolveEnv()` rejected the same name that
 * add-agent had accepted. Affected agents were half-functional — daemon-
 * managed fine but unable to reply to Telegram, create tasks, check inbox,
 * or do anything via the bus.
 *
 * The fix centralizes validation by calling `validateAgentName()` at the
 * entry of the add-agent action, so bad names are rejected upfront and
 * the caller gets a clear error before any filesystem state is touched.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { addAgentCommand } from '../../../src/cli/add-agent';

describe('BUG-041: add-agent agent name validation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects CortextDesigner (PascalCase) before any filesystem write', async () => {
    // Commander calls process.exit(1) on validation failure. We intercept
    // it by throwing, which we catch via expect().rejects. This avoids the
    // test runner itself exiting on process.exit().
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__TEST_PROCESS_EXIT_${code}__`);
    }) as never);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      addAgentCommand.parseAsync(
        ['node', 'cli', 'CortextDesigner', '--template', 'agent', '--org', 'testorg']
      )
    ).rejects.toThrow(/__TEST_PROCESS_EXIT_1__/);

    // The error message must tell the user exactly what was wrong
    expect(consoleErrorSpy).toHaveBeenCalled();
    const errorOutput = consoleErrorSpy.mock.calls.flat().join(' ');
    expect(errorOutput).toContain("Invalid agent name 'CortextDesigner'");
    // And it must show the validation rule so the user knows how to fix it
    expect(errorOutput).toContain('/^[a-z0-9_-]+$/');

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('rejects a simpler single-uppercase name (Agent)', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__TEST_PROCESS_EXIT_${code}__`);
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      addAgentCommand.parseAsync(
        ['node', 'cli', 'Agent', '--template', 'agent', '--org', 'testorg']
      )
    ).rejects.toThrow(/__TEST_PROCESS_EXIT_1__/);

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('rejects names with spaces', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__TEST_PROCESS_EXIT_${code}__`);
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      addAgentCommand.parseAsync(
        ['node', 'cli', 'my agent', '--template', 'agent', '--org', 'testorg']
      )
    ).rejects.toThrow(/__TEST_PROCESS_EXIT_1__/);

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('rejects path traversal attempts', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__TEST_PROCESS_EXIT_${code}__`);
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      addAgentCommand.parseAsync(
        ['node', 'cli', '../evil', '--template', 'agent', '--org', 'testorg']
      )
    ).rejects.toThrow(/__TEST_PROCESS_EXIT_1__/);

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

/**
 * Issue #407 regression test: `cortextos add-agent` must reject invalid
 * --org values for the same reasons it rejects invalid agent names —
 * mixed-case orgs pass scaffolding but then break every `cortextos bus *`
 * invocation at runtime (env.ts strictly validates CTX_ORG) and every
 * dashboard add-agent attempt (POST /api/agents returns HTTP 400).
 */
describe('issue #407: add-agent --org name validation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects --org teamStupid (camelCase) before any filesystem write', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__TEST_PROCESS_EXIT_${code}__`);
    }) as never);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      addAgentCommand.parseAsync(
        ['node', 'cli', 'validagent', '--template', 'agent', '--org', 'teamStupid']
      )
    ).rejects.toThrow(/__TEST_PROCESS_EXIT_1__/);

    expect(consoleErrorSpy).toHaveBeenCalled();
    const errorOutput = consoleErrorSpy.mock.calls.flat().join(' ');
    expect(errorOutput).toContain("Invalid org name 'teamStupid'");
    expect(errorOutput).toContain('/^[a-z0-9_-]+$/');

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('rejects --org with spaces', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__TEST_PROCESS_EXIT_${code}__`);
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      addAgentCommand.parseAsync(
        ['node', 'cli', 'validagent', '--template', 'agent', '--org', 'my org']
      )
    ).rejects.toThrow(/__TEST_PROCESS_EXIT_1__/);

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('rejects --org path-traversal attempts', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__TEST_PROCESS_EXIT_${code}__`);
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      addAgentCommand.parseAsync(
        ['node', 'cli', 'validagent', '--template', 'agent', '--org', '../escape']
      )
    ).rejects.toThrow(/__TEST_PROCESS_EXIT_1__/);

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('agent session-isolation create validation', () => {
  let tmpHome: string;
  let tmpFramework: string;
  const origHome = process.env.HOME;
  const origFramework = process.env.CTX_FRAMEWORK_ROOT;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'cortextos-add-agent-home-'));
    tmpFramework = mkdtempSync(join(tmpdir(), 'cortextos-add-agent-fw-'));
    mkdirSync(join(tmpFramework, 'orgs', 'testorg'), { recursive: true });
    process.env.HOME = tmpHome;
    process.env.CTX_FRAMEWORK_ROOT = tmpFramework;
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origFramework === undefined) delete process.env.CTX_FRAMEWORK_ROOT;
    else process.env.CTX_FRAMEWORK_ROOT = origFramework;
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpFramework, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('rejects an external working_directory without --allow-external-cwd before creating files', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__TEST_PROCESS_EXIT_${code}__`);
    }) as never);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      addAgentCommand.parseAsync(
        [
          'node', 'cli', 'auditmaster', '--template', 'agent', '--org', 'testorg',
          '--working-directory', '/Users/joshweiss/code/auditos',
        ],
      ),
    ).rejects.toThrow(/__TEST_PROCESS_EXIT_1__/);

    expect(consoleErrorSpy.mock.calls.flat().join(' ')).toContain('--allow-external-cwd');
    expect(existsSync(join(tmpFramework, 'orgs', 'testorg', 'agents', 'auditmaster'))).toBe(false);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
