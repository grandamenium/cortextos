import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Create temp dir and set CTX_ROOT BEFORE modules load.
// We rely on vitest running this file fresh (no prior config.ts cache).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-test-'));
process.env.CTX_ROOT = tmpDir;

// Dynamic imports so CTX_ROOT is set before config.ts evaluates
let db: typeof import('../db')['db'];
let syncTasks: typeof import('../sync')['syncTasks'];
let syncApprovals: typeof import('../sync')['syncApprovals'];
let syncEvents: typeof import('../sync')['syncEvents'];
let syncHeartbeat: typeof import('../sync')['syncHeartbeat'];
let syncAll: typeof import('../sync')['syncAll'];
let syncFile: typeof import('../sync')['syncFile'];
let extractOrgFromPath: typeof import('../sync')['extractOrgFromPath'];
let extractOrgAndAgentFromEventPath: typeof import('../sync')['extractOrgAndAgentFromEventPath'];
let extractAgentFromStatePath: typeof import('../sync')['extractAgentFromStatePath'];
let CTX_ROOT: string;

beforeAll(async () => {
  const dbMod = await import('../db');
  db = dbMod.db;

  const syncMod = await import('../sync');
  syncTasks = syncMod.syncTasks;
  syncApprovals = syncMod.syncApprovals;
  syncEvents = syncMod.syncEvents;
  syncHeartbeat = syncMod.syncHeartbeat;
  syncAll = syncMod.syncAll;
  syncFile = syncMod.syncFile;
  extractOrgFromPath = syncMod.extractOrgFromPath;
  extractOrgAndAgentFromEventPath = syncMod.extractOrgAndAgentFromEventPath;
  extractAgentFromStatePath = syncMod.extractAgentFromStatePath;

  const configMod = await import('../config');
  CTX_ROOT = configMod.CTX_ROOT;

  // Verify CTX_ROOT was set correctly
  expect(CTX_ROOT).toBe(tmpDir);
});

// Helper: write a JSON file into the temp CTX_ROOT
function writeJSON(relPath: string, data: unknown): string {
  const fullPath = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, JSON.stringify(data, null, 2));
  return fullPath;
}

// Helper: write raw text (for JSONL)
function writeText(relPath: string, content: string): string {
  const fullPath = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
  return fullPath;
}

function clearSyncMeta(): void {
  db.prepare('DELETE FROM sync_meta').run();
}

function clearTable(table: string): void {
  db.prepare(`DELETE FROM ${table}`).run();
}

describe('syncTasks', () => {
  beforeEach(() => {
    clearTable('tasks');
    clearSyncMeta();
  });

  it('syncs a task JSON file into SQLite', () => {
    writeJSON('orgs/testorg/tasks/task-1.json', {
      id: 'task-1',
      title: 'Test Task',
      status: 'pending',
      priority: 'high',
      created_at: '2025-01-01T00:00:00Z',
    });

    const count = syncTasks('testorg');
    expect(count).toBe(1);

    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get('task-1') as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row.title).toBe('Test Task');
    expect(row.status).toBe('pending');
    expect(row.priority).toBe('high');
    expect(row.org).toBe('testorg');
  });

  it('round-trips a task brief through SQLite as JSON', () => {
    writeJSON('orgs/testorgb/tasks/task-brief.json', {
      id: 'task-brief',
      title: 'Briefed Task',
      status: 'blocked',
      created_at: '2025-01-01T00:00:00Z',
      brief: {
        headline: 'Waiting on DNS',
        reason: 'Deploy blocked until CNAME resolves',
        options: ['Add the CNAME', 'Use the IP'],
        recommendation: 'Add the CNAME',
        updated_at: '2025-01-01T00:05:00Z',
      },
    });

    expect(syncTasks('testorgb')).toBe(1);

    const row = db.prepare('SELECT brief FROM tasks WHERE id = ?').get('task-brief') as { brief: string };
    const brief = JSON.parse(row.brief);
    expect(brief.headline).toBe('Waiting on DNS');
    expect(brief.options).toHaveLength(2);
    expect(brief.recommendation).toBe('Add the CNAME');
  });

  it('stores null brief when the task has none', () => {
    writeJSON('orgs/testorgn/tasks/task-nobrief.json', {
      id: 'task-nobrief',
      title: 'No Brief',
      status: 'pending',
      created_at: '2025-01-01T00:00:00Z',
    });

    expect(syncTasks('testorgn')).toBe(1);
    const row = db.prepare('SELECT brief FROM tasks WHERE id = ?').get('task-nobrief') as { brief: string | null };
    expect(row.brief).toBeNull();
  });

  it('skips unchanged files on re-sync (mtime check)', () => {
    writeJSON('orgs/testorg2/tasks/task-2.json', {
      id: 'task-2',
      title: 'Skip Me',
      status: 'pending',
      created_at: '2025-01-01T00:00:00Z',
    });

    const first = syncTasks('testorg2');
    expect(first).toBe(1);

    const second = syncTasks('testorg2');
    expect(second).toBe(0);
  });

  it('re-syncs when file is modified', async () => {
    const fp = writeJSON('orgs/testorg3/tasks/task-3.json', {
      id: 'task-3',
      title: 'Original',
      status: 'pending',
      created_at: '2025-01-01T00:00:00Z',
    });

    syncTasks('testorg3');

    // Bump mtime
    await new Promise((r) => setTimeout(r, 50));
    fs.writeFileSync(
      fp,
      JSON.stringify({
        id: 'task-3',
        title: 'Updated',
        status: 'in_progress',
        created_at: '2025-01-01T00:00:00Z',
      }),
    );

    const count = syncTasks('testorg3');
    expect(count).toBe(1);

    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get('task-3') as Record<string, unknown>;
    expect(row.title).toBe('Updated');
    expect(row.status).toBe('in_progress');
  });

  it('handles missing task dir gracefully', () => {
    const count = syncTasks('nonexistent-org');
    expect(count).toBe(0);
  });
});

