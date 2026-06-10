import { describe, it, expect, vi } from 'vitest';
import { IPCClient } from '../../../src/daemon/ipc-server';

describe('IPCClient.probeAvailability', () => {
  it('returns running when status succeeds', async () => {
    const client = new IPCClient('test-instance');
    vi.spyOn(client, 'send').mockResolvedValue({ success: true, data: [] });

    await expect(client.probeAvailability()).resolves.toBe('running');
  });

  it('returns offline on the explicit daemon-not-running response', async () => {
    const client = new IPCClient('test-instance');
    vi.spyOn(client, 'send').mockResolvedValue({
      success: false,
      error: 'Daemon is not running. Start it with: cortextos start',
    });

    await expect(client.probeAvailability()).resolves.toBe('offline');
  });

  it('returns unresponsive when the IPC request times out', async () => {
    const client = new IPCClient('test-instance');
    vi.spyOn(client, 'send').mockRejectedValue(new Error('IPC request timed out'));

    await expect(client.probeAvailability()).resolves.toBe('unresponsive');
  });

  it('returns unresponsive on other daemon-side failures', async () => {
    const client = new IPCClient('test-instance');
    vi.spyOn(client, 'send').mockResolvedValue({
      success: false,
      error: 'Invalid response from daemon',
    });

    await expect(client.probeAvailability()).resolves.toBe('unresponsive');
  });
});
