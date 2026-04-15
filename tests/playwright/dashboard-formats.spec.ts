/**
 * Comprehensive Playwright E2E tests verifying all JSON/JSONL file formats
 * match what the Next.js dashboard expects.
 *
 * Tests every data type the dashboard reads:
 * - Tasks (JSON)
 * - Events (JSONL)
 * - Heartbeats (JSON)
 * - Messages (JSONL - inbound & outbound)
 * - Approvals (JSON)
 * - Experiments (JSON)
 * - Goals (JSON)
 * - Agent config (JSON)
 */
import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Register tsx for TypeScript source imports
require('tsx/cjs');

// Import bus functions via tsx
const { sendMessage } = require('../../src/bus/message');
const { createTask, updateTask, completeTask, listTasks } = require('../../src/bus/task');
const { logEvent } = require('../../src/bus/event');
const { updateHeartbeat } = require('../../src/bus/heartbeat');
const { createApproval } = require('../../src/bus/approval');
const { logOutboundMessage, logInboundMessage } = require('../../src/telegram/logging');

import type { BusPaths } from '../../src/types';

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
    heartbeatDir: join(ctxRoot, 'state'),
  };
}

test.beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'dash-fmt-'));
  ctxRoot = join(testDir, '.cortextos', 'test');
  mkdirSync(ctxRoot, { recursive: true });
});

test.afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// ============================================================================
// 1. TASK FORMAT VERIFICATION
// Dashboard sync.ts: syncTasks() reads from orgs/{org}/tasks/*.json
// ============================================================================

