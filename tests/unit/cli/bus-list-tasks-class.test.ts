import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { createTask } from '../../../src/bus/task';
import type { BusPaths } from '../../../src/types/index';

let tempCtxRoot = '';

function makePaths(agentName: string): BusPaths {
  return {
    ctxRoot: tempCtxRoot,
    inbox: join(tempCtxRoot, 'inbox', agentName),
    inflight: join(tempCtxRoot, 'inflight', agentName),
    processed: join(tempCtxRoot, 'processed', agentName),
    logDir: join(tempCtxRoot, 'logs', agentName),
    stateDir: join(tempCtxRoot, 'state', agentName),
    taskDir: join(tempCtxRoot, 'tasks'),
    approvalDir: join(tempCtxRoot, 'approvals'),
    analyticsDir: join(tempCtxRoot, 'analytics'),
    deliverablesDir: join(tempCtxRoot, 'deliverables'),
  };
}

vi.mock('../../../src/utils/paths.js', () => ({
  resolvePaths: (agentName: string) => makePaths(agentName),
  getIpcPath: (_instanceId?: string) => join(tempCtxRoot || homedir(), 'daemon.sock'),
}));

import { busCommand } from '../../../src/cli/bus';

describe('bus list-tasks classification flags', () => {
  const originalCtxRoot = process.env.CTX_ROOT;
  const originalAgentName = process.env.CTX_AGENT_NAME;
  const originalInstanceId = process.env.CTX_INSTANCE_ID;
  const originalOrg = process.env.CTX_ORG;

  beforeEach(() => {
    tempCtxRoot = mkdtempSync(join(tmpdir(), 'bus-list-tasks-class-'));
    process.env.CTX_ROOT = tempCtxRoot;
    process.env.CTX_AGENT_NAME = 'paul';
    process.env.CTX_INSTANCE_ID = 'default';
    delete process.env.CTX_ORG;
  });

  afterEach(() => {
    if (originalCtxRoot === undefined) delete process.env.CTX_ROOT;
    else process.env.CTX_ROOT = originalCtxRoot;

    if (originalAgentName === undefined) delete process.env.CTX_AGENT_NAME;
    else process.env.CTX_AGENT_NAME = originalAgentName;

    if (originalInstanceId === undefined) delete process.env.CTX_INSTANCE_ID;
    else process.env.CTX_INSTANCE_ID = originalInstanceId;

    if (originalOrg === undefined) delete process.env.CTX_ORG;
    else process.env.CTX_ORG = originalOrg;

    rmSync(tempCtxRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('prefixes text rows with the computed class tag', async () => {
    const paths = makePaths('paul');
    createTask(paths, 'paul', 'acme', 'Build row');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await busCommand.parseAsync(['node', 'bus', 'list-tasks']);

    expect(logSpy.mock.calls.some(([msg]) => typeof msg === 'string' && msg.includes('[build]'))).toBe(true);
  });

  it('supports --real-build and adds a computed class field in json output', async () => {
    const paths = makePaths('paul');
    createTask(paths, 'comms-check-123', 'acme', 'System row');
    createTask(paths, 'paul', 'acme', 'Build row');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await busCommand.parseAsync(['node', 'bus', 'list-tasks', '--real-build', '--format', 'json']);

    const jsonLine = logSpy.mock.calls.find(([msg]) => typeof msg === 'string' && msg.startsWith('['))?.[0];
    expect(typeof jsonLine).toBe('string');
    const rows = JSON.parse(jsonLine as string) as Array<{ title: string; class: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Build row');
    expect(rows[0].class).toBe('build');
  });
});
