import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const spawnSync = vi.fn();
const getTaskById = vi.fn();
const syncAll = vi.fn();

vi.mock('child_process', () => ({
  spawnSync,
}));

vi.mock('@/lib/data/tasks', () => ({
  getTaskById,
}));

vi.mock('@/lib/config', () => ({
  getFrameworkRoot: () => '/framework',
  getCTXRoot: () => '/ctx-root',
}));

vi.mock('@/lib/sync', () => ({
  syncAll,
}));

let PATCH: typeof import('../route').PATCH;

beforeAll(async () => {
  const route = await import('../route');
  PATCH = route.PATCH;
});

describe('PATCH /api/tasks/[id]', () => {
  beforeEach(() => {
    spawnSync.mockReset();
    getTaskById.mockReset();
    syncAll.mockReset();

    getTaskById.mockReturnValue({
      id: 'task-1',
      title: 'Waiting route task',
      org: 'acme',
    });

    spawnSync.mockReturnValue({
      status: 0,
      stderr: '',
      stdout: 'ok',
    });
  });

  it('accepts waiting and persists it through update-task.sh', async () => {
    const request = new NextRequest('http://localhost/api/tasks/task-1', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'waiting' }),
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await PATCH(request, {
      params: Promise.resolve({ id: 'task-1' }),
    });

    expect(response.status).toBe(200);
    expect(spawnSync).toHaveBeenCalledWith(
      'bash',
      ['/framework/bus/update-task.sh', 'task-1', 'waiting'],
      expect.objectContaining({
        encoding: 'utf-8',
        timeout: 10000,
        stdio: 'pipe',
        env: expect.objectContaining({
          CTX_FRAMEWORK_ROOT: '/framework',
          CTX_ROOT: '/ctx-root',
          CTX_AGENT_NAME: 'dashboard',
          CTX_ORG: 'acme',
        }),
      }),
    );
    expect(syncAll).toHaveBeenCalled();
  });
});
