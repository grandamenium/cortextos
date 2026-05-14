/**
 * Hook smoke tests — E2E subprocess invocation harness.
 *
 * Each hook is spawned as a subprocess via spawnSync, matching the invocation
 * model Claude Code uses in production (subprocess + JSON via stdin + stdout).
 *
 * Three baseline tests:
 *   1. hook-loop-detector — allow first call; detect loop after 15 identical calls
 *   2. hook-policy-check  — allow safe Bash; block P2/P4 policy violations
 *   3. hook-context-status — write context_status.json on valid input
 *
 * Tests are intentionally independent: each gets a fresh CTX_ROOT via
 * makeTempRoot() so state never bleeds between runs.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync, execSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'fs';
import { rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { resolve } from 'path';

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../../../');
const HOOKS_DIR = resolve(REPO_ROOT, 'dist/hooks');

// ---------------------------------------------------------------------------
// Build guard — CI test job runs on a fresh checkout with no dist/.
// Hooks are invoked as subprocesses; node exits 1 if the file is absent.
// Only builds when dist is missing — no-op for local dev.
// ---------------------------------------------------------------------------

beforeAll(() => {
  if (!existsSync(resolve(HOOKS_DIR, 'hook-loop-detector.js'))) {
    execSync('npm run build', { cwd: REPO_ROOT, stdio: 'inherit' });
  }
}, 60_000);

interface HookResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  output: Record<string, unknown> | null;
}

function runHook(
  hookName: string,
  input: Record<string, unknown>,
  env: Record<string, string> = {},
): HookResult {
  const hookPath = join(HOOKS_DIR, `${hookName}.js`);
  const result = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    env: {
      ...process.env,
      CTX_AGENT_NAME: 'test-agent',
      CTX_ORG: 'test-org',
      // No BOT_TOKEN / CHAT_ID → Telegram hooks no-op safely
      ...env,
    },
    timeout: 10_000,
  });

  let output: Record<string, unknown> | null = null;
  const trimmed = result.stdout?.trim();
  if (trimmed) {
    try {
      output = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // Non-JSON stdout — leave output null
    }
  }

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? -1,
    output,
  };
}

function makeTempRoot(): { ctxRoot: string; stateDir: string; cleanup: () => void } {
  const ctxRoot = mkdtempSync(join(tmpdir(), 'ctx-smoke-'));
  const agentName = 'test-agent';
  const stateDir = join(ctxRoot, 'state', agentName);
  mkdirSync(stateDir, { recursive: true });

  return {
    ctxRoot,
    stateDir,
    cleanup: () => {
      try {
        rmSync(ctxRoot, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Test 1: hook-loop-detector
// ---------------------------------------------------------------------------

describe('hook-loop-detector smoke', () => {
  it('allows first occurrence of a tool call (no loop)', () => {
    const { ctxRoot, stateDir, cleanup } = makeTempRoot();
    try {
      const result = runHook(
        'hook-loop-detector',
        { tool_name: 'Read', tool_input: { file_path: '/tmp/test.txt' } },
        { CTX_ROOT: ctxRoot, CTX_AGENT_NAME: 'test-agent' },
      );

      // Hook always exits 0
      expect(result.exitCode).toBe(0);

      // No block decision on first call
      expect(result.output?.decision).not.toBe('block');

      // State file should be written after first call
      const stateFile = join(stateDir, 'loop-detector.json');
      expect(existsSync(stateFile)).toBe(true);
      const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
      expect(Array.isArray(state.history)).toBe(true);
      expect(state.history.length).toBe(1);
    } finally {
      cleanup();
    }
  });

  it('detects a loop after REPETITION_BLOCK identical calls', () => {
    const { ctxRoot, cleanup } = makeTempRoot();
    try {
      const payload = {
        tool_name: 'Read',
        tool_input: { file_path: '/tmp/identical.txt' },
      };
      const env = { CTX_ROOT: ctxRoot, CTX_AGENT_NAME: 'test-agent' };

      // REPETITION_BLOCK = 15; call 15 times with identical args to trigger
      let lastResult!: HookResult;
      for (let i = 0; i < 15; i++) {
        lastResult = runHook('hook-loop-detector', payload, env);
      }

      // 15th call should emit a block decision
      expect(lastResult.output).not.toBeNull();
      expect(lastResult.output?.decision).toBe('block');
      expect(typeof lastResult.output?.reason).toBe('string');
      expect(lastResult.output?.reason as string).toMatch(/loop/i);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 2: hook-policy-check
// ---------------------------------------------------------------------------

describe('hook-policy-check smoke', () => {
  it('allows a safe Bash command (ls -la /tmp)', () => {
    const { ctxRoot, cleanup } = makeTempRoot();
    try {
      const result = runHook(
        'hook-policy-check',
        { tool_name: 'Bash', tool_input: { command: 'ls -la /tmp' } },
        { CTX_ROOT: ctxRoot, CTX_AGENT_NAME: 'test-agent' },
      );

      expect(result.exitCode).toBe(0);
      // Safe command — no block decision in output
      if (result.output) {
        expect(result.output.decision).not.toBe('block');
      }
    } finally {
      cleanup();
    }
  });

  it('blocks git push to origin (P2 violation)', () => {
    const { ctxRoot, cleanup } = makeTempRoot();
    try {
      const result = runHook(
        'hook-policy-check',
        { tool_name: 'Bash', tool_input: { command: 'git push origin main' } },
        { CTX_ROOT: ctxRoot, CTX_AGENT_NAME: 'test-agent' },
      );

      expect(result.exitCode).toBe(0);
      expect(result.output?.decision).toBe('block');
      expect(result.output?.reason as string).toMatch(/fork/i);
    } finally {
      cleanup();
    }
  });

  it('blocks git add -A (P4 violation)', () => {
    const { ctxRoot, cleanup } = makeTempRoot();
    try {
      const result = runHook(
        'hook-policy-check',
        { tool_name: 'Bash', tool_input: { command: 'git add -A && git commit -m "msg"' } },
        { CTX_ROOT: ctxRoot, CTX_AGENT_NAME: 'test-agent' },
      );

      expect(result.exitCode).toBe(0);
      expect(result.output?.decision).toBe('block');
      expect(result.output?.reason as string).toMatch(/specific paths/i);
    } finally {
      cleanup();
    }
  });

  it('allows non-Bash tool calls (policy only applies to Bash)', () => {
    const { ctxRoot, cleanup } = makeTempRoot();
    try {
      const result = runHook(
        'hook-policy-check',
        { tool_name: 'Read', tool_input: { file_path: '/etc/passwd' } },
        { CTX_ROOT: ctxRoot, CTX_AGENT_NAME: 'test-agent' },
      );

      expect(result.exitCode).toBe(0);
      // Non-Bash tools are always allowed by this hook
      if (result.output) {
        expect(result.output.decision).not.toBe('block');
      }
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 3: hook-context-status
// ---------------------------------------------------------------------------

describe('hook-context-status smoke', () => {
  it('writes context_status.json when given valid context_window input', () => {
    const { ctxRoot, stateDir, cleanup } = makeTempRoot();
    try {
      const result = runHook(
        'hook-context-status',
        {
          context_window: {
            used_percentage: 42,
            context_window_size: 200000,
            exceeds_200k_tokens: false,
            current_usage: { input_tokens: 84000, output_tokens: 0 },
          },
          session_id: 'smoke-test-session',
        },
        { CTX_ROOT: ctxRoot, CTX_AGENT_NAME: 'test-agent' },
      );

      expect(result.exitCode).toBe(0);

      const statusFile = join(stateDir, 'context_status.json');
      expect(existsSync(statusFile)).toBe(true);

      const status = JSON.parse(readFileSync(statusFile, 'utf-8'));
      expect(status.used_percentage).toBe(42);
      expect(status.context_window_size).toBe(200000);
      expect(status.exceeds_200k_tokens).toBe(false);
      expect(typeof status.written_at).toBe('string');
    } finally {
      cleanup();
    }
  });

  it('exits 0 and writes nothing when no context_window in input', () => {
    const { ctxRoot, stateDir, cleanup } = makeTempRoot();
    try {
      const result = runHook(
        'hook-context-status',
        { tool_name: 'Bash', tool_input: { command: 'ls' } },
        { CTX_ROOT: ctxRoot, CTX_AGENT_NAME: 'test-agent' },
      );

      expect(result.exitCode).toBe(0);
      // No context_window → no file written
      const statusFile = join(stateDir, 'context_status.json');
      expect(existsSync(statusFile)).toBe(false);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 5: hook-idle-flag
// ---------------------------------------------------------------------------

describe('hook-idle-flag smoke', () => {
  it('writes last_idle.flag with a Unix timestamp at the correct path', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'ctx-idle-flag-'));
    try {
      const before = Math.floor(Date.now() / 1000);

      const result = runHook(
        'hook-idle-flag',
        {},
        {
          CTX_AGENT_NAME: 'test-agent',
          CTX_INSTANCE_ID: 'default',
          HOME: tmpHome,
        },
      );

      expect(result.exitCode).toBe(0);

      const flagPath = join(tmpHome, '.cortextos', 'default', 'state', 'test-agent', 'last_idle.flag');
      expect(existsSync(flagPath)).toBe(true);

      const ts = parseInt(readFileSync(flagPath, 'utf-8').trim(), 10);
      const after = Math.floor(Date.now() / 1000);
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('exits 0 silently when CTX_AGENT_NAME is missing', () => {
    const result = runHook(
      'hook-idle-flag',
      {},
      // Override to remove the default CTX_AGENT_NAME set by runHook's base env
      { CTX_AGENT_NAME: '' },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Test 6: hook-crash-alert
// ---------------------------------------------------------------------------

describe('hook-crash-alert smoke', () => {
  it('exits 0 and appends to crashes.log (plain crash, no Telegram creds)', () => {
    // hook-crash-alert uses homedir() not CTX_ROOT — redirect HOME to temp dir.
    const tmpHome = mkdtempSync(join(tmpdir(), 'ctx-crash-alert-'));
    try {
      const result = runHook(
        'hook-crash-alert',
        {},
        {
          CTX_AGENT_NAME: 'test-agent',
          CTX_INSTANCE_ID: 'default',
          HOME: tmpHome,
          // No BOT_TOKEN / CHAT_ID — Telegram skipped, log still written
        },
      );

      expect(result.exitCode).toBe(0);

      const crashLog = join(tmpHome, '.cortextos', 'default', 'logs', 'test-agent', 'crashes.log');
      expect(existsSync(crashLog)).toBe(true);
      const content = readFileSync(crashLog, 'utf-8');
      // No marker files → endType defaults to 'crash'
      expect(content).toMatch(/type=crash/);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('reads .user-stop marker and uses endType=user-stop in crashes.log', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'ctx-crash-alert-stop-'));
    try {
      // Pre-create the state dir and drop a .user-stop marker
      const stateDir = join(tmpHome, '.cortextos', 'default', 'state', 'test-agent');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, '.user-stop'), 'stopped via cortextos stop', 'utf-8');

      const result = runHook(
        'hook-crash-alert',
        {},
        {
          CTX_AGENT_NAME: 'test-agent',
          CTX_INSTANCE_ID: 'default',
          HOME: tmpHome,
        },
      );

      expect(result.exitCode).toBe(0);

      const crashLog = join(tmpHome, '.cortextos', 'default', 'logs', 'test-agent', 'crashes.log');
      expect(existsSync(crashLog)).toBe(true);
      const content = readFileSync(crashLog, 'utf-8');
      expect(content).toMatch(/type=user-stop/);
      // Marker file should be consumed (deleted) by the hook
      expect(existsSync(join(stateDir, '.user-stop'))).toBe(false);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Test 7: hook-session-restore
// ---------------------------------------------------------------------------

describe('hook-session-restore smoke', () => {
  it('exits 0 silently when source is not compact (startup)', () => {
    const { ctxRoot, cleanup } = makeTempRoot();
    try {
      const result = runHook(
        'hook-session-restore',
        { session_id: 'test-session', source: 'startup' },
        { CTX_ROOT: ctxRoot, CTX_AGENT_NAME: 'test-agent' },
      );

      expect(result.exitCode).toBe(0);
      // No additionalContext output expected — non-compact source is a no-op
      expect(result.output).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('outputs additionalContext when source=compact and recent facts exist', () => {
    const { ctxRoot, stateDir, cleanup } = makeTempRoot();
    try {
      // Create facts directory and write a recent JSONL entry
      const factsDir = join(stateDir, 'memory', 'facts');
      mkdirSync(factsDir, { recursive: true });
      const today = new Date().toISOString().slice(0, 10);
      const factsFile = join(factsDir, `${today}.jsonl`);
      const entry = {
        ts: new Date().toISOString(),
        session_id: 'prev-session',
        agent: 'test-agent',
        org: 'test-org',
        source: 'precompact',
        summary: 'Shipped PR #29 (drain-mirror smoke tests). Suite 1101/1101.',
        keywords: ['drain-mirror', 'smoke-tests'],
      };
      writeFileSync(factsFile, JSON.stringify(entry) + '\n', 'utf-8');

      const result = runHook(
        'hook-session-restore',
        { session_id: 'new-session', source: 'compact' },
        { CTX_ROOT: ctxRoot, CTX_AGENT_NAME: 'test-agent' },
      );

      expect(result.exitCode).toBe(0);
      const hookOut = result.output?.hookSpecificOutput as Record<string, unknown> | undefined;
      expect(hookOut?.hookEventName).toBe('SessionStart');
      expect(typeof hookOut?.additionalContext).toBe('string');
      expect(hookOut?.additionalContext as string).toMatch(/Context from Previous Session/);
      expect(hookOut?.additionalContext as string).toMatch(/drain-mirror/);
    } finally {
      cleanup();
    }
  });

  it('exits 0 silently when source=compact but no facts file exists', () => {
    const { ctxRoot, cleanup } = makeTempRoot();
    try {
      // No facts dir or file — hook should no-op and exit 0
      const result = runHook(
        'hook-session-restore',
        { session_id: 'new-session', source: 'compact' },
        { CTX_ROOT: ctxRoot, CTX_AGENT_NAME: 'test-agent' },
      );

      expect(result.exitCode).toBe(0);
      expect(result.output).toBeNull();
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 8: hook-skill-telemetry
// ---------------------------------------------------------------------------

describe('hook-skill-telemetry smoke', () => {
  it('exits 0 silently when tool_name is not Skill', () => {
    const result = runHook(
      'hook-skill-telemetry',
      { tool_name: 'Read', tool_input: { file_path: '/tmp/test.txt' } },
    );

    expect(result.exitCode).toBe(0);
    // Non-Skill tool → immediate return, no stderr output
    expect(result.stderr).toBe('');
  });

  it('exits 0 with a skip message when no .env is found', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'ctx-skill-telemetry-'));
    try {
      const result = runHook(
        'hook-skill-telemetry',
        { tool_name: 'Skill', tool_input: { skill: 'memory' } },
        { CTX_AGENT_DIR: tmpDir }, // dir exists but has no .env file
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toMatch(/no .env found/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('exits 0 with a skip message when skill slug is missing from tool_input', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'ctx-skill-telemetry-slug-'));
    try {
      // Create a .env with credentials so we get past the creds check
      writeFileSync(
        join(tmpDir, '.env'),
        'SUPABASE_RGOS_URL=https://example.supabase.co\nSUPABASE_RGOS_SERVICE_KEY=test-key\n',
        'utf-8',
      );

      const result = runHook(
        'hook-skill-telemetry',
        { tool_name: 'Skill', tool_input: {} }, // no 'skill' key
        { CTX_AGENT_DIR: tmpDir },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toMatch(/no skill slug/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
