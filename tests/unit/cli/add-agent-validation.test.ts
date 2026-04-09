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
import { describe, it, expect, vi, afterEach } from 'vitest';
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