describe('syncApprovals', () => {
  beforeEach(() => {
    clearTable('approvals');
    clearSyncMeta();
  });

  it('syncs pending and resolved approvals', () => {
    writeJSON('orgs/apporg/approvals/pending/ap-1.json', {
      id: 'ap-1',
      title: 'Deploy to prod',
      agent: 'builder',
      created_at: '2025-01-01T00:00:00Z',
    });
    writeJSON('orgs/apporg/approvals/resolved/ap-2.json', {
      id: 'ap-2',
      title: 'Cost increase',
      agent: 'planner',
      status: 'approved',
      created_at: '2025-01-01T00:00:00Z',
      resolved_at: '2025-01-02T00:00:00Z',
    });

    const count = syncApprovals('apporg');
    expect(count).toBe(2);

    const pending = db.prepare('SELECT * FROM approvals WHERE id = ?').get('ap-1') as Record<string, unknown>;
    expect(pending.status).toBe('pending');

    const resolved = db.prepare('SELECT * FROM approvals WHERE id = ?').get('ap-2') as Record<string, unknown>;
    expect(resolved.status).toBe('approved');
  });
});

describe('syncEvents', () => {
  beforeEach(() => {
    clearTable('events');
    clearSyncMeta();
  });

  it('syncs JSONL lines into event rows', () => {
    const lines = [
      JSON.stringify({ id: 'e1', timestamp: '2025-01-01T00:00:00Z', type: 'action', message: 'started' }),
      JSON.stringify({ id: 'e2', timestamp: '2025-01-01T00:01:00Z', type: 'task', message: 'completed' }),
      JSON.stringify({ id: 'e3', timestamp: '2025-01-01T00:02:00Z', type: 'error', severity: 'error', message: 'failed' }),
    ].join('\n');

    writeText('orgs/evtorg/analytics/events/builder/2025-01-01.jsonl', lines);

    const count = syncEvents('evtorg', 'builder');
    expect(count).toBe(3);

    const rows = db.prepare('SELECT * FROM events WHERE agent = ?').all('builder');
    expect(rows).toHaveLength(3);
  });

  it('skips malformed JSONL lines without crashing', () => {
    const lines = [
      JSON.stringify({ id: 'e-good', timestamp: '2025-01-01T00:00:00Z', type: 'action' }),
      'NOT VALID JSON {{{',
      JSON.stringify({ id: 'e-also-good', timestamp: '2025-01-01T00:01:00Z', type: 'task' }),
    ].join('\n');

    writeText('orgs/evtorg2/analytics/events/builder/2025-01-02.jsonl', lines);

    const count = syncEvents('evtorg2', 'builder');
    expect(count).toBe(2);
  });
});

describe('syncHeartbeat', () => {
  beforeEach(() => {
    clearTable('heartbeats');
    clearSyncMeta();
  });

  it('syncs heartbeat.json into heartbeats table', () => {
    writeJSON('state/builder/heartbeat.json', {
      status: 'idle',
      current_task: null,
      mode: 'loop',
      last_heartbeat: '2025-01-01T12:00:00Z',
      uptime_seconds: 3600,
      org: 'testorg',
    });

    const ok = syncHeartbeat('builder');
    expect(ok).toBe(true);

    const row = db.prepare('SELECT * FROM heartbeats WHERE agent = ?').get('builder') as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row.status).toBe('idle');
    expect(row.uptime_seconds).toBe(3600);
  });

  it('returns false for missing heartbeat file', () => {
    const ok = syncHeartbeat('no-agent');
    expect(ok).toBe(false);
  });
});

