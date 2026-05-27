import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { updateHeartbeat } from '../../../src/bus/heartbeat.js';
import { uuidv5 } from '../../../src/bus/rgos-mirror.js';
import type { BusPaths, Task } from '../../../src/types/index.js';

function makePaths(root: string, agent = 'codex', org = 'revops-global'): BusPaths {
  return {
    ctxRoot: root,
    inbox: join(root, 'inbox', agent),
    inflight: join(root, 'inflight', agent),
    processed: join(root, 'processed', agent),
    logDir: join(root, 'logs', agent),
    stateDir: join(root, 'state', agent),
    taskDir: join(root, 'orgs', org, 'tasks'),
    approvalDir: join(root, 'orgs', org, 'approvals'),
    analyticsDir: join(root, 'orgs', org, 'analytics'),
    deliverablesDir: join(root, 'orgs', org, 'deliverables'),
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task_1779898823064_51134999',
    title: 'Fix AgentOps fleet idle bug',
    description: '',
    type: 'agent',
    needs_approval: false,
    status: 'in_progress',
    assigned_to: 'codex',
    created_by: 'root',
    org: 'revops-global',
    priority: 'high',
    project: '',
    kpi_key: null,
    created_at: '2026-05-27T16:18:00Z',
    updated_at: '2026-05-27T16:20:00Z',
    completed_at: null,
    due_date: null,
    archived: false,
    ...overrides,
  };
}

function setSupabaseEnv() {
  process.env.SUPABASE_RGOS_URL = 'https://test.supabase.co';
  process.env.SUPABASE_RGOS_SERVICE_KEY = 'test-service-key';
}

function clearSupabaseEnv() {
  delete process.env.SUPABASE_RGOS_URL;
  delete process.env.SUPABASE_RGOS_SERVICE_KEY;
}

function mockFetchOk() {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => '',
    json: async () => ({}),
  }));
}

describe('updateHeartbeat', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearSupabaseEnv();
  });

  it('falls back to the in-progress task store and syncs orch_agents.current_task_id', async () => {
    const root = mkdtempSync(join(tmpdir(), 'heartbeat-task-store-'));
    try {
      setSupabaseEnv();
      mockFetchOk();
      const paths = makePaths(root);
      mkdirSync(paths.taskDir, { recursive: true });
      const task = makeTask();
      writeFileSync(join(paths.taskDir, `${task.id}.json`), JSON.stringify(task), 'utf-8');

      await updateHeartbeat(paths, 'codex', 'online', { org: 'revops-global' });

      const hb = JSON.parse(readFileSync(join(paths.stateDir, 'heartbeat.json'), 'utf-8'));
      expect(hb.current_task).toBe(`${task.id}: ${task.title}`);

      const fetchMock = vi.mocked(fetch);
      const orchAgentCall = fetchMock.mock.calls.find(([url]) =>
        String(url).includes('/rest/v1/orch_agents?role_id=eq.cortextos-codex'));
      expect(orchAgentCall).toBeTruthy();
      expect(orchAgentCall?.[1]?.method).toBe('PATCH');
      const body = JSON.parse(String(orchAgentCall?.[1]?.body));
      expect(body.current_task_id).toBe(uuidv5(task.id));
      expect(body.config_json.current_task_bus_id).toBe(task.id);
      expect(body.config_json.current_task).toBe(`${task.id}: ${task.title}`);

      const presenceCall = fetchMock.mock.calls.find(([url]) =>
        String(url).includes('/realtime/v1/api/broadcast'));
      const presenceBody = JSON.parse(String(presenceCall?.[1]?.body));
      expect(presenceBody.messages[0].payload.current_task_id).toBe(task.id);
      expect(presenceBody.messages[0].payload.status).toBe('task_updated');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses an explicit heartbeat task id before task-store fallback', async () => {
    const root = mkdtempSync(join(tmpdir(), 'heartbeat-explicit-task-'));
    try {
      setSupabaseEnv();
      mockFetchOk();
      const paths = makePaths(root);

      await updateHeartbeat(paths, 'codex', 'online', {
        org: 'revops-global',
        currentTask: 'task_explicit_1: Explicit task',
      });

      const fetchMock = vi.mocked(fetch);
      const orchAgentCall = fetchMock.mock.calls.find(([url]) =>
        String(url).includes('/rest/v1/orch_agents?role_id=eq.cortextos-codex'));
      const body = JSON.parse(String(orchAgentCall?.[1]?.body));
      expect(body.current_task_id).toBe(uuidv5('task_explicit_1'));
      expect(body.config_json.current_task_bus_id).toBe('task_explicit_1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
