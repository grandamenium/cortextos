/**
 * tests/unit/bus/hook-log-tool-invocation.test.ts
 *
 * Tests for HIGH-2 Phase 1: log-only PreToolUse hook.
 * The hook must log entries in the expected JSONL schema, never exit non-zero,
 * and handle missing/malformed input gracefully.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

const HOOK = join(process.cwd(), 'bus/hooks/log-tool-invocation.sh');

function runHook(
  payload: string,
  env: Record<string, string> = {},
): { exitCode: number } {
  const result = spawnSync('bash', [HOOK], {
    input: payload,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
    encoding: 'utf-8',
  });
  return { exitCode: result.status ?? 0 };
}

let tmpCtxRoot: string;
let agentLogDir: string;
let logFile: string;
const agentName = 'test-agent';

beforeEach(() => {
  tmpCtxRoot = mkdtempSync(join(tmpdir(), 'hook-test-'));
  agentLogDir = join(tmpCtxRoot, 'logs', agentName);
  mkdirSync(agentLogDir, { recursive: true });
  logFile = join(agentLogDir, 'tool-invocations.log');
});

afterEach(() => {
  rmSync(tmpCtxRoot, { recursive: true, force: true });
});

function hookEnv(): Record<string, string> {
  return {
    CTX_AGENT_NAME: agentName,
    CTX_ROOT: tmpCtxRoot,
    PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/local/bin',
  };
}

describe('log-tool-invocation hook', () => {
  it('exits 0 for a well-formed tool call payload', () => {
    const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls -la' } });
    const { exitCode } = runHook(payload, hookEnv());
    expect(exitCode).toBe(0);
  });

  it('writes a JSONL log entry with expected fields', () => {
    const payload = JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/tmp/test.md' } });
    runHook(payload, hookEnv());
    expect(existsSync(logFile)).toBe(true);
    const line = readFileSync(logFile, 'utf-8').trim();
    const entry = JSON.parse(line);
    expect(entry.agent).toBe(agentName);
    expect(entry.tool).toBe('Read');
    expect(typeof entry.ts).toBe('string');
    expect(typeof entry.args).toBe('string');
  });

  it('logs tool name correctly for different tools', () => {
    const tools = ['Bash', 'Edit', 'Write', 'WebFetch'];
    for (const tool of tools) {
      const payload = JSON.stringify({ tool_name: tool, tool_input: {} });
      runHook(payload, hookEnv());
    }
    const lines = readFileSync(logFile, 'utf-8').trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(4);
    const toolNames = lines.map((l) => JSON.parse(l).tool);
    expect(toolNames).toEqual(tools);
  });

  it('exits 0 for empty stdin (graceful degradation)', () => {
    const { exitCode } = runHook('', hookEnv());
    expect(exitCode).toBe(0);
  });

  it('exits 0 for malformed JSON input (never blocks)', () => {
    const { exitCode } = runHook('not-valid-json', hookEnv());
    expect(exitCode).toBe(0);
  });

  it('exits 0 when CTX_AGENT_NAME is missing (uses fallback)', () => {
    const env = { CTX_ROOT: tmpCtxRoot, PATH: process.env.PATH ?? '/usr/bin:/bin' };
    const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo hi' } });
    const { exitCode } = runHook(payload, env);
    expect(exitCode).toBe(0);
  });

  it('creates log directory if it does not exist', () => {
    rmSync(agentLogDir, { recursive: true, force: true });
    const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'pwd' } });
    const { exitCode } = runHook(payload, hookEnv());
    expect(exitCode).toBe(0);
    expect(existsSync(logFile)).toBe(true);
  });

  it('appends entries on successive calls (JSONL format)', () => {
    const env = hookEnv();
    runHook(JSON.stringify({ tool_name: 'Read', tool_input: {} }), env);
    runHook(JSON.stringify({ tool_name: 'Edit', tool_input: {} }), env);
    runHook(JSON.stringify({ tool_name: 'Write', tool_input: {} }), env);
    const lines = readFileSync(logFile, 'utf-8').trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