describe('syncAll', () => {
  beforeEach(() => {
    clearTable('tasks');
    clearTable('approvals');
    clearTable('events');
    clearTable('heartbeats');
    clearSyncMeta();
    // Remove filesystem dirs so syncAll only sees what this test creates
    fs.rmSync(path.join(tmpDir, 'orgs'), { recursive: true, force: true });
    fs.rmSync(path.join(tmpDir, 'state'), { recursive: true, force: true });
  });

  it('returns correct counts across multiple orgs', () => {
    fs.mkdirSync(path.join(tmpDir, 'orgs', 'allorg', 'agents', 'agent1'), { recursive: true });

    writeJSON('orgs/allorg/tasks/t1.json', {
      id: 't1',
      title: 'T1',
      status: 'pending',
      created_at: '2025-01-01T00:00:00Z',
    });
    writeJSON('orgs/allorg/approvals/pending/a1.json', {
      id: 'a1',
      title: 'A1',
      agent: 'x',
      created_at: '2025-01-01T00:00:00Z',
    });
    writeText(
      'orgs/allorg/analytics/events/agent1/2025-01-01.jsonl',
      JSON.stringify({ id: 'ev1', timestamp: '2025-01-01T00:00:00Z', type: 'action' }) + '\n',
    );
    writeJSON('state/agent1/heartbeat.json', {
      status: 'active',
      org: 'allorg',
    });

    const result = syncAll();
    expect(result.tasks).toBe(1);
    expect(result.approvals).toBe(1);
    expect(result.events).toBe(1);
    expect(result.heartbeats).toBe(1);
  });
});

describe('syncFile routing', () => {
  beforeEach(() => {
    clearTable('tasks');
    clearTable('approvals');
    clearTable('events');
    clearTable('heartbeats');
    clearSyncMeta();
  });

  it('routes task file to syncTasks', () => {
    writeJSON('orgs/routeorg/tasks/t-route.json', {
      id: 't-route',
      title: 'Routed',
      status: 'pending',
      created_at: '2025-01-01T00:00:00Z',
    });

    syncFile(path.join(tmpDir, 'orgs/routeorg/tasks/t-route.json'));

    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get('t-route');
    expect(row).toBeTruthy();
  });

  it('routes approval file to syncApprovals', () => {
    writeJSON('orgs/routeorg/approvals/pending/a-route.json', {
      id: 'a-route',
      title: 'Approval Route',
      agent: 'x',
      created_at: '2025-01-01T00:00:00Z',
    });

    syncFile(path.join(tmpDir, 'orgs/routeorg/approvals/pending/a-route.json'));

    const row = db.prepare('SELECT * FROM approvals WHERE id = ?').get('a-route');
    expect(row).toBeTruthy();
  });

  it('routes event JSONL to syncEvents', () => {
    writeText(
      'orgs/routeorg/analytics/events/bot/2025-01-01.jsonl',
      JSON.stringify({ id: 'ev-route', timestamp: '2025-01-01T00:00:00Z', type: 'action' }) + '\n',
    );

    syncFile(path.join(tmpDir, 'orgs/routeorg/analytics/events/bot/2025-01-01.jsonl'));

    const row = db.prepare('SELECT * FROM events WHERE id = ?').get('ev-route');
    expect(row).toBeTruthy();
  });

  it('routes heartbeat file to syncHeartbeat', () => {
    writeJSON('state/routebot/heartbeat.json', {
      status: 'idle',
      org: '',
    });

    syncFile(path.join(tmpDir, 'state/routebot/heartbeat.json'));

    const row = db.prepare('SELECT * FROM heartbeats WHERE agent = ?').get('routebot');
    expect(row).toBeTruthy();
  });
});

describe('path extraction helpers', () => {
  it('extractOrgFromPath returns correct org', () => {
    expect(extractOrgFromPath('/home/user/.cortextos/orgs/acme/tasks/t.json')).toBe('acme');
    expect(extractOrgFromPath('/no/org/path')).toBeNull();
  });

  it('extractOrgAndAgentFromEventPath returns org and agent', () => {
    const result = extractOrgAndAgentFromEventPath(
      '/home/user/.cortextos/orgs/acme/analytics/events/builder/2025.jsonl',
    );
    expect(result.org).toBe('acme');
    expect(result.agent).toBe('builder');
  });

  it('extractAgentFromStatePath returns agent', () => {
    expect(extractAgentFromStatePath('/home/user/.cortextos/state/planner/heartbeat.json')).toBe('planner');
    expect(extractAgentFromStatePath('/no/state/path')).toBeNull();
  });
});
