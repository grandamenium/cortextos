import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';

// Import bus functions for verification
import { sendMessage, checkInbox, ackInbox } from '../../src/bus/message';
import { createTask, updateTask, completeTask, listTasks } from '../../src/bus/task';
import { logEvent } from '../../src/bus/event';
import { updateHeartbeat, readAllHeartbeats } from '../../src/bus/heartbeat';
import { createApproval } from '../../src/bus/approval';
import { resolvePaths } from '../../src/utils/paths';
import type { BusPaths } from '../../src/types';

describe('E2E Lifecycle', () => {
  let testDir: string;
  let ctxRoot: string;

  function makePaths(agent: string): BusPaths {
    return {
      ctxRoot,
      inbox: join(ctxRoot, 'inbox', agent),
      inflight: join(ctxRoot, 'inflight', agent),
      processed: join(ctxRoot, 'processed', agent),
      logDir: join(ctxRoot, 'logs', agent),
      stateDir: join(ctxRoot, 'state', agent),
      taskDir: join(ctxRoot, 'orgs', 'test-org', 'tasks'),
      approvalDir: join(ctxRoot, 'orgs', 'test-org', 'approvals'),
      analyticsDir: join(ctxRoot, 'orgs', 'test-org', 'analytics'),
      heartbeatDir: join(ctxRoot, 'heartbeats'),
    };
  }

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-e2e-'));
    ctxRoot = join(testDir, '.cortextos', 'test');
    mkdirSync(ctxRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('Full message lifecycle', () => {
    it('send -> check -> ack round-trip', () => {
      const paulPaths = makePaths('paul');
      const borisPaths = makePaths('boris');

      // Paul sends to Boris
      const msgId = sendMessage(paulPaths, 'paul', 'boris', 'high', 'Build the landing page');

      // Boris checks inbox
      const messages = checkInbox(borisPaths);
      expect(messages.length).toBe(1);
      expect(messages[0].from).toBe('paul');
      expect(messages[0].text).toBe('Build the landing page');
      expect(messages[0].priority).toBe('high');

      // Boris ACKs
      ackInbox(borisPaths, msgId);

      // Verify message moved through inbox -> inflight -> processed
      const inboxFiles = readdirSync(borisPaths.inbox).filter(f => f.endsWith('.json'));
      const inflightFiles = readdirSync(borisPaths.inflight).filter(f => f.endsWith('.json'));
      const processedFiles = readdirSync(borisPaths.processed).filter(f => f.endsWith('.json'));

      expect(inboxFiles.length).toBe(0);
      expect(inflightFiles.length).toBe(0);
      expect(processedFiles.length).toBe(1);
    });

    it('priority ordering works correctly', () => {
      const senderPaths = makePaths('sender');
      const receiverPaths = makePaths('receiver');

      sendMessage(senderPaths, 'sender', 'receiver', 'low', 'low');
      sendMessage(senderPaths, 'sender', 'receiver', 'urgent', 'urgent');
      sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'normal');
      sendMessage(senderPaths, 'sender', 'receiver', 'high', 'high');

      const messages = checkInbox(receiverPaths);
      expect(messages.map(m => m.priority)).toEqual(['urgent', 'high', 'normal', 'low']);
    });
  });

  describe('Full task lifecycle', () => {
    it('create -> update -> complete', () => {
      const paths = makePaths('paul');

      // Create task
      const taskId = createTask(paths, 'paul', 'test-org', 'Build landing page', {
        assignee: 'boris',
        priority: 'high',
        description: 'A product landing page with hero section',
      });

      // Verify created
      let tasks = listTasks(paths);
      expect(tasks.length).toBe(1);
      expect(tasks[0].status).toBe('pending');

      // Update to in_progress
      updateTask(paths, taskId, 'in_progress');
      tasks = listTasks(paths, { status: 'in_progress' });
      expect(tasks.length).toBe(1);

      // Complete
      completeTask(paths, taskId, 'Landing page deployed at /landing');
      tasks = listTasks(paths, { status: 'completed' });
      expect(tasks.length).toBe(1);
      expect(tasks[0].result).toBe('Landing page deployed at /landing');
      expect(tasks[0].completed_at).toBeTruthy();
    });
  });

  describe('Event logging', () => {
    it('appends JSONL events', () => {
      const paths = makePaths('paul');

      logEvent(paths, 'paul', 'test-org', 'action', 'session_start', 'info', { test: true });
      logEvent(paths, 'paul', 'test-org', 'task', 'task_completed', 'info', { task_id: 't1' });

      const today = new Date().toISOString().split('T')[0];
      const eventFile = join(paths.analyticsDir, 'events', 'paul', `${today}.jsonl`);
      expect(existsSync(eventFile)).toBe(true);

      const lines = readFileSync(eventFile, 'utf-8').trim().split('\n');
      expect(lines.length).toBe(2);

      const event1 = JSON.parse(lines[0]);
      expect(event1.event).toBe('session_start');
      expect(event1.category).toBe('action');
      expect(event1.agent).toBe('paul');
    });
  });

  describe('Heartbeat', () => {
    it('write and read heartbeats', () => {
      const paulPaths = makePaths('paul');
      const borisPaths = makePaths('boris');

      updateHeartbeat(paulPaths, 'paul', 'working on task_123');
      updateHeartbeat(borisPaths, 'boris', 'idle - awaiting instructions');

      const heartbeats = readAllHeartbeats(paulPaths);
      expect(heartbeats.length).toBe(2);

      const paulHb = heartbeats.find(h => h.agent === 'paul');
      expect(paulHb?.status).toBe('working on task_123');
    });
  });

  describe('Multi-agent coordination', () => {
    it('orchestrator dispatches tasks and agents report back', () => {
      const paulPaths = makePaths('paul');
      const borisPaths = makePaths('boris');
      const sentinelPaths = makePaths('sentinel');

      // Paul (orchestrator) creates a task for Boris
      const taskId = createTask(paulPaths, 'paul', 'test-org', 'Build API endpoint', {
        assignee: 'boris',
        priority: 'high',
      });

      // Paul sends message to Boris about the task
      sendMessage(paulPaths, 'paul', 'boris', 'high', `New task: ${taskId} - Build API endpoint`);

      // Boris checks inbox
      const borisMessages = checkInbox(borisPaths);
      expect(borisMessages.length).toBe(1);

      // Boris starts the task
      updateTask(borisPaths, taskId, 'in_progress');

      // Boris sends progress update to Paul
      sendMessage(borisPaths, 'boris', 'paul', 'normal', `Task ${taskId} in progress. ETA: 2h`);

      // Paul checks inbox
      const paulMessages = checkInbox(paulPaths);
      expect(paulMessages.length).toBe(1);
      expect(paulMessages[0].from).toBe('boris');

      // Boris completes the task
      completeTask(borisPaths, taskId, 'API endpoint deployed');
      sendMessage(borisPaths, 'boris', 'paul', 'normal', `Task ${taskId} complete`);

      // Paul asks sentinel to verify
      sendMessage(paulPaths, 'paul', 'sentinel', 'normal', 'Verify API endpoint health');

      // Verify all messages delivered
      const sentinelMessages = checkInbox(sentinelPaths);
      expect(sentinelMessages.length).toBe(1);

      // Final task status check
      const completedTasks = listTasks(paulPaths, { status: 'completed' });
      expect(completedTasks.length).toBe(1);
    });
  });

  describe('Approval workflow', () => {
    it('create and update approval', async () => {
      const paths = makePaths('nick');

      const approvalId = await createApproval(
        paths, 'nick', 'test-org',
        'Post to Skool community',
        'external-comms',
        'Weekly update post about agent architecture',
      );

      expect(approvalId).toMatch(/^approval_\d+_[a-z0-9]+$/);

      const pendingDir = join(paths.approvalDir, 'pending');
      const files = readdirSync(pendingDir).filter(f => f.endsWith('.json'));
      expect(files.length).toBe(1);

      const approval = JSON.parse(readFileSync(join(pendingDir, files[0]), 'utf-8'));
      expect(approval.status).toBe('pending');
      expect(approval.requesting_agent).toBe('nick');
      expect(approval.category).toBe('external-comms');
    });
  });

  describe('Format compatibility with bash', () => {
    it('message JSON has all required fields', () => {
      const paths = makePaths('test');
      sendMessage(paths, 'paul', 'boris', 'normal', 'test');

      const inboxDir = join(ctxRoot, 'inbox', 'boris');
      const files = readdirSync(inboxDir).filter(f => f.endsWith('.json'));
      const msg = JSON.parse(readFileSync(join(inboxDir, files[0]), 'utf-8'));

      // Verify exact field set matches bash send-message.sh
      const expectedFields = ['id', 'from', 'to', 'priority', 'timestamp', 'text', 'reply_to'];
      expect(Object.keys(msg).sort()).toEqual(expectedFields.sort());

      // Verify field types
      expect(typeof msg.id).toBe('string');
      expect(typeof msg.from).toBe('string');
      expect(typeof msg.to).toBe('string');
      expect(typeof msg.priority).toBe('string');
      expect(typeof msg.timestamp).toBe('string');
      expect(typeof msg.text).toBe('string');
      expect(msg.reply_to).toBeNull();

      // Verify timestamp format (ISO 8601)
      expect(msg.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

      // Verify ID format: {epochMs}-{from}-{rand5}
      expect(msg.id).toMatch(/^\d+-paul-[a-z0-9]{5}$/);
    });

    it('task JSON has all 17 required fields', () => {
      const paths = makePaths('paul');
      const taskId = createTask(paths, 'paul', 'test-org', 'Test', {
        assignee: 'boris',
        priority: 'high',
      });

      const task = JSON.parse(readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8'));

      const expectedFields = [
        'id', 'title', 'description', 'type', 'needs_approval', 'status',
        'assigned_to', 'created_by', 'org', 'priority', 'project',
        'kpi_key', 'created_at', 'updated_at', 'completed_at', 'due_date', 'archived',
      ];
      expect(Object.keys(task).sort()).toEqual(expectedFields.sort());
    });

    it('filename format matches bash convention', () => {
      const paths = makePaths('test');
      sendMessage(paths, 'paul', 'boris', 'urgent', 'test');

      const inboxDir = join(ctxRoot, 'inbox', 'boris');
      const files = readdirSync(inboxDir).filter(f => f.endsWith('.json'));

      // Format: {pnum}-{epochMs}-from-{sender}-{rand5}.json
      expect(files[0]).toMatch(/^0-\d+-from-paul-[a-z0-9]{5}\.json$/);
    });
  });
});
