/**
 * tests/integration/codex-bus-roundtrip.test.ts — codex bus message round-trip.
 *
 * The bus layer (sendMessage, checkInbox, ackInbox) is runtime-agnostic. This
 * test validates that codex agents can use it identically to claude agents,
 * including across orgs, with priority ordering and inbox state machine
 * (inbox → inflight → processed) all preserved.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { sendMessage, checkInbox, ackInbox } from '../../src/bus/message.js';
import { createTask, listTasks } from '../../src/bus/task.js';
import { logEvent } from '../../src/bus/event.js';
import type { BusPaths } from '../../src/types/index.js';

let testDir: string;
let ctxRoot: string;

function makePaths(agent: string): BusPaths {
  return {
    ctxRoot,
    inbox: join(ctxRoot, 'inbox', agent),
    inflight: join(ctxRoot, 'inflight', agent),
    processed: join(ctxRoot, 'processed', agent),
    logDir: join(ctxRoot, 'logs', agent),
    stateDir: join(ctxRoot, '.cortextOS', 'state', 'agents', agent),
    taskDir: join(ctxRoot, 'orgs', 'codex-org', 'tasks'),
    approvalDir: join(ctxRoot, 'orgs', 'codex-org', 'approvals'),
    analyticsDir: join(ctxRoot, 'orgs', 'codex-org', 'analytics'),
  };
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'codex-bus-roundtrip-'));
  ctxRoot = join(testDir, '.cortextos', 'test');
  mkdirSync(ctxRoot, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('codex bus round-trip', () => {
  it('codex agent → codex agent send/check/ack lifecycle', () => {
    const alpha = makePaths('codex-alpha');
    const beta = makePaths('codex-beta');

    const id = sendMessage(alpha, 'codex-alpha', 'codex-beta', 'high', 'sync turn-1 token usage');

    const inbox = checkInbox(beta);
    expect(inbox).toHaveLength(1);
    expect(inbox[0].from).toBe('codex-alpha');
    expect(inbox[0].to).toBe('codex-beta');
    expect(inbox[0].priority).toBe('high');
    expect(inbox[0].text).toBe('sync turn-1 token usage');

    ackInbox(beta, id);
    expect(readdirSync(beta.inbox).filter((f) => f.endsWith('.json'))).toHaveLength(0);
    expect(readdirSync(beta.inflight).filter((f) => f.endsWith('.json'))).toHaveLength(0);
    expect(readdirSync(beta.processed).filter((f) => f.endsWith('.json'))).toHaveLength(1);
  });

  it('priority ordering applies to codex inbox identically to claude', () => {
    const sender = makePaths('codex-sender');
    const receiver = makePaths('codex-receiver');

    sendMessage(sender, 'codex-sender', 'codex-receiver', 'low', 'low');
    sendMessage(sender, 'codex-sender', 'codex-receiver', 'urgent', 'urgent');
    sendMessage(sender, 'codex-sender', 'codex-receiver', 'normal', 'normal');
    sendMessage(sender, 'codex-sender', 'codex-receiver', 'high', 'high');

    const messages = checkInbox(receiver);
    expect(messages.map((m) => m.priority)).toEqual(['urgent', 'high', 'normal', 'low']);
  });

  it('codex agent ↔ claude agent cross-runtime messaging works', () => {
    const codex = makePaths('codex-only');
    const claude = makePaths('claude-only');

    sendMessage(codex, 'codex-only', 'claude-only', 'normal', 'codex talking to claude');
    sendMessage(claude, 'claude-only', 'codex-only', 'normal', 'claude talking to codex');

    const claudeInbox = checkInbox(claude);
    expect(claudeInbox.length).toBe(1);
    expect(claudeInbox[0].from).toBe('codex-only');

    const codexInbox = checkInbox(codex);
    expect(codexInbox.length).toBe(1);
    expect(codexInbox[0].from).toBe('claude-only');
  });

  it('codex agents can create and list tasks via the task bus', () => {
    const paths = makePaths('codex-alpha');
    const taskId = createTask(paths, 'codex-alpha', 'codex-org', 'Reindex docs', {
      assignee: 'codex-beta',
      priority: 'high',
    });
    expect(taskId).toMatch(/^task_\d+_[a-z0-9]+$/);
    const tasks = listTasks(paths);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].assigned_to).toBe('codex-beta');
    expect(tasks[0].status).toBe('pending');
  });

  it('codex agents emit JSONL events with the runtime-agnostic schema', () => {
    const paths = makePaths('codex-alpha');
    logEvent(paths, 'codex-alpha', 'codex-org', 'action', 'turn_completed', 'info', {
      runtime: 'codex-app-server',
      thread_id: 'mock-thread-1',
      turn_id: 'mock-turn-1',
    });
    const today = new Date().toISOString().split('T')[0];
    const eventFile = join(paths.analyticsDir, 'events', 'codex-alpha', `${today}.jsonl`);
    const lines = readFileSync(eventFile, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(1);
    const event = JSON.parse(lines[0]);
    expect(event.event).toBe('turn_completed');
    expect(event.metadata.runtime).toBe('codex-app-server');
    expect(event.metadata.thread_id).toBe('mock-thread-1');
  });

  it('round-trip preserves message id across check/ack', () => {
    const alpha = makePaths('codex-alpha');
    const beta = makePaths('codex-beta');
    const id = sendMessage(alpha, 'codex-alpha', 'codex-beta', 'urgent', 'preservation test');
    const inbox = checkInbox(beta);
    expect(inbox[0].id).toBe(id);
    ackInbox(beta, id);
    const processedFiles = readdirSync(beta.processed).filter((f) => f.endsWith('.json'));
    expect(processedFiles.length).toBe(1);
    const processed = JSON.parse(readFileSync(join(beta.processed, processedFiles[0]), 'utf-8'));
    expect(processed.id).toBe(id);
  });
});
