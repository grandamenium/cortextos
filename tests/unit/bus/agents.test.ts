import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { listAgents, notifyAgent } from '../../../src/bus/agents';
import type { BusPaths } from '../../../src/types';

describe('Agent Discovery', () => {
  let testDir: string;
  let ctxRoot: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-agents-test-'));
    ctxRoot = testDir;
    // Point CTX_FRAMEWORK_ROOT at an isolated subdir (no orgs/ inside) so that
    // listAgents() sees a configured but empty framework root and does NOT fall
    // back to process.cwd() — which is the repo root and has a real orgs/ dir.
    process.env.CTX_FRAMEWORK_ROOT = join(testDir, 'framework');
    delete process.env.CTX_PROJECT_ROOT;
    // Ensure Supabase env vars are absent so fetchRemoteHeartbeats() no-ops in tests.
    delete process.env.SUPABASE_RGOS_URL;
    delete process.env.SUPABASE_RGOS_SERVICE_KEY;
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    // Clean up env vars
    delete process.env.CTX_FRAMEWORK_ROOT;
    delete process.env.CTX_PROJECT_ROOT;
  });

  describe('listAgents', () => {
    it('discovers agents from enabled-agents.json', async () => {
      // Set up enabled-agents.json
      const configDir = join(ctxRoot, 'config');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'enabled-agents.json'),
        JSON.stringify({
          boris: { org: 'acme', enabled: true },
          paul: { org: 'acme', enabled: true },
        }),
      );

      const agents = await listAgents(ctxRoot);
      expect(agents.length).toBe(2);
      expect(agents.map(a => a.name).sort()).toEqual(['boris', 'paul']);
      expect(agents[0].org).toBe('acme');
      expect(agents[0].enabled).toBe(true);
    });

    it('reads IDENTITY.md first line for role', async () => {
      // Set up framework root with agent identity
      const frameworkRoot = join(testDir, 'framework');
      process.env.CTX_FRAMEWORK_ROOT = frameworkRoot;

      const agentDir = join(frameworkRoot, 'orgs', 'testorg', 'agents', 'worker');
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(
        join(agentDir, 'IDENTITY.md'),
        '# Worker Agent\n\n## Role\nBackend developer responsible for API implementation\n',
      );

      // Set up enabled-agents.json
      const configDir = join(ctxRoot, 'config');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'enabled-agents.json'),
        JSON.stringify({ worker: { org: 'testorg', enabled: true } }),
      );

      const agents = await listAgents(ctxRoot);
      expect(agents.length).toBe(1);
      expect(agents[0].role).toBe('Backend developer responsible for API implementation');
    });

    it('handles missing files gracefully', async () => {
      // No config dir, no heartbeats - should return empty array
      const agents = await listAgents(ctxRoot);
      expect(agents).toEqual([]);
    });

    it('handles missing IDENTITY.md gracefully', async () => {
      const configDir = join(ctxRoot, 'config');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'enabled-agents.json'),
        JSON.stringify({ agent1: { org: 'org1', enabled: true } }),
      );

      const agents = await listAgents(ctxRoot);
      expect(agents.length).toBe(1);
      expect(agents[0].role).toBe('');
    });

    it('reads heartbeat data for status', async () => {
      const configDir = join(ctxRoot, 'config');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'enabled-agents.json'),
        JSON.stringify({ worker: { org: 'testorg', enabled: true } }),
      );

      // Write heartbeat to state dir (path: state/{agent}/heartbeat.json)
      const hbDir = join(ctxRoot, 'state', 'worker');
      mkdirSync(hbDir, { recursive: true });
      writeFileSync(
        join(hbDir, 'heartbeat.json'),
        JSON.stringify({
          agent: 'worker',
          timestamp: new Date().toISOString(),
          status: 'idle',
        }),
      );

      const agents = await listAgents(ctxRoot);
      expect(agents.length).toBe(1);
      expect(agents[0].last_heartbeat).toBeTruthy();
      expect(agents[0].running).toBe(true); // Recent heartbeat means running
    });

    it('falls back to in-progress assigned task when heartbeat current_task is empty', async () => {
      const configDir = join(ctxRoot, 'config');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'enabled-agents.json'),
        JSON.stringify({ worker: { org: 'testorg', enabled: true } }),
      );

      const hbDir = join(ctxRoot, 'state', 'worker');
      mkdirSync(hbDir, { recursive: true });
      writeFileSync(
        join(hbDir, 'heartbeat.json'),
        JSON.stringify({
          agent: 'worker',
          last_heartbeat: new Date().toISOString(),
          current_task: '',
          status: 'online',
        }),
      );

      const taskDir = join(ctxRoot, 'orgs', 'testorg', 'tasks');
      mkdirSync(taskDir, { recursive: true });
      writeFileSync(
        join(taskDir, 'task_123.json'),
        JSON.stringify({
          id: 'task_123',
          title: 'Repair visible task',
          description: '',
          type: 'agent',
          needs_approval: false,
          status: 'in_progress',
          assigned_to: 'worker',
          created_by: 'orchestrator',
          org: 'testorg',
          priority: 'normal',
          project: '',
          kpi_key: null,
          created_at: '2026-05-27T10:00:00Z',
          updated_at: '2026-05-27T10:05:00Z',
          completed_at: null,
          due_date: null,
          archived: false,
        }),
      );

      const agents = await listAgents(ctxRoot);
      expect(agents[0].current_task).toBe('task_123: Repair visible task');
    });

    it('hides deleted registry entries and does not apply current-task fallback to them', async () => {
      const configDir = join(ctxRoot, 'config');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'enabled-agents.json'),
        JSON.stringify({
          'orca-orch': { org: 'revops-global', enabled: false, status: 'deleted' },
          deleted_agents: {
            'orca-orch': {
              deleted_at: '2026-05-27T05:41:00Z',
              reason: 'removed from active namespace',
            },
          },
          codex: { org: 'revops-global', enabled: true },
        }),
      );

      const taskDir = join(ctxRoot, 'orgs', 'revops-global', 'tasks');
      mkdirSync(taskDir, { recursive: true });
      writeFileSync(
        join(taskDir, 'task_deleted.json'),
        JSON.stringify({
          id: 'task_deleted',
          title: 'Deleted agent should not look active',
          description: '',
          type: 'agent',
          needs_approval: false,
          status: 'in_progress',
          assigned_to: 'orca-orch',
          created_by: 'orchestrator',
          org: 'revops-global',
          priority: 'normal',
          project: '',
          kpi_key: null,
          created_at: '2026-05-27T10:00:00Z',
          updated_at: '2026-05-27T10:05:00Z',
          completed_at: null,
          due_date: null,
          archived: false,
        }),
      );

      const agents = await listAgents(ctxRoot);
      expect(agents.map(a => a.name)).toEqual(['codex']);
      expect(agents.find(a => a.name === 'orca-orch')).toBeUndefined();
      expect(agents.find(a => a.name === 'deleted_agents')).toBeUndefined();
      expect(agents.some(a => a.current_task === 'task_deleted: Deleted agent should not look active')).toBe(false);
    });

    it('filters by org when specified', async () => {
      const configDir = join(ctxRoot, 'config');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'enabled-agents.json'),
        JSON.stringify({
          boris: { org: 'acme', enabled: true },
          other: { org: 'different', enabled: true },
        }),
      );

      const agents = await listAgents(ctxRoot, 'acme');
      expect(agents.length).toBe(1);
      expect(agents[0].name).toBe('boris');
    });

    // BUG-028: daemon and CLI must agree on what's enabled.
    // Previously, listAgents short-circuited on enabled-agents.json existence,
    // hiding agents the daemon was actually running from `cortextos list-agents`.
    it('shows agents from dir scan even when enabled-agents.json exists', async () => {
      // Set up: enabled-agents.json with one agent (alice), but TWO dirs on disk
      // (alice and bob). Previously listAgents would only return alice. After
      // the fix, both should be returned.
      const configDir = join(ctxRoot, 'config');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'enabled-agents.json'),
        JSON.stringify({ alice: { org: 'acme', enabled: true } }),
      );

      const frameworkRoot = join(testDir, 'framework');
      process.env.CTX_FRAMEWORK_ROOT = frameworkRoot;
      mkdirSync(join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice'), { recursive: true });
      mkdirSync(join(frameworkRoot, 'orgs', 'acme', 'agents', 'bob'), { recursive: true });

      const agents = await listAgents(ctxRoot);
      expect(agents.map(a => a.name).sort()).toEqual(['alice', 'bob']);
    });

    it('respects enabled: false from enabled-agents.json for agents found in dir scan', async () => {
      // Set up: dir for alice + entry in enabled-agents.json saying enabled: false.
      // listAgents should return alice with enabled: false (not skip her entirely).
      const configDir = join(ctxRoot, 'config');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'enabled-agents.json'),
        JSON.stringify({ alice: { org: 'acme', enabled: false } }),
      );

      const frameworkRoot = join(testDir, 'framework');
      process.env.CTX_FRAMEWORK_ROOT = frameworkRoot;
      mkdirSync(join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice'), { recursive: true });

      const agents = await listAgents(ctxRoot);
      expect(agents.length).toBe(1);
      expect(agents[0].name).toBe('alice');
      expect(agents[0].enabled).toBe(false);
    });
  });

  describe('notifyAgent', () => {
    let paths: BusPaths;

    beforeEach(() => {
      paths = {
        ctxRoot,
        inbox: join(ctxRoot, 'inbox', 'sender'),
        inflight: join(ctxRoot, 'inflight', 'sender'),
        processed: join(ctxRoot, 'processed', 'sender'),
        logDir: join(ctxRoot, 'logs', 'sender'),
        stateDir: join(ctxRoot, 'state', 'sender'),
        taskDir: join(ctxRoot, 'tasks'),
        approvalDir: join(ctxRoot, 'approvals'),
        analyticsDir: join(ctxRoot, 'analytics'),
        heartbeatDir: join(ctxRoot, 'heartbeats'),
      };
    });

    it('creates signal file and bus message', () => {
      notifyAgent(paths, 'sender', 'target', 'Wake up!', ctxRoot);

      // Check signal file exists
      const signalFile = join(ctxRoot, 'state', 'target', '.urgent-signal');
      expect(existsSync(signalFile)).toBe(true);

      // Check bus message was sent
      const targetInbox = join(ctxRoot, 'inbox', 'target');
      expect(existsSync(targetInbox)).toBe(true);
      const files = require('fs').readdirSync(targetInbox).filter((f: string) => f.endsWith('.json'));
      expect(files.length).toBe(1);
    });

    it('signal file has correct JSON format', () => {
      notifyAgent(paths, 'boris', 'paul', 'New task available', ctxRoot);

      const signalFile = join(ctxRoot, 'state', 'paul', '.urgent-signal');
      const content = JSON.parse(readFileSync(signalFile, 'utf-8'));

      expect(content).toHaveProperty('from', 'boris');
      expect(content).toHaveProperty('message', 'New task available');
      expect(content).toHaveProperty('timestamp');
      // Verify timestamp is ISO 8601
      expect(new Date(content.timestamp).toISOString()).toBeTruthy();
    });

    it('creates state directory if it does not exist', () => {
      const stateDir = join(ctxRoot, 'state', 'newagent');
      expect(existsSync(stateDir)).toBe(false);

      notifyAgent(paths, 'sender', 'newagent', 'Hello', ctxRoot);

      expect(existsSync(stateDir)).toBe(true);
    });
  });
});
