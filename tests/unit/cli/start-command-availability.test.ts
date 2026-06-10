import { afterEach, describe, expect, it, vi } from 'vitest';
import { requireDaemonOfflineForBootstrap } from '../../../src/cli/start';

describe('requireDaemonOfflineForBootstrap', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns false when the daemon is already running', async () => {
    const ipc = {
      probeAvailability: vi.fn().mockResolvedValue('running'),
    };

    await expect(
      requireDaemonOfflineForBootstrap(ipc as never),
    ).resolves.toBe(false);
  });

  it('returns true only when the daemon is definitely offline', async () => {
    const ipc = {
      probeAvailability: vi.fn().mockResolvedValue('offline'),
    };

    await expect(
      requireDaemonOfflineForBootstrap(ipc as never),
    ).resolves.toBe(true);
  });

  it('exits instead of auto-restarting an unresponsive daemon', async () => {
    const ipc = {
      probeAvailability: vi.fn().mockResolvedValue('unresponsive'),
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__PROCESS_EXIT_${code}__`);
    }) as never);

    await expect(
      requireDaemonOfflineForBootstrap(ipc as never),
    ).rejects.toThrow('__PROCESS_EXIT_1__');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy.mock.calls.flat().join(' ')).toContain('Refusing to auto-restart');
  });
});
