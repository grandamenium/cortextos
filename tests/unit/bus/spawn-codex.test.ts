import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnCodex } from '../../../src/bus/spawn-codex.js';

const previousCodexBin = process.env.CODEX_BIN;

afterEach(() => {
  if (previousCodexBin === undefined) {
    delete process.env.CODEX_BIN;
  } else {
    process.env.CODEX_BIN = previousCodexBin;
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
    expect(sidecar.prompt_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(sidecar.artifact_path).toBe(result.outputPath);
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
    expect(sidecar.stderr_excerpt).toContain('boom');
  });

  it('reports missing prompt files before spawning codex', () => {
    makeFakeCodex('#!/usr/bin/env bash\nprintf "should not run\\n"\n');
    expect(() => spawnCodex('/tmp/not-a-real-prompt-file.md')).toThrow(/Prompt file not found/);
  });
});
