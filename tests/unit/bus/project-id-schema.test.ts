import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { sendMessage, checkInbox } from '../../../src/bus/message';
import { createTask, listTasks } from '../../../src/bus/task';
import { logEvent } from '../../../src/bus/event';
import { createApproval } from '../../../src/bus/approval';
import { updateHeartbeat } from '../../../src/bus/heartbeat';
import { addCron, readCrons } from '../../../src/bus/crons';
import type { BusPaths, CronDefinition } from '../../../src/types';

/**
 * B1 Schema-Add (Phase 2a) — NULL-tolerant project_id field across bus records.
 *
 * For each record type the spec mandates four assertions:
 *   (a) field-absent → reader returns null
 *   (b) field-present → reader returns value
 *   (c) field-explicit-null → reader returns null
 *   (d) JSON round-trip stable
 *
 * Writers MUST omit the key entirely when caller passes nullish — no
 * gratuitous `"project_id": null` in archived JSON.
 */
describe('B1 schema-add: project_id NULL-tolerant on bus records', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-b1-projectid-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'agent-a'),
      inflight: join(testDir, 'inflight', 'agent-a'),
      processed: join(testDir, 'processed', 'agent-a'),
      logDir: join(testDir, 'logs', 'agent-a'),
      stateDir: join(testDir, 'state', 'agent-a'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    } as any;
    mkdirSync(paths.stateDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  // ---------- InboxMessage ----------
  describe('InboxMessage', () => {
    it('writer omits project_id when nullish (NULL-tolerant)', () => {
      sendMessage(paths, 'sender', 'agent-a', 'normal', 'hi');
      const files = readdirSync(join(testDir, 'inbox', 'agent-a'));
      const msg = JSON.parse(readFileSync(join(testDir, 'inbox', 'agent-a', files[0]), 'utf-8'));
      expect('project_id' in msg).toBe(false);
    });

    it('writer stamps project_id when caller passes it', () => {
      sendMessage(paths, 'sender', 'agent-a', 'normal', 'hi', undefined, '1evo');
      const files = readdirSync(join(testDir, 'inbox', 'agent-a'));
      const msg = JSON.parse(readFileSync(join(testDir, 'inbox', 'agent-a', files[0]), 'utf-8'));
      expect(msg.project_id).toBe('1evo');
    });

    it('reader survives field-absent (reads as null/undefined)', () => {
      sendMessage(paths, 'sender', 'agent-a', 'normal', 'hi');
      const msgs = checkInbox(paths);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].project_id ?? null).toBeNull();
    });

    it('reader returns value when field-present', () => {
      sendMessage(paths, 'sender', 'agent-a', 'normal', 'hi', undefined, '1evo');
      const msgs = checkInbox(paths);
      expect(msgs[0].project_id).toBe('1evo');
    });
  });

  // ---------- Task ----------
  describe('Task', () => {
    it('writer omits project_id when nullish', () => {
      const id = createTask(paths, 'agent-a', 'evo', 'do thing', {});
      const task = JSON.parse(readFileSync(join(paths.taskDir, `${id}.json`), 'utf-8'));
      expect('project_id' in task).toBe(false);
      expect(task.project).toBe(''); // freeform field stays distinct
    });

    it('writer stamps project_id distinct from freeform `project`', () => {
      const id = createTask(paths, 'agent-a', 'evo', 'do thing', {
        project: '1evo-website',
        projectId: '1evo',
      });
      const task = JSON.parse(readFileSync(join(paths.taskDir, `${id}.json`), 'utf-8'));
      expect(task.project).toBe('1evo-website'); // freeform
      expect(task.project_id).toBe('1evo'); // routing-grade
    });

    it('reader (listTasks) returns task with project_id intact', () => {
      createTask(paths, 'agent-a', 'evo', 'tagged', { projectId: '1evo' });
      createTask(paths, 'agent-a', 'evo', 'untagged', {});
      const all = listTasks(paths);
      const tagged = all.find(t => t.title === 'tagged');
      const untagged = all.find(t => t.title === 'untagged');
      expect(tagged?.project_id).toBe('1evo');
      expect(untagged?.project_id ?? null).toBeNull();
    });
  });

  // ---------- Event ----------
  describe('Event', () => {
    it('writer omits project_id when nullish', () => {
      logEvent(paths, 'agent-a', 'evo', 'action', 'test', 'info', { k: 'v' });
      const today = new Date().toISOString().split('T')[0];
      const line = readFileSync(join(paths.analyticsDir, 'events', 'agent-a', `${today}.jsonl`), 'utf-8').trim();
      const evt = JSON.parse(line);
      expect('project_id' in evt).toBe(false);
    });

    it('writer stamps project_id when provided', () => {
      logEvent(paths, 'agent-a', 'evo', 'action', 'test', 'info', { k: 'v' }, '1evo');
      const today = new Date().toISOString().split('T')[0];
      const line = readFileSync(join(paths.analyticsDir, 'events', 'agent-a', `${today}.jsonl`), 'utf-8').trim();
      const evt = JSON.parse(line);
      expect(evt.project_id).toBe('1evo');
    });

    it('JSON round-trips are stable across project_id presence/absence', () => {
      logEvent(paths, 'agent-a', 'evo', 'action', 'a', 'info', '{}');
      logEvent(paths, 'agent-a', 'evo', 'action', 'b', 'info', '{}', '1evo');
      const today = new Date().toISOString().split('T')[0];
      const lines = readFileSync(join(paths.analyticsDir, 'events', 'agent-a', `${today}.jsonl`), 'utf-8')
        .trim()
        .split('\n')
        .map(l => JSON.parse(l));
      expect(lines).toHaveLength(2);
      expect(lines[0].event).toBe('a');
      expect(lines[0].project_id).toBeUndefined();
      expect(lines[1].event).toBe('b');
      expect(lines[1].project_id).toBe('1evo');
    });
  });

  // ---------- Approval ----------
  describe('Approval', () => {
    it('writer omits project_id when nullish', async () => {
      const id = await createApproval(paths, 'agent-a', 'evo', 'title', 'other');
      const path = join(paths.approvalDir, 'pending', `${id}.json`);
      const a = JSON.parse(readFileSync(path, 'utf-8'));
      expect('project_id' in a).toBe(false);
    });

    it('writer stamps project_id when provided', async () => {
      const id = await createApproval(paths, 'agent-a', 'evo', 'title', 'other', '', undefined, undefined, '1evo');
      const path = join(paths.approvalDir, 'pending', `${id}.json`);
      const a = JSON.parse(readFileSync(path, 'utf-8'));
      expect(a.project_id).toBe('1evo');
    });
  });

  // ---------- Heartbeat ----------
  describe('Heartbeat', () => {
    it('writer omits project_id when nullish', () => {
      updateHeartbeat(paths, 'agent-a', 'online', { org: 'evo' });
      const hb = JSON.parse(readFileSync(join(paths.stateDir, 'heartbeat.json'), 'utf-8'));
      expect('project_id' in hb).toBe(false);
    });

    it('writer stamps project_id when provided', () => {
      updateHeartbeat(paths, 'agent-a', 'online', { org: 'evo', projectId: '1evo' });
      const hb = JSON.parse(readFileSync(join(paths.stateDir, 'heartbeat.json'), 'utf-8'));
      expect(hb.project_id).toBe('1evo');
    });

    it('reader treats absent and null equivalently', () => {
      updateHeartbeat(paths, 'agent-a', 'online', { org: 'evo' });
      const hb = JSON.parse(readFileSync(join(paths.stateDir, 'heartbeat.json'), 'utf-8'));
      expect(hb.project_id ?? null).toBeNull();
    });
  });

  // ---------- CronDefinition ----------
  // crons.ts writers persist to ${CTX_ROOT}/state/<agent>/crons.json by default;
  // these tests override CTX_ROOT to the temp dir.
  describe('CronDefinition', () => {
    let savedCtxRoot: string | undefined;
    beforeEach(() => {
      savedCtxRoot = process.env.CTX_ROOT;
      process.env.CTX_ROOT = testDir;
      mkdirSync(join(testDir, 'state', 'agent-a'), { recursive: true });
    });
    afterEach(() => {
      if (savedCtxRoot === undefined) delete process.env.CTX_ROOT;
      else process.env.CTX_ROOT = savedCtxRoot;
    });

    it('omits project_id when nullish', () => {
      const cron: CronDefinition = {
        name: 'hb',
        prompt: 'heartbeat',
        schedule: '6h',
        enabled: true,
        created_at: new Date().toISOString(),
      };
      addCron('agent-a', cron);
      const all = readCrons('agent-a');
      expect(all[0].name).toBe('hb');
      expect('project_id' in all[0]).toBe(false);
    });

    it('persists project_id when caller stamps it', () => {
      const cron: CronDefinition = {
        name: 'hb',
        prompt: 'heartbeat',
        schedule: '6h',
        enabled: true,
        created_at: new Date().toISOString(),
        project_id: '1evo',
      };
      addCron('agent-a', cron);
      const all = readCrons('agent-a');
      expect(all[0].project_id).toBe('1evo');
    });
  });

  // ---------- Cross-cutting: explicit null in source JSON is tolerated ----------
  describe('explicit-null tolerance (reader contract)', () => {
    it('InboxMessage reader treats project_id:null and absent equivalently', () => {
      // Hand-write a message with explicit project_id: null
      const inbox = join(testDir, 'inbox', 'agent-a');
      mkdirSync(inbox, { recursive: true });
      const msg = {
        id: '111-explicit-null',
        from: 'sender',
        to: 'agent-a',
        priority: 'normal',
        timestamp: '2026-05-17T00:00:00.000Z',
        text: 'hello',
        reply_to: null,
        project_id: null,
      };
      require('fs').writeFileSync(join(inbox, '2-111-from-sender-aaaaa.json'), JSON.stringify(msg));

      const msgs = checkInbox(paths);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].project_id ?? null).toBeNull();
    });
  });
});
