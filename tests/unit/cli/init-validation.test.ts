/**
 * Issue #407 regression test: `cortextos init` must reject invalid org
 * names (mixed-case, spaces, path traversal, etc.) BEFORE creating any
 * filesystem artifacts.
 *
 * Before the fix, `cortextos init teamStupid` succeeded at the CLI level,
 * wrote `orgs/teamStupid/` to disk, registered the org context, and THEN
 * failed every dashboard `POST /api/agents` call (HTTP 400) and every
 * `cortextos bus *` invocation at runtime because `src/utils/env.ts` and
 * the dashboard API both call `validateOrgName()` strictly. Affected orgs
 * were unusable from any UI surface.
 *
 * The fix calls `validateOrgName()` at the entry of the init action, so
 * bad names are rejected upfront and the caller gets a clear error before
 * any filesystem state is touched.
 *
 * Mirrors the BUG-041 pattern in `add-agent-validation.test.ts`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { initCommand } from '../../../src/cli/init';

describe('issue #407: init org name validation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects teamStupid (camelCase) before any filesystem write', async () => {
    // Commander calls process.exit(1) on validation failure. We intercept it
    // by throwing, which we catch via expect().rejects. This avoids the test
    // runner itself exiting on process.exit().
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__TEST_PROCESS_EXIT_${code}__`);
    }) as never);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      initCommand.parseAsync(['node', 'cli', 'teamStupid'])
    ).rejects.toThrow(/__TEST_PROCESS_EXIT_1__/);

    expect(consoleErrorSpy).toHaveBeenCalled();
    const errorOutput = consoleErrorSpy.mock.calls.flat().join(' ');
    expect(errorOutput).toContain("Invalid org name 'teamStupid'");
    expect(errorOutput).toContain('/^[a-z0-9_-]+$/');

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('rejects a single-uppercase-letter name (Acme)', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__TEST_PROCESS_EXIT_${code}__`);
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      initCommand.parseAsync(['node', 'cli', 'Acme'])
    ).rejects.toThrow(/__TEST_PROCESS_EXIT_1__/);

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('rejects names with spaces', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__TEST_PROCESS_EXIT_${code}__`);
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      initCommand.parseAsync(['node', 'cli', 'my org'])
    ).rejects.toThrow(/__TEST_PROCESS_EXIT_1__/);

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('rejects path traversal attempts', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__TEST_PROCESS_EXIT_${code}__`);
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      initCommand.parseAsync(['node', 'cli', '../evil'])
    ).rejects.toThrow(/__TEST_PROCESS_EXIT_1__/);

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
