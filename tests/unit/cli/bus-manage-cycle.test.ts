/**
 * tests/unit/cli/bus-manage-cycle.test.ts
 *
 * Regression test for a bug found 2026-07-18 (task_1784272089809_62319169
 * follow-up): `cortextos bus manage-cycle create <agent> ...` resolved its
 * working directory from the CALLING agent's own env (resolveEnv().agentDir)
 * instead of the `<agent>` argument — so a cycle "created for" another agent
 * silently landed in the caller's own experiments/config.json instead. The
 * target agent's own autoresearch skill (which checks its OWN local
 * experiments/config.json, per .claude/skills/autoresearch/SKILL.md) never
 * saw the cycle, so its experiment cron fired into a void.
 *
 * Fix mirrors the already-correct `gather-context --agent` / `list-experiments
 * --agent` resolution: join(frameworkRoot, 'orgs', org, 'agents', agent).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let tmpRoot: string;
let frameworkRoot: string;
const originalCtxRoot = process.env.CTX_ROOT;
const originalFrameworkRoot = process.env.CTX_FRAMEWORK_ROOT;
const originalAgentName = process.env.CTX_AGENT_NAME;
const originalInstanceId = process.env.CTX_INSTANCE_ID;
const originalAgentDir = process.env.CTX_AGENT_DIR;
const originalProjectRoot = process.env.CTX_PROJECT_ROOT;
const originalOrg = process.env.CTX_ORG;

/** The agent whose SESSION is running the CLI command (the caller). */
const CALLER_AGENT = 'anam';
/** The agent the cycle is being created FOR (the target). */
const TARGET_AGENT = 'athena';

function targetConfigPath(): string {
  return join(frameworkRoot, 'orgs', 'lifeos', 'agents', TARGET_AGENT, 'experiments', 'config.json');
}

function callerConfigPath(): string {
  return join(frameworkRoot, 'orgs', 'lifeos', 'agents', CALLER_AGENT, 'experiments', 'config.json');
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'bus-manage-cycle-test-'));
  frameworkRoot = mkdtempSync(join(tmpdir(), 'bus-manage-cycle-fw-'));
  mkdirSync(join(frameworkRoot, 'orgs', 'lifeos', 'agents', CALLER_AGENT), { recursive: true });
  mkdirSync(join(frameworkRoot, 'orgs', 'lifeos', 'agents', TARGET_AGENT), { recursive: true });

  process.env.CTX_ROOT = tmpRoot;
  process.env.CTX_FRAMEWORK_ROOT = frameworkRoot;
  process.env.CTX_AGENT_NAME = CALLER_AGENT;
  process.env.CTX_AGENT_DIR = join(frameworkRoot, 'orgs', 'lifeos', 'agents', CALLER_AGENT);
  process.env.CTX_INSTANCE_ID = 'default';
  process.env.CTX_ORG = 'lifeos';
  process.env.CTX_PROJECT_ROOT = frameworkRoot;
});

afterEach(() => {
  if (originalCtxRoot !== undefined) process.env.CTX_ROOT = originalCtxRoot;
  else delete process.env.CTX_ROOT;
  if (originalFrameworkRoot !== undefined) process.env.CTX_FRAMEWORK_ROOT = originalFrameworkRoot;
  else delete process.env.CTX_FRAMEWORK_ROOT;
  if (originalAgentName !== undefined) process.env.CTX_AGENT_NAME = originalAgentName;
  else delete process.env.CTX_AGENT_NAME;
  if (originalInstanceId !== undefined) process.env.CTX_INSTANCE_ID = originalInstanceId;
  else delete process.env.CTX_INSTANCE_ID;
  if (originalOrg !== undefined) process.env.CTX_ORG = originalOrg;
  else delete process.env.CTX_ORG;
  if (originalProjectRoot !== undefined) process.env.CTX_PROJECT_ROOT = originalProjectRoot;
  else delete process.env.CTX_PROJECT_ROOT;
  if (originalAgentDir !== undefined) process.env.CTX_AGENT_DIR = originalAgentDir;
  else delete process.env.CTX_AGENT_DIR;

  try { rmSync(tmpRoot, { recursive: true }); } catch { /* ignore */ }
  try { rmSync(frameworkRoot, { recursive: true }); } catch { /* ignore */ }

  vi.restoreAllMocks();
});

import { busCommand } from '../../../src/cli/bus';

describe('bus manage-cycle', () => {
  it('create: writes the cycle into the TARGET agent\'s own experiments/config.json, not the caller\'s', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await busCommand.parseAsync([
      'node', 'bus', 'manage-cycle', 'create', TARGET_AGENT,
      '--cycle', 'busy-blocks-staleness',
      '--metric', 'busy_blocks_staleness_incidents',
      '--metric-type', 'quantitative',
      '--surface', 'experiments/surfaces/busy-blocks-staleness.md',
      '--direction', 'lower',
      '--window', '7d',
      '--measurement', 'weekly count',
      '--loop-interval', '7d',
    ]);

    expect(existsSync(targetConfigPath())).toBe(true);
    const targetConfig = JSON.parse(readFileSync(targetConfigPath(), 'utf-8'));
    expect(targetConfig.cycles).toHaveLength(1);
    expect(targetConfig.cycles[0]).toMatchObject({ name: 'busy-blocks-staleness', agent: TARGET_AGENT });

    // The bug's signature: the caller's OWN config must NOT have received it.
    if (existsSync(callerConfigPath())) {
      const callerConfig = JSON.parse(readFileSync(callerConfigPath(), 'utf-8'));
      expect(callerConfig.cycles ?? []).toHaveLength(0);
    }
  });

  it('list: reads cycles from the TARGET agent\'s own config, not the caller\'s', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await busCommand.parseAsync([
      'node', 'bus', 'manage-cycle', 'create', TARGET_AGENT,
      '--cycle', 'reorder-trigger-accuracy',
      '--metric', 'reorder_trigger_misses',
      '--metric-type', 'quantitative',
      '--direction', 'lower',
    ]);
    logSpy.mockClear();

    await busCommand.parseAsync(['node', 'bus', 'manage-cycle', 'list', TARGET_AGENT]);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('reorder-trigger-accuracy');
  });

  it('modify: targets the same agent directory as create (round-trips correctly)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await busCommand.parseAsync([
      'node', 'bus', 'manage-cycle', 'create', TARGET_AGENT,
      '--cycle', 'approval-surface-latency',
      '--metric', 'approval_surface_latency_minutes',
      '--metric-type', 'quantitative',
      '--direction', 'lower',
    ]);

    await busCommand.parseAsync([
      'node', 'bus', 'manage-cycle', 'modify', TARGET_AGENT,
      '--cycle', 'approval-surface-latency',
      '--enabled', 'false',
    ]);

    const targetConfig = JSON.parse(readFileSync(targetConfigPath(), 'utf-8'));
    expect(targetConfig.cycles[0]).toMatchObject({ name: 'approval-surface-latency', enabled: false });
  });

  it('error: throws when required fields are missing on create', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      busCommand.parseAsync(['node', 'bus', 'manage-cycle', 'create', TARGET_AGENT])
    ).rejects.toThrow();

    // Nothing should have been written to the target agent's config on failure.
    expect(existsSync(targetConfigPath())).toBe(false);
  });
});
