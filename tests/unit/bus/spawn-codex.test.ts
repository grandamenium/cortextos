import { existsSync, mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import { basename, join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnCodex } from '../../../src/bus/spawn-codex.js';

const previousCodexBin = process.env.CODEX_BIN;
const previousSessionOwnerPid = process.env.CTX_SESSION_OWNER_PID;

afterEach(() => {
  vi.useRealTimers();
  if (previousCodexBin === undefined) {
    delete process.env.CODEX_BIN;
  } else {
    process.env.CODEX_BIN = previousCodexBin;
  }
  if (previousSessionOwnerPid === undefined) {
    delete process.env.CTX_SESSION_OWNER_PID;
  } else {
    process.env.CTX_SESSION_OWNER_PID = previousSessionOwnerPid;
  }
});

function makeFakeCodex(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'spawn-codex-bin-'));
  const bin = join(dir, 'codex-fake');
  writeFileSync(bin, body, 'utf-8');
  chmodSync(bin, 0o755);
  process.env.CODEX_BIN = bin;
  return dir;
}

function makePrompt(text = 'Say OK and exit.'): { dir: string; prompt: string; agentsRoot: string } {
  const dir = mkdtempSync(join(tmpdir(), 'spawn-codex-test-'));
  const prompt = join(dir, 'prompt.md');
  const agentsRoot = join(dir, 'org');
  writeFileSync(prompt, text, 'utf-8');
  return { dir, prompt, agentsRoot };
}

describe('spawnCodex', () => {
  it('writes an artifact and JSON sidecar for successful runs', () => {
    makeFakeCodex('#!/usr/bin/env bash\nprintf "fake codex ok\\n"\n');
    const { prompt, agentsRoot } = makePrompt();

    const result = spawnCodex(prompt, {
      agentsRoot,
      agentName: 'codex',
      taskId: 'task-123',
      requester: 'orchestrator',
      sandbox: 'danger-full-access',
      timeout: 5,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('success');
    expect(result.output).toContain('fake codex ok');
    expect(result.outputPath).toContain('/agents/codex/output/');
    expect(readFileSync(result.outputPath, 'utf-8')).toContain('fake codex ok');

    const sidecar = JSON.parse(readFileSync(result.sidecarPath, 'utf-8'));
    expect(sidecar.ok).toBe(true);
    expect(sidecar.task_id).toBe('task-123');
    expect(sidecar.requester).toBe('orchestrator');
    expect(sidecar.sandbox).toBe('danger-full-access');
    expect(sidecar.prompt_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(sidecar.artifact_path).toBe(result.outputPath);
    expect(sidecar.run_id).toMatch(/^\d{8}T\d{6}Z-[a-f0-9]{8}$/);
    expect(sidecar.exit).toEqual({ code: 0, signal: null, timed_out: false });
    expect(sidecar.stdout).toContain('fake codex ok');
    expect(sidecar.stderr).toBe('');
    expect(sidecar.output_collision_guard).toBe('created');
  });

  it('sets target agent identity env for the spawned Codex process', () => {
    makeFakeCodex(`#!/usr/bin/env bash
printf 'agent=%s\\n' "$CTX_AGENT_NAME"
printf 'dir=%s\\n' "$CTX_AGENT_DIR"
printf 'org=%s\\n' "$CTX_ORG"
`);
    const { prompt, agentsRoot } = makePrompt();

    const result = spawnCodex(prompt, {
      agentsRoot,
      agentName: 'dev',
      timeout: 5,
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain('agent=dev');
    expect(result.output).toContain(`dir=${join(agentsRoot, 'agents', 'dev')}`);
    expect(result.output).toContain(`org=${basename(agentsRoot)}`);
  });

  it('forwards session ownership proof for daemon-spawned target agents', () => {
    delete process.env.CTX_SESSION_OWNER_PID;
    makeFakeCodex(`#!/usr/bin/env bash
printf 'owner=%s\\n' "$CTX_SESSION_OWNER_PID"
`);
    const { prompt, agentsRoot } = makePrompt();

    const result = spawnCodex(prompt, {
      agentsRoot,
      agentName: 'analyst',
      timeout: 5,
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain(`owner=${process.pid}`);
  });

  it('preserves an inherited session ownership proof from an agent PTY', () => {
    process.env.CTX_SESSION_OWNER_PID = '424242';
    makeFakeCodex(`#!/usr/bin/env bash
printf 'owner=%s\\n' "$CTX_SESSION_OWNER_PID"
`);
    const { prompt, agentsRoot } = makePrompt();

    const result = spawnCodex(prompt, {
      agentsRoot,
      agentName: 'analyst',
      timeout: 5,
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain('owner=424242');
  });

  it('writes failure metadata when codex exits non-zero', () => {
    makeFakeCodex('#!/usr/bin/env bash\nprintf "partial output\\n"\nprintf "boom\\n" >&2\nexit 7\n');
    const { prompt, agentsRoot } = makePrompt();

    const result = spawnCodex(prompt, { agentsRoot, agentName: 'codex', timeout: 5 });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(7);
    expect(readFileSync(result.outputPath, 'utf-8')).toContain('partial output');

    const sidecar = JSON.parse(readFileSync(result.sidecarPath, 'utf-8'));
    expect(sidecar.ok).toBe(false);
    expect(sidecar.exit_code).toBe(7);
    expect(sidecar.exit.code).toBe(7);
    expect(sidecar.stdout).toContain('partial output');
    expect(sidecar.stderr).toContain('boom');
    expect(sidecar.stderr_excerpt).toContain('boom');
  });

  it('does not overwrite an existing artifact when two runs share the same prompt slug', () => {
    makeFakeCodex('#!/usr/bin/env bash\nprintf "same slug\\n"\n');
    const { prompt, agentsRoot } = makePrompt();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-16T12:34:56.789Z'));

    const first = spawnCodex(prompt, { agentsRoot, agentName: 'codex', timeout: 5 });
    writeFileSync(first.outputPath, 'sentinel\n', 'utf-8');
    const second = spawnCodex(prompt, { agentsRoot, agentName: 'codex', timeout: 5 });

    expect(existsSync(first.outputPath)).toBe(true);
    expect(readFileSync(first.outputPath, 'utf-8')).toBe('sentinel\n');
    expect(second.outputPath).not.toBe(first.outputPath);
    const sidecar = JSON.parse(readFileSync(second.sidecarPath, 'utf-8'));
    expect(sidecar.output_collision_guard).toBe('renamed');
  });

  it('reports missing prompt files before spawning codex', () => {
    makeFakeCodex('#!/usr/bin/env bash\nprintf "should not run\\n"\n');
    expect(() => spawnCodex('/tmp/not-a-real-prompt-file.md')).toThrow(/Prompt file not found/);
  });
});
