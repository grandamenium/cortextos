import { describe, expect, it, vi } from 'vitest';
import { IPCServer } from '../../../src/daemon/ipc-server.js';

type TerminationData = { name?: unknown };

function captureSocket() {
  const chunks: string[] = [];
  const socket = {
    write: vi.fn((chunk: string) => { chunks.push(chunk); }),
    end: vi.fn(),
  };
  return {
    socket,
    text: () => chunks.join(''),
    json: () => JSON.parse(chunks.join('')),
  };
}

async function requestTermination(server: IPCServer, data: TerminationData, socket: unknown): Promise<void> {
  const entrypoint = server as unknown as {
    handleRequest(request: unknown, socket: unknown): Promise<void>;
  };
  await entrypoint.handleRequest({ type: 'terminate-worker', data }, socket);
}

describe('terminate-worker production IPC reliability', () => {
  it('returns an asynchronous manager rejection to the operator', async () => {
    const terminateWorker = vi.fn().mockRejectedValue(new Error('Worker "ghost" not found'));
    const capture = captureSocket();

    await requestTermination(new IPCServer({ terminateWorker } as never), { name: 'ghost' }, capture.socket);

    expect(terminateWorker).toHaveBeenCalledExactlyOnceWith('ghost');
    expect(capture.json()).toEqual({ success: false, error: 'Error: Worker "ghost" not found' });
  });

  it('keeps the response pending and acknowledges exactly once after resolution', async () => {
    let finish: (() => void) | undefined;
    const terminateWorker = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const capture = captureSocket();
    const pending = requestTermination(new IPCServer({ terminateWorker } as never), { name: 'worker_1' }, capture.socket);

    await Promise.resolve();
    expect(terminateWorker).toHaveBeenCalledExactlyOnceWith('worker_1');
    expect(capture.text()).toBe('');
    expect(capture.socket.end).not.toHaveBeenCalled();

    finish?.();
    await pending;
    expect(capture.json()).toEqual({ success: true, data: 'Terminating worker worker_1' });
    expect(capture.socket.write).toHaveBeenCalledOnce();
    expect(capture.socket.end).toHaveBeenCalledOnce();
  });

  it.each([undefined, null, ''])('rejects absent name %j before manager access', async (name) => {
    const terminateWorker = vi.fn();
    const capture = captureSocket();

    await requestTermination(new IPCServer({ terminateWorker } as never), { name }, capture.socket);

    expect(terminateWorker).not.toHaveBeenCalled();
    expect(capture.json()).toEqual({ success: false, error: 'terminate-worker requires: name' });
  });

  it.each([
    ['whitespace', '  '],
    ['number', 7],
    ['array', ['worker_1']],
    ['object', { worker: 'worker_1' }],
    ['invalid character', 'worker.one'],
    ['over 64 characters', 'w'.repeat(65)],
  ])('rejects %s input before manager access', async (_case, name) => {
    const terminateWorker = vi.fn();
    const capture = captureSocket();

    await requestTermination(new IPCServer({ terminateWorker } as never), { name }, capture.socket);

    expect(terminateWorker).not.toHaveBeenCalled();
    expect(capture.json()).toEqual({ success: false, error: 'Invalid worker name' });
  });
});
