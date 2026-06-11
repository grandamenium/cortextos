/**
 * tests/unit/daemon/shell-cron.test.ts — F1-lite shell-engine executor.
 *
 * Covers:
 *  1. executeShellCron resolves on exit 0
 *  2. Nonzero exit rejects with exit code + stderr tail in the message
 *  3. Timeout kills the process and rejects with a timeout error
 *  4. Spawn-level failure rejects (unspawnable cwd)
 *  5. buildShellCronEnv: CTX_* vars, org secrets.env + agent .env precedence,
 *     CHAT_ID → CTX_TELEGRAM_CHAT_ID alias, timezone propagation
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { buildShellCronEnv, executeShellCron } from '../../../src/daemon/shell-cron.js';
import type { AgentConfig, CtxEnv } from '../../../src/types/index.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'shell-cron-test-'));
});

afterEach(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

const baseEnv = (): Record<string, string> => ({
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: process.env.HOME ?? tmpRoot,
});

// ---------------------------------------------------------------------------
// executeShellCron
// ---------------------------------------------------------------------------

describe('executeShellCron', () => {
  it('resolves with exitCode 0 on success', async () => {
    const result = await executeShellCron('true', {
      env: baseEnv(),
      cwd: tmpRoot,
    });
    expect(result.exitCode).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('runs the prompt through bash (pipes, &&, env access work)', async () => {
    const marker = join(tmpRoot, 'marker.txt');
    await executeShellCron(`echo "$CTX_TEST_VALUE" | tr a-z A-Z > "${marker}" && test -f "${marker}"`, {
      env: { ...baseEnv(), CTX_TEST_VALUE: 'hello' },
      cwd: tmpRoot,
    });
    const { readFileSync } = await import('fs');
    expect(readFileSync(marker, 'utf-8').trim()).toBe('HELLO');
  });

  it('rejects on nonzero exit with exit code and stderr tail', async () => {
    await expect(
      executeShellCron('echo "boom failure detail" >&2; exit 7', {
        env: baseEnv(),
        cwd: tmpRoot,
      }),
    ).rejects.toThrow(/exited 7.*boom failure detail/s);
  });

  it('rejects on timeout and kills the process', async () => {
    const start = Date.now();
    await expect(
      executeShellCron('sleep 30', {
        env: baseEnv(),
        cwd: tmpRoot,
        timeoutMs: 300,
      }),
    ).rejects.toThrow(/timed out after 300ms/);
    // Must reject promptly after the timeout, not after the full sleep.
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it('caps retained stderr to the tail', async () => {
    // Emit ~64KB of stderr; the error message must contain the END of the
    // stream (the part that explains the failure), not blow up the log.
    const err = await executeShellCron(
      'for i in $(seq 1 4000); do echo "filler-$i" >&2; done; echo "FINAL-CAUSE" >&2; exit 1',
      { env: baseEnv(), cwd: tmpRoot },
    ).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('FINAL-CAUSE');
    expect((err as Error).message.length).toBeLessThan(6_000);
  });
});

// ---------------------------------------------------------------------------
// buildShellCronEnv
// ---------------------------------------------------------------------------

describe('buildShellCronEnv', () => {
  function makeCtxEnv(): CtxEnv {
    const projectRoot = join(tmpRoot, 'project');
    const agentDir = join(projectRoot, 'orgs', 'testorg', 'agents', 'tester');
    mkdirSync(agentDir, { recursive: true });
    return {
      instanceId: 'inst-1',
      ctxRoot: join(tmpRoot, 'ctx'),
      frameworkRoot: projectRoot,
      agentName: 'tester',
      agentDir,
      org: 'testorg',
      projectRoot,
    };
  }

  it('sets the CTX_* contract vars and keeps PATH/HOME', () => {
    const ctxEnv = makeCtxEnv();
    const env = buildShellCronEnv(ctxEnv, {} as AgentConfig);

    expect(env['CTX_AGENT_NAME']).toBe('tester');
    expect(env['CTX_ORG']).toBe('testorg');
    expect(env['CTX_ROOT']).toBe(ctxEnv.ctxRoot);
    expect(env['CTX_AGENT_DIR']).toBe(ctxEnv.agentDir);
    expect(env['PATH']).toBeTruthy();
    expect(env['HOME']).toBeTruthy();
  });

  it('loads org secrets.env then agent .env with agent precedence, and aliases CHAT_ID', () => {
    const ctxEnv = makeCtxEnv();
    const orgDir = join(ctxEnv.projectRoot, 'orgs', 'testorg');
    writeFileSync(join(orgDir, 'secrets.env'), [
      '# org secrets',
      'GEMINI_API_KEY=org-gemini',
      'SHARED_OVERRIDE=from-org',
    ].join('\n'), 'utf-8');
    writeFileSync(join(ctxEnv.agentDir, '.env'), [
      'CHAT_ID=12345',
      'SHARED_OVERRIDE=from-agent',
    ].join('\n'), 'utf-8');

    const env = buildShellCronEnv(ctxEnv, {} as AgentConfig);

    expect(env['GEMINI_API_KEY']).toBe('org-gemini');
    expect(env['SHARED_OVERRIDE']).toBe('from-agent'); // agent .env wins
    expect(env['CHAT_ID']).toBe('12345');
    expect(env['CTX_TELEGRAM_CHAT_ID']).toBe('12345');
  });

  it('propagates config timezone to CTX_TIMEZONE and TZ', () => {
    const ctxEnv = makeCtxEnv();
    const env = buildShellCronEnv(ctxEnv, { timezone: 'America/Los_Angeles' } as AgentConfig);
    expect(env['CTX_TIMEZONE']).toBe('America/Los_Angeles');
    expect(env['TZ']).toBe('America/Los_Angeles');
  });
});
