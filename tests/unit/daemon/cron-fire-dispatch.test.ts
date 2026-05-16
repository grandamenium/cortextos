import { describe, expect, it, vi } from 'vitest';
import { dispatchCronFire } from '../../../src/daemon/cron-fire-dispatch.js';
import type { CronDefinition } from '../../../src/types/index.js';
import type { SpawnCodexResult } from '../../../src/bus/spawn-codex.js';

function cron(overrides: Partial<CronDefinition> = {}): CronDefinition {
  return {
    name: 'evening-review',
    prompt: 'Run evening review',
    schedule: '3 18 * * *',
    enabled: true,
    created_at: '2026-05-16T00:00:00.000Z',
    ...overrides,
  };
}

function result(ok = true): SpawnCodexResult {
  return {
    ok,
    status: ok ? 'success' : 'failed',
    outputPath: '/tmp/out.md',
    sidecarPath: '/tmp/out.json',
    output: 'done',
    stderr: '',
    exitCode: ok ? 0 : 1,
    timedOut: false,
    durationMs: 12,
    metadata: {
      ok,
      status: ok ? 'success' : 'failed',
      started_at: '2026-05-16T00:00:00.000Z',
      completed_at: '2026-05-16T00:00:00.012Z',
      duration_ms: 12,
      prompt_file: '/tmp/prompt.md',
      prompt_sha256: 'abc',
      prompt_chars: 10,
      artifact_path: '/tmp/out.md',
      sidecar_path: '/tmp/out.json',
      workdir: '/tmp',
      agent: 'codex',
      task_id: 'cron:orchestrator:evening-review',
      requester: 'orchestrator',
      reply_to: null,
      priority: 'cron',
      model: null,
      effort: null,
      mcp_config: null,
      exit_code: ok ? 0 : 1,
      timed_out: false,
      stdout_chars: 4,
      stderr_excerpt: null,
    },
  };
}

describe('dispatchCronFire', () => {
  it('keeps default PTY cron injection behavior', () => {
    const injectAgent = vi.fn().mockReturnValue(true);

    dispatchCronFire(cron(), {
      agentName: 'orchestrator',
      frameworkRoot: '/repo',
      org: 'revops-global',
      injectAgent,
      now: () => new Date('2026-05-16T12:00:00.000Z'),
    });

    expect(injectAgent).toHaveBeenCalledWith(
      'orchestrator',
      '[CRON FIRED 2026-05-16T12:00:00.000Z] evening-review: Run evening review',
    );
  });

  it('runs spawn-codex crons without injecting into the long-running PTY', () => {
    const injectAgent = vi.fn();
    const spawnCodexImpl = vi.fn().mockReturnValue(result(true));

    dispatchCronFire(cron({
      metadata: {
        runner: 'spawn-codex',
        prompt_file: 'prompts/evening-review.md',
        workdir: '.',
        agent: 'codex',
        timeout_seconds: 900,
        task_id: '755920d9',
        model: 'gpt-5.4',
        effort: 'medium',
      },
    }), {
      agentName: 'orchestrator',
      frameworkRoot: '/repo',
      org: 'revops-global',
      injectAgent,
      spawnCodexImpl,
    });

    expect(injectAgent).not.toHaveBeenCalled();
    expect(spawnCodexImpl).toHaveBeenCalledWith('/repo/orgs/revops-global/prompts/evening-review.md', {
      agentName: 'codex',
      agentsRoot: '/repo/orgs/revops-global',
      workdir: '/repo/orgs/revops-global',
      timeout: 900,
      model: 'gpt-5.4',
      effort: 'medium',
      mcpConfig: undefined,
      taskId: '755920d9',
      requester: 'orchestrator',
      priority: 'cron',
    });
  });

  it('throws when a spawn-codex cron fails', () => {
    expect(() => dispatchCronFire(cron({
      metadata: { runner: 'spawn-codex', prompt_file: 'prompts/evening-review.md' },
    }), {
      agentName: 'orchestrator',
      frameworkRoot: '/repo',
      org: 'revops-global',
      injectAgent: vi.fn(),
      spawnCodexImpl: vi.fn().mockReturnValue(result(false)),
    })).toThrow(/spawn-codex cron "evening-review" failed/);
  });
});