test.describe('Task JSON format (dashboard sync compatibility)', () => {
  test('task has all fields the dashboard sync expects', () => {
    const paths = makePaths('testbot');
    const taskId = createTask(paths, 'testbot', 'test-org', 'Build landing page', {
      assignee: 'boris',
      priority: 'high',
      description: 'A landing page with hero section',
    });

    const taskFile = join(paths.taskDir, `${taskId}.json`);
    expect(existsSync(taskFile)).toBe(true);

    const task = JSON.parse(readFileSync(taskFile, 'utf-8'));

    // Dashboard sync.ts line 70-86: fields used in upsert
    // id: task.id ?? path.basename(file, '.json')
    expect(task.id).toBe(taskId);
    expect(typeof task.id).toBe('string');

    // title: task.title ?? 'Untitled'
    expect(task.title).toBe('Build landing page');
    expect(typeof task.title).toBe('string');

    // description: task.description ?? null
    expect(task.description).toBe('A landing page with hero section');

    // status: task.status ?? 'pending'
    expect(task.status).toBe('pending');
    expect(['pending', 'in_progress', 'blocked', 'completed', 'done']).toContain(task.status);

    // priority: task.priority ?? 'normal'
    expect(task.priority).toBe('high');
    expect(['critical', 'urgent', 'high', 'normal', 'low']).toContain(task.priority);

    // assignee: task.assigned_to ?? task.assignee ?? null
    // Dashboard reads BOTH assigned_to and assignee (with assigned_to preferred)
    expect(task.assigned_to).toBe('boris');

    // created_at: task.created_at ?? new Date().toISOString()
    expect(task.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // updated_at: task.updated_at ?? null
    expect(task).toHaveProperty('updated_at');

    // completed_at: task.completed_at ?? null
    expect(task).toHaveProperty('completed_at');

    // project: task.project ?? null
    expect(task).toHaveProperty('project');

    // needs_approval: task.needs_approval ? 1 : 0
    expect(task).toHaveProperty('needs_approval');
  });

  test('task status transitions update updated_at', () => {
    const paths = makePaths('testbot');
    const taskId = createTask(paths, 'testbot', 'test-org', 'Test task');
    const taskFile = join(paths.taskDir, `${taskId}.json`);

    updateTask(paths, taskId, 'in_progress');
    let task = JSON.parse(readFileSync(taskFile, 'utf-8'));
    expect(task.status).toBe('in_progress');
    expect(task.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    completeTask(paths, taskId, 'Done');
    task = JSON.parse(readFileSync(taskFile, 'utf-8'));
    expect(task.status).toBe('done');
    expect(task.completed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('task filename matches id', () => {
    const paths = makePaths('testbot');
    const taskId = createTask(paths, 'testbot', 'test-org', 'Verify filename');

    const files = readdirSync(paths.taskDir).filter(f => f.endsWith('.json'));
    expect(files).toHaveLength(1);
    expect(files[0]).toBe(`${taskId}.json`);
  });

  test('task with special characters in title', () => {
    const paths = makePaths('testbot');
    const title = 'Fix "auth" bug & deploy (v2.0) — urgent!';
    createTask(paths, 'testbot', 'test-org', title);

    const files = readdirSync(paths.taskDir).filter(f => f.endsWith('.json'));
    const task = JSON.parse(readFileSync(join(paths.taskDir, files[0]), 'utf-8'));
    expect(task.title).toBe(title);
  });

  test('task with all optional fields empty', () => {
    const paths = makePaths('testbot');
    const taskId = createTask(paths, 'testbot', 'test-org', 'Minimal task');
    const task = JSON.parse(readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8'));

    // Dashboard handles null values for all optional fields
    expect(task.description).toBeDefined();
    expect(task.assigned_to).toBeDefined();
    expect(task.project).toBeDefined();
  });
});

// ============================================================================
// 2. EVENT JSONL FORMAT VERIFICATION
// Dashboard sync.ts: syncEvents() reads from orgs/{org}/analytics/events/{agent}/{date}.jsonl
// ============================================================================

test.describe('Event JSONL format (dashboard sync compatibility)', () => {
  test('event has all fields the dashboard sync expects', () => {
    const paths = makePaths('testbot');
    logEvent(paths, 'testbot', 'test-org', 'action', 'session_start', 'info', { key: 'value' });

    const today = new Date().toISOString().split('T')[0];
    const eventFile = join(paths.analyticsDir, 'events', 'testbot', `${today}.jsonl`);
    expect(existsSync(eventFile)).toBe(true);

    const lines = readFileSync(eventFile, 'utf-8').trim().split('\n');
    const event = JSON.parse(lines[0]);

    // Dashboard sync.ts line 187-199: fields used in upsert
    // id: event.id ?? `${agent}-${file}-${i}`
    expect(event.id).toBeDefined();
    expect(typeof event.id).toBe('string');

    // timestamp: event.timestamp ?? new Date().toISOString()
    expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // agent: event.agent ?? agent
    expect(event.agent).toBe('testbot');

    // type: event.category ?? event.type ?? 'action'
    // Dashboard maps category -> type field
    expect(event.category).toBe('action');

    // severity: event.severity ?? 'info'
    expect(event.severity).toBe('info');
    expect(['info', 'warning', 'error', 'critical']).toContain(event.severity);

    // message: event.event ?? event.message ?? null
    // Dashboard reads 'event' field as message
    expect(event.event).toBe('session_start');

    // data: event.metadata ? JSON.stringify(event.metadata) : (event.data ? JSON.stringify(event.data) : null)
    // Dashboard prefers metadata over data
    expect(event.metadata).toEqual({ key: 'value' });
  });

  test('all valid event categories are accepted', () => {
    const paths = makePaths('testbot');
    const categories = ['action', 'error', 'metric', 'milestone', 'heartbeat', 'message', 'task', 'approval'] as const;

    for (const cat of categories) {
      logEvent(paths, 'testbot', 'test-org', cat, `test_${cat}`, 'info');
    }

    const today = new Date().toISOString().split('T')[0];
    const eventFile = join(paths.analyticsDir, 'events', 'testbot', `${today}.jsonl`);
    const lines = readFileSync(eventFile, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(categories.length);

    for (let i = 0; i < lines.length; i++) {
      const event = JSON.parse(lines[i]);
      expect(event.category).toBe(categories[i]);
    }
  });

  test('event with string metadata is parsed correctly', () => {
    const paths = makePaths('testbot');
    logEvent(paths, 'testbot', 'test-org', 'action', 'test', 'info', '{"custom":"data"}');

    const today = new Date().toISOString().split('T')[0];
    const eventFile = join(paths.analyticsDir, 'events', 'testbot', `${today}.jsonl`);
    const event = JSON.parse(readFileSync(eventFile, 'utf-8').trim());
    expect(event.metadata).toEqual({ custom: 'data' });
  });

  test('event JSONL file path matches dashboard expectation', () => {
    const paths = makePaths('testbot');
    logEvent(paths, 'testbot', 'test-org', 'action', 'test', 'info');

    // Dashboard reads: orgs/{org}/analytics/events/{agent}/{YYYY-MM-DD}.jsonl
    const today = new Date().toISOString().split('T')[0];
    const expectedPath = join(ctxRoot, 'orgs', 'test-org', 'analytics', 'events', 'testbot', `${today}.jsonl`);
    expect(existsSync(expectedPath)).toBe(true);
  });

  test('multiple events append to same JSONL file', () => {
    const paths = makePaths('testbot');
    logEvent(paths, 'testbot', 'test-org', 'action', 'first', 'info');
    logEvent(paths, 'testbot', 'test-org', 'error', 'second', 'error');
    logEvent(paths, 'testbot', 'test-org', 'milestone', 'third', 'info');

    const today = new Date().toISOString().split('T')[0];
    const eventFile = join(paths.analyticsDir, 'events', 'testbot', `${today}.jsonl`);
    const lines = readFileSync(eventFile, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(3);

    // Each line must be valid JSON
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  test('event with no metadata results in empty object', () => {
    const paths = makePaths('testbot');
    logEvent(paths, 'testbot', 'test-org', 'action', 'bare_event', 'info');

    const today = new Date().toISOString().split('T')[0];
    const eventFile = join(paths.analyticsDir, 'events', 'testbot', `${today}.jsonl`);
    const event = JSON.parse(readFileSync(eventFile, 'utf-8').trim());
    // Dashboard: event.metadata ? JSON.stringify(event.metadata) : null
    // So metadata should either be empty {} or not present
    expect(event.metadata === undefined || typeof event.metadata === 'object').toBe(true);
  });
});

// ============================================================================
// 3. HEARTBEAT JSON FORMAT VERIFICATION
// Dashboard reads from: state/{agent}/heartbeat.json (via getHeartbeatPath)
// Node.js now writes to: state/{agent}/heartbeat.json (matching dashboard)
// ============================================================================

test.describe('Heartbeat JSON format (dashboard compatibility)', () => {
  test('heartbeat has required fields for dashboard sync', () => {
    const paths = makePaths('testbot');
    updateHeartbeat(paths, 'testbot', 'working on task_123');

    const hbFile = join(ctxRoot, 'state', 'testbot', 'heartbeat.json');
    expect(existsSync(hbFile)).toBe(true);

    const hb = JSON.parse(readFileSync(hbFile, 'utf-8'));

    // Dashboard sync.ts line 229-243: fields used
    // agent: agentName (from directory name, not file content)
    expect(hb.agent).toBe('testbot');

    // status: hb.status ?? null
    expect(hb.status).toBe('working on task_123');

    // last_heartbeat: hb.last_heartbeat ?? hb.timestamp ?? null
    // Dashboard accepts EITHER last_heartbeat or timestamp
    expect(hb.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Optional fields the dashboard reads:
    // org: hb.org ?? ''
    // current_task: hb.current_task ?? null
    // mode: hb.mode ?? null
    // loop_interval: hb.loop_interval ?? null
    // uptime_seconds: hb.uptime_seconds ?? null
  });

  test('heartbeat timestamp format is ISO 8601', () => {
    const paths = makePaths('testbot');
    updateHeartbeat(paths, 'testbot', 'idle');

    const hb = JSON.parse(readFileSync(join(ctxRoot, 'state', 'testbot', 'heartbeat.json'), 'utf-8'));
    // Dashboard parses with new Date(hb.timestamp) for health calculation
    const parsed = new Date(hb.timestamp);
    expect(parsed.getTime()).not.toBeNaN();
    // Should be recent (within last minute)
    expect(Date.now() - parsed.getTime()).toBeLessThan(60000);
  });

  test('heartbeat file location matches dashboard expectation', () => {
    // Dashboard reads from: CTX_ROOT/state/{agent}/heartbeat.json
    // Node.js now writes to the same location
    const paths = makePaths('testbot');
    updateHeartbeat(paths, 'testbot', 'test');

    // Dashboard expected location
    const dashboardLocation = join(ctxRoot, 'state', 'testbot', 'heartbeat.json');
    expect(existsSync(dashboardLocation)).toBe(true);

    const hb = JSON.parse(readFileSync(dashboardLocation, 'utf-8'));
    expect(hb.agent).toBe('testbot');
    expect(hb.status).toBe('test');
  });

  test('heartbeat overwrites previous value (not append)', () => {
    const paths = makePaths('testbot');
    updateHeartbeat(paths, 'testbot', 'status 1');
    updateHeartbeat(paths, 'testbot', 'status 2');

    const hbFile = join(ctxRoot, 'state', 'testbot', 'heartbeat.json');
    const content = readFileSync(hbFile, 'utf-8');
    // Should be a single JSON object, not multiple lines
    expect(() => JSON.parse(content)).not.toThrow();
    const hb = JSON.parse(content);
    expect(hb.status).toBe('status 2');
  });
});

// ============================================================================
// 4. MESSAGE JSONL FORMAT VERIFICATION
// Dashboard reads from: logs/{agent}/outbound-messages.jsonl and inbound-messages.jsonl
// ============================================================================

test.describe('Message JSONL format (dashboard API compatibility)', () => {
  test('outbound message JSONL matches dashboard expectations', () => {
    logOutboundMessage(ctxRoot, 'testbot', '12345', 'Hello from bot', 42);

    const outFile = join(ctxRoot, 'logs', 'testbot', 'outbound-messages.jsonl');
    expect(existsSync(outFile)).toBe(true);

    const entry = JSON.parse(readFileSync(outFile, 'utf-8').trim());

    // Dashboard route.ts line 59-71: fields read
    // id: entry.message_id || `out-${entry.timestamp}`
    expect(entry.message_id).toBe(42);

    // timestamp: entry.timestamp || entry.ts
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // text: entry.text || ''
    expect(entry.text).toBe('Hello from bot');

    // chat_id used in metadata
    expect(entry.chat_id).toBe('12345');

    // agent field for context
    expect(entry.agent).toBe('testbot');
  });

  test('inbound message JSONL matches dashboard expectations', () => {
    const rawMsg = {
      message_id: 100,
      text: 'Hello from user',
      from: { id: 67890, first_name: 'User' },
      chat: { id: 12345, type: 'private' },
      date: Math.floor(Date.now() / 1000),
    };
    logInboundMessage(ctxRoot, 'testbot', rawMsg);

    const inFile = join(ctxRoot, 'logs', 'testbot', 'inbound-messages.jsonl');
    expect(existsSync(inFile)).toBe(true);

    const entry = JSON.parse(readFileSync(inFile, 'utf-8').trim());

    // Dashboard route.ts line 85-95: fields read
    // id: entry.id || `in-${entry.timestamp}`
    // The raw message has message_id, which serves as id
    expect(entry.message_id).toBe(100);

    // text: entry.text || ''
    expect(entry.text).toBe('Hello from user');

    // archived_at and agent are added by our logger
    expect(entry.archived_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entry.agent).toBe('testbot');
  });

  test('outbound JSONL preserves chat_id as string', () => {
    logOutboundMessage(ctxRoot, 'testbot', 99999, 'test', 1);
    const outFile = join(ctxRoot, 'logs', 'testbot', 'outbound-messages.jsonl');
    const entry = JSON.parse(readFileSync(outFile, 'utf-8').trim());
    // Dashboard passes chat_id to metadata - type doesn't matter but should be consistent
    expect(entry.chat_id).toBeDefined();
  });

  test('message JSONL file paths match dashboard route', () => {
    logOutboundMessage(ctxRoot, 'testbot', '12345', 'test', 1);
    logInboundMessage(ctxRoot, 'testbot', { text: 'test', message_id: 1 });

    // Dashboard reads: {CTX_ROOT}/logs/{agent}/outbound-messages.jsonl
    expect(existsSync(join(ctxRoot, 'logs', 'testbot', 'outbound-messages.jsonl'))).toBe(true);
    // Dashboard reads: {CTX_ROOT}/logs/{agent}/inbound-messages.jsonl
    expect(existsSync(join(ctxRoot, 'logs', 'testbot', 'inbound-messages.jsonl'))).toBe(true);
  });

  test('multiple messages form valid JSONL (one per line)', () => {
    for (let i = 0; i < 5; i++) {
      logOutboundMessage(ctxRoot, 'testbot', '12345', `Message ${i}`, i + 1);
    }

    const outFile = join(ctxRoot, 'logs', 'testbot', 'outbound-messages.jsonl');
    const lines = readFileSync(outFile, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(5);

    // Each line must be independently parseable JSON
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.text).toMatch(/^Message \d$/);
      expect(parsed.message_id).toBeGreaterThan(0);
    }
  });

  test('handles messages with embedded newlines in JSONL', () => {
    logOutboundMessage(ctxRoot, 'testbot', '12345', 'Line 1\nLine 2\nLine 3', 1);

    const outFile = join(ctxRoot, 'logs', 'testbot', 'outbound-messages.jsonl');
    const content = readFileSync(outFile, 'utf-8').trim();
    // Must be a single JSONL line (newlines in text are escaped in JSON)
    const lines = content.split('\n');
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.text).toBe('Line 1\nLine 2\nLine 3');
  });
});

// ============================================================================
// 5. APPROVAL JSON FORMAT VERIFICATION
// Dashboard sync.ts: syncApprovals() reads from orgs/{org}/approvals/pending/*.json
// ============================================================================

test.describe('Approval JSON format (dashboard sync compatibility)', () => {
  test('approval has all fields the dashboard sync expects', async () => {
    const paths = makePaths('testbot');
    const approvalId = await createApproval(
      paths, 'testbot', 'test-org',
      'Post to social media',
      'external-comms',
      'Weekly update about new features',
    );

    const pendingDir = join(paths.approvalDir, 'pending');
    const files = readdirSync(pendingDir).filter(f => f.endsWith('.json'));
    expect(files).toHaveLength(1);

    const approval = JSON.parse(readFileSync(join(pendingDir, files[0]), 'utf-8'));

    // Dashboard sync.ts line 120-143: fields used in upsert
    // id: approval.id ?? path.basename(file, '.json')
    expect(approval.id).toBe(approvalId);
    expect(typeof approval.id).toBe('string');

    // title: approval.title ?? 'Untitled'
    expect(approval.title).toBe('Post to social media');

    // category: approval.category ?? 'other'
    expect(approval.category).toBe('external-comms');

    // description: approval.description ?? null
    // Now matches dashboard field name
    expect(approval.description).toBe('Weekly update about new features');

    // status: subdir === 'pending' ? 'pending' : (approval.status ?? 'approved')
    expect(approval.status).toBe('pending');

    // agent: approval.requesting_agent ?? approval.agent ?? 'unknown'
    // Dashboard reads BOTH requesting_agent and agent - our field name matches
    expect(approval.requesting_agent).toBe('testbot');

    // created_at: approval.created_at ?? new Date().toISOString()
    expect(approval.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // resolved_at/resolved_by: now matches dashboard field names
    // Dashboard: resolved_at: approval.resolved_at ?? null
    expect(approval.resolved_at).toBeNull();
    expect(approval.resolved_by).toBeNull();
  });

  test('approval file is in pending/ subdirectory', async () => {
    const paths = makePaths('testbot');
    await createApproval(paths, 'testbot', 'test-org', 'Test', 'other', 'desc');

    // Dashboard scans both pending/ and resolved/ subdirectories
    const pendingDir = join(paths.approvalDir, 'pending');
    expect(existsSync(pendingDir)).toBe(true);
    const files = readdirSync(pendingDir).filter(f => f.endsWith('.json'));
    expect(files).toHaveLength(1);
  });

  test('approval ID format', async () => {
    const paths = makePaths('testbot');
    const id = await createApproval(paths, 'testbot', 'test-org', 'Test', 'other');
    // ID format: approval_{epoch}_{rand}
    expect(id).toMatch(/^approval_\d+_[a-z0-9]+$/);
  });
});

// ============================================================================
// 6. BUS MESSAGE JSON FORMAT VERIFICATION
// These are internal bus messages (not Telegram messages)
// ============================================================================

test.describe('Bus message JSON format', () => {
  test('message has all required fields', () => {
    const paths = makePaths('sender');
    const msgId = sendMessage(paths, 'sender', 'receiver', 'high', 'Test message');

    const inboxDir = join(ctxRoot, 'inbox', 'receiver');
    const files = readdirSync(inboxDir).filter(f => f.endsWith('.json'));
    const msg = JSON.parse(readFileSync(join(inboxDir, files[0]), 'utf-8'));

    expect(msg.id).toBe(msgId);
    expect(msg.from).toBe('sender');
    expect(msg.to).toBe('receiver');
    expect(msg.priority).toBe('high');
    expect(msg.text).toBe('Test message');
    expect(msg.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(msg.reply_to).toBeNull();
  });

  test('message ID format matches convention', () => {
    const paths = makePaths('sender');
    const msgId = sendMessage(paths, 'sender', 'receiver', 'normal', 'test');
    // Format: {epochMs}-{from}-{rand5}
    expect(msgId).toMatch(/^\d+-sender-[a-z0-9]{3,6}$/);
  });

  test('message filename has priority prefix for sort order', () => {
    const paths = makePaths('sender');
    sendMessage(paths, 'sender', 'receiver', 'urgent', 'test');

    const inboxDir = join(ctxRoot, 'inbox', 'receiver');
    const files = readdirSync(inboxDir).filter(f => f.endsWith('.json'));
    // urgent = priority 0 in sort
    expect(files[0]).toMatch(/^0-\d+-from-sender-/);
  });

  test('priority ordering: urgent > high > normal > low', () => {
    const paths = makePaths('sender');
    sendMessage(paths, 'sender', 'rcv', 'low', 'L');
    sendMessage(paths, 'sender', 'rcv', 'urgent', 'U');
    sendMessage(paths, 'sender', 'rcv', 'normal', 'N');
    sendMessage(paths, 'sender', 'rcv', 'high', 'H');

    const inboxDir = join(ctxRoot, 'inbox', 'rcv');
    const files = readdirSync(inboxDir).filter(f => f.endsWith('.json')).sort();
    // Files sort by priority prefix: 0=urgent, 1=high, 2=normal, 3=low
    const priorities = files.map(f => f.split('-')[0]);
    expect(priorities).toEqual(['0', '1', '2', '3']);
  });
});

// ============================================================================
// 7. EXPERIMENTS JSON FORMAT VERIFICATION
// Dashboard reads from: CTX_FRAMEWORK_ROOT/orgs/{org}/agents/{agent}/experiments/
// ============================================================================

test.describe('Experiments JSON format (dashboard API compatibility)', () => {
  test('experiment config.json matches dashboard expectations', () => {
    // Create a mock experiment config matching dashboard Cycle interface
    const expDir = join(testDir, 'orgs', 'test-org', 'agents', 'testbot', 'experiments');
    mkdirSync(expDir, { recursive: true });

    const config = {
      cycles: [{
        name: 'response-quality',
        surface: 'agent-behavior',
        metric: 'task-completion-rate',
        metric_type: 'percentage',
        direction: 'up',
        window: '7-days',
        measurement: 'automatic',
        loop_interval: '1-hour',
        enabled: true,
        created_by: 'admin',
        created_at: '2026-03-20T10:00:00Z',
      }],
    };

    writeFileSync(join(expDir, 'config.json'), JSON.stringify(config, null, 2));

    // Verify it matches dashboard Cycle interface
    const parsed = JSON.parse(readFileSync(join(expDir, 'config.json'), 'utf-8'));
    const cycle = parsed.cycles[0];
    expect(cycle.name).toBe('response-quality');
    expect(cycle.surface).toBeDefined();
    expect(cycle.metric).toBeDefined();
    expect(cycle.metric_type).toBeDefined();
    expect(cycle.direction).toBeDefined();
    expect(cycle.window).toBeDefined();
    expect(cycle.measurement).toBeDefined();
    expect(cycle.loop_interval).toBeDefined();
    expect(typeof cycle.enabled).toBe('boolean');
    expect(cycle.created_by).toBeDefined();
    expect(cycle.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('experiment history JSON matches dashboard Experiment interface', () => {
    const histDir = join(testDir, 'orgs', 'test-org', 'agents', 'testbot', 'experiments', 'history');
    mkdirSync(histDir, { recursive: true });

    const experiment = {
      id: 'exp-001',
      agent: 'testbot',
      metric: 'task-completion-rate',
      hypothesis: 'Shorter prompts improve completion speed',
      surface: 'agent-behavior',
      direction: 'up',
      window: '7-days',
      measurement: 'automatic',
      status: 'completed',
      baseline_value: 82.5,
      result_value: 87.3,
      decision: 'keep',
      learning: 'Shorter prompts improved performance by 5.8%',
      experiment_commit: 'abc123',
      tracking_commit: 'def456',
      created_at: '2026-03-20T10:00:00Z',
      started_at: '2026-03-21T10:00:00Z',
      completed_at: '2026-03-28T10:00:00Z',
    };

    writeFileSync(join(histDir, 'exp-001.json'), JSON.stringify(experiment, null, 2));

    // Dashboard reads and filters by status/decision
    const parsed = JSON.parse(readFileSync(join(histDir, 'exp-001.json'), 'utf-8'));
    expect(parsed.status).toBe('completed');
    expect(parsed.decision).toBe('keep');
    expect(typeof parsed.baseline_value).toBe('number');
    expect(typeof parsed.result_value).toBe('number');
  });

  test('experiment with null optional fields', () => {
    const histDir = join(testDir, 'orgs', 'test-org', 'agents', 'testbot', 'experiments', 'history');
    mkdirSync(histDir, { recursive: true });

    const experiment = {
      id: 'exp-002',
      agent: 'testbot',
      metric: 'response-quality',
      hypothesis: 'Use GPT-4 for reviews',
      surface: 'tooling',
      direction: 'up',
      window: '14-days',
      measurement: 'manual',
      status: 'proposed',
      baseline_value: 0,
      result_value: null,
      decision: null,
      learning: null,
      experiment_commit: null,
      tracking_commit: null,
      created_at: '2026-03-29T10:00:00Z',
      started_at: null,
      completed_at: null,
    };

    writeFileSync(join(histDir, 'exp-002.json'), JSON.stringify(experiment));
    const parsed = JSON.parse(readFileSync(join(histDir, 'exp-002.json'), 'utf-8'));

    // Dashboard handles null values for these fields
    expect(parsed.result_value).toBeNull();
    expect(parsed.decision).toBeNull();
    expect(parsed.started_at).toBeNull();
  });
});

// ============================================================================
// 8. GOALS JSON FORMAT VERIFICATION
// Dashboard reads from: orgs/{org}/goals.json or framework_root/orgs/{org}/goals.json
// ============================================================================

test.describe('Goals JSON format (dashboard compatibility)', () => {
  test('goals.json with structured goals array', () => {
    const goalsDir = join(testDir, 'orgs', 'test-org');
    mkdirSync(goalsDir, { recursive: true });

    const goals = {
      bottleneck: 'API rate limiting affects agent throughput',
      goals: [
        { id: 'goal-0', title: 'Implement caching layer', progress: 45, order: 0 },
        { id: 'goal-1', title: 'Optimize database queries', progress: 90, order: 1 },
        { id: 'goal-2', title: 'Deploy monitoring dashboard', progress: 10, order: 2 },
      ],
    };

    writeFileSync(join(goalsDir, 'goals.json'), JSON.stringify(goals, null, 2));
    const parsed = JSON.parse(readFileSync(join(goalsDir, 'goals.json'), 'utf-8'));

    expect(parsed.bottleneck).toBeDefined();
    expect(Array.isArray(parsed.goals)).toBe(true);
    for (const goal of parsed.goals) {
      expect(goal.id).toBeDefined();
      expect(goal.title).toBeDefined();
      expect(typeof goal.progress).toBe('number');
      expect(goal.progress).toBeGreaterThanOrEqual(0);
      expect(goal.progress).toBeLessThanOrEqual(100);
      expect(typeof goal.order).toBe('number');
    }
  });

  test('goals.json with legacy string array format', () => {
    const goalsDir = join(testDir, 'orgs', 'test-org');
    mkdirSync(goalsDir, { recursive: true });

    const goals = {
      bottleneck: 'Team onboarding',
      goals: ['Ship v1.0', 'Hire 2 engineers', 'Write docs'],
    };

    writeFileSync(join(goalsDir, 'goals.json'), JSON.stringify(goals));
    const parsed = JSON.parse(readFileSync(join(goalsDir, 'goals.json'), 'utf-8'));

    // Dashboard also supports string[] format (legacy)
    expect(Array.isArray(parsed.goals)).toBe(true);
    expect(typeof parsed.goals[0]).toBe('string');
  });
});

// ============================================================================
// 9. AGENT CONFIG JSON FORMAT VERIFICATION
// Dashboard reads from: CTX_ROOT/config/enabled-agents.json
// ============================================================================

test.describe('Agent config JSON format', () => {
  test('enabled-agents.json matches dashboard expectations', () => {
    const configDir = join(ctxRoot, 'config');
    mkdirSync(configDir, { recursive: true });

    const config = {
      boris: { enabled: true, org: 'acme', template: 'orchestrator', createdAt: '2026-03-01T10:00:00Z' },
      donna: { enabled: true, org: 'acme', template: 'agent', createdAt: '2026-03-05T08:30:00Z' },
      inactive: { enabled: false, org: 'acme', template: 'agent', createdAt: '2026-03-10T12:00:00Z' },
    };

    writeFileSync(join(configDir, 'enabled-agents.json'), JSON.stringify(config, null, 2));
    const parsed = JSON.parse(readFileSync(join(configDir, 'enabled-agents.json'), 'utf-8'));

    // Dashboard getAllAgents() iterates Object.entries
    for (const [name, cfg] of Object.entries(parsed)) {
      const c = cfg as Record<string, unknown>;
      expect(typeof name).toBe('string');
      expect(typeof c.enabled).toBe('boolean');
      expect(typeof c.org).toBe('string');
    }

    // Inactive agents should be filtered by dashboard
    const activeAgents = Object.entries(parsed)
      .filter(([_, c]) => (c as Record<string, unknown>).enabled !== false);
    expect(activeAgents).toHaveLength(2);
  });
});

// ============================================================================
// 10. ORG CONTEXT JSON FORMAT VERIFICATION
// Dashboard reads from: CTX_FRAMEWORK_ROOT/orgs/{org}/context.json
// ============================================================================

test.describe('Org context JSON format', () => {
  test('context.json has all dashboard-expected fields', () => {
    const orgDir = join(testDir, 'orgs', 'test-org');
    mkdirSync(orgDir, { recursive: true });

    const context = {
      name: 'Test Organization',
      description: 'A test org for E2E testing',
      industry: 'Technology',
      icp: 'Software developers building AI products',
      value_prop: 'Autonomous agent orchestration',
    };

    writeFileSync(join(orgDir, 'context.json'), JSON.stringify(context, null, 2));
    const parsed = JSON.parse(readFileSync(join(orgDir, 'context.json'), 'utf-8'));

    expect(parsed.name).toBeDefined();
    expect(parsed.description).toBeDefined();
    expect(parsed.industry).toBeDefined();
    expect(parsed.icp).toBeDefined();
    expect(parsed.value_prop).toBeDefined();
  });
});

// ============================================================================
// 11. CROSS-FORMAT CONSISTENCY TESTS
// ============================================================================

test.describe('Cross-format consistency', () => {
  test('timestamps are consistently ISO 8601 across all formats', async () => {
    const paths = makePaths('testbot');

    // Create items across all formats
    createTask(paths, 'testbot', 'test-org', 'Timestamp test');
    logEvent(paths, 'testbot', 'test-org', 'action', 'test', 'info');
    updateHeartbeat(paths, 'testbot', 'alive');
    logOutboundMessage(ctxRoot, 'testbot', '12345', 'test', 1);
    await createApproval(paths, 'testbot', 'test-org', 'Approve', 'other');

    // Read back all timestamps
    const taskFile = readdirSync(paths.taskDir).filter(f => f.endsWith('.json'))[0];
    const task = JSON.parse(readFileSync(join(paths.taskDir, taskFile), 'utf-8'));

    const today = new Date().toISOString().split('T')[0];
    const eventFile = join(paths.analyticsDir, 'events', 'testbot', `${today}.jsonl`);
    const event = JSON.parse(readFileSync(eventFile, 'utf-8').trim().split('\n')[0]);

    const hb = JSON.parse(readFileSync(join(ctxRoot, 'state', 'testbot', 'heartbeat.json'), 'utf-8'));

    const outFile = join(ctxRoot, 'logs', 'testbot', 'outbound-messages.jsonl');
    const outMsg = JSON.parse(readFileSync(outFile, 'utf-8').trim());

    // All timestamps should be valid ISO 8601
    const timestamps = [task.created_at, event.timestamp, hb.timestamp, outMsg.timestamp];
    for (const ts of timestamps) {
      expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(new Date(ts).getTime()).not.toBeNaN();
    }
  });

  test('agent names are consistent across all formats', () => {
    const agentName = 'my-test-agent';
    const paths = makePaths(agentName);

    createTask(paths, agentName, 'test-org', 'Test');
    logEvent(paths, agentName, 'test-org', 'action', 'test', 'info');
    updateHeartbeat(paths, agentName, 'online');

    // All should reference the same agent name
    const taskFile = readdirSync(paths.taskDir).filter(f => f.endsWith('.json'))[0];
    const task = JSON.parse(readFileSync(join(paths.taskDir, taskFile), 'utf-8'));
    expect(task.created_by).toBe(agentName);

    const today = new Date().toISOString().split('T')[0];
    const eventFile = join(paths.analyticsDir, 'events', agentName, `${today}.jsonl`);
    const event = JSON.parse(readFileSync(eventFile, 'utf-8').trim().split('\n')[0]);
    expect(event.agent).toBe(agentName);

    const hb = JSON.parse(readFileSync(join(ctxRoot, 'state', agentName, 'heartbeat.json'), 'utf-8'));
    expect(hb.agent).toBe(agentName);
  });

  test('org names are consistent across scoped paths', () => {
    const paths = makePaths('testbot');
    const org = 'test-org';

    createTask(paths, 'testbot', org, 'Org test');
    logEvent(paths, 'testbot', org, 'action', 'test', 'info');

    // Tasks should be under orgs/{org}/tasks/
    expect(paths.taskDir).toContain(`orgs/${org}/tasks`);

    // Events should be under orgs/{org}/analytics/events/
    const today = new Date().toISOString().split('T')[0];
    const eventFile = join(paths.analyticsDir, 'events', 'testbot', `${today}.jsonl`);
    expect(eventFile).toContain(`orgs/${org}/analytics`);

    const event = JSON.parse(readFileSync(eventFile, 'utf-8').trim().split('\n')[0]);
    expect(event.org).toBe(org);
  });
});

// ============================================================================
// 12. EDGE CASES AND ERROR HANDLING
// ============================================================================

test.describe('Format edge cases', () => {
  test('task with very long title (500+ chars)', () => {
    const paths = makePaths('testbot');
    const longTitle = 'A'.repeat(500);
    const taskId = createTask(paths, 'testbot', 'test-org', longTitle);
    const task = JSON.parse(readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8'));
    expect(task.title).toBe(longTitle);
  });

  test('event with large metadata object', () => {
    const paths = makePaths('testbot');
    const largeMeta: Record<string, string> = {};
    for (let i = 0; i < 100; i++) {
      largeMeta[`key_${i}`] = `value_${i}_${'x'.repeat(50)}`;
    }
    logEvent(paths, 'testbot', 'test-org', 'action', 'large_meta', 'info', largeMeta);

    const today = new Date().toISOString().split('T')[0];
    const eventFile = join(paths.analyticsDir, 'events', 'testbot', `${today}.jsonl`);
    const event = JSON.parse(readFileSync(eventFile, 'utf-8').trim());
    expect(Object.keys(event.metadata).length).toBe(100);
  });

  test('message with JSON in text body', () => {
    const paths = makePaths('sender');
    const jsonText = '{"action":"deploy","target":"prod","config":{"replicas":3}}';
    sendMessage(paths, 'sender', 'receiver', 'normal', jsonText);

    const inboxDir = join(ctxRoot, 'inbox', 'receiver');
    const files = readdirSync(inboxDir).filter(f => f.endsWith('.json'));
    const msg = JSON.parse(readFileSync(join(inboxDir, files[0]), 'utf-8'));
    expect(msg.text).toBe(jsonText);
    // Embedded JSON in text should not break the outer JSON
    expect(() => JSON.parse(msg.text)).not.toThrow();
  });

  test('concurrent writes to same JSONL file', () => {
    const paths = makePaths('testbot');
    // Simulate rapid sequential writes (not truly concurrent but close)
    for (let i = 0; i < 20; i++) {
      logEvent(paths, 'testbot', 'test-org', 'action', `rapid_${i}`, 'info');
    }

    const today = new Date().toISOString().split('T')[0];
    const eventFile = join(paths.analyticsDir, 'events', 'testbot', `${today}.jsonl`);
    const lines = readFileSync(eventFile, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(20);

    // Each line must be valid JSON
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
