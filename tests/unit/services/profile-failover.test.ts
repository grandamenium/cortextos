/**
 * BL-2026-05-08-003 phase 3 — atomic failover primitive.
 *
 * Tests the runFailover service in src/services/profile-failover.ts.
 * Each guard rejection is exercised separately so the FailoverError
 * `reason` enum is the contract: callers (the CLI command) branch
 * on `reason` to map exit codes without inspecting message strings.
 *
 * Atomic-write semantics are tested via a concrete temp tree —
 * inspecting the final config.json content + verifying no .tmp
 * file is left behind on success or after a partial failure.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  runFailover,
  FailoverError,
  CASCADE_WINDOW_MS,
} from '../../../src/services/profile-failover';

let tmpRoot: string;
const ORG = 'testorg';
const AGENT = 'engineer';

function agentDir(): string {
  return join(tmpRoot, 'orgs', ORG, 'agents', AGENT);
}

function writeProfilesJson(contents: object): void {
  const dir = join(tmpRoot, 'orgs', ORG);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'profiles.json'), JSON.stringify(contents), 'utf-8');
}

function writeAgentConfig(contents: object): void {
  mkdirSync(agentDir(), { recursive: true });
  writeFileSync(join(agentDir(), 'config.json'), JSON.stringify(contents), 'utf-8');
}

function writeBusEvent(when: Date, event: string, metadata: object): void {
  const eventsDir = join(tmpRoot, '.bus', 'events');
  mkdirSync(eventsDir, { recursive: true });
  const day = when.toISOString().slice(0, 10);
  const file = join(eventsDir, `${day}.jsonl`);
  const row = JSON.stringify({
    id: 'evt_test',
    event,
    metadata,
    timestamp: when.toISOString(),
  });
  // Append (or create); tests use one event per scenario so simple writeFile is fine.
  const prior = existsSync(file) ? readFileSync(file, 'utf-8') : '';
  writeFileSync(file, prior + row + '\n', 'utf-8');
}

function emitRecorder() {
  const calls: Array<{ event: string; severity: string; meta: Record<string, unknown> }> = [];
  return {
    fn: (event: string, severity: string, meta: Record<string, unknown>) => {
      calls.push({ event, severity, meta });
    },
    calls,
  };
}

function restartRecorder() {
  const calls: Array<{ agent: string; reason: string }> = [];
  return {
    fn: (agent: string, reason: string) => calls.push({ agent, reason }),
    calls,
  };
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'failover-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('runFailover happy path', () => {
  it('swaps claude_profile to fallback_profile and emits the audit event', () => {
    writeProfilesJson({
      default_profile: 'personal',
      profiles: {
        personal: { config_dir: '/Users/x/.claude' },
        work: { config_dir: '/Users/x/.claude-work' },
      },
    });
    writeAgentConfig({
      agent_name: AGENT,
      claude_profile: 'personal',
      fallback_profile: 'work',
      enabled: true,
    });
    const emit = emitRecorder();
    const restart = restartRecorder();

    const result = runFailover({
      projectRoot: tmpRoot,
      org: ORG,
      agentName: AGENT,
      triggerEventId: 'evt_quota_42',
      now: new Date('2026-05-08T20:30:00Z'),
      emit: emit.fn,
      sendRestart: restart.fn,
    });

    expect(result).toEqual({
      agent: AGENT,
      from_profile: 'personal',
      to_profile: 'work',
      trigger_event_id: 'evt_quota_42',
      restarted_at: '2026-05-08T20:30:00.000Z',
    });

    const cfg = JSON.parse(readFileSync(join(agentDir(), 'config.json'), 'utf-8'));
    expect(cfg.claude_profile).toBe('work');
    expect(cfg.fallback_profile).toBe('work');
    expect(cfg.agent_name).toBe(AGENT);
    expect(cfg.enabled).toBe(true);

    expect(emit.calls).toHaveLength(1);
    expect(emit.calls[0].event).toBe('profile_failover');
    expect(emit.calls[0].severity).toBe('warning');
    expect(emit.calls[0].meta).toEqual(result);

    expect(restart.calls).toHaveLength(1);
    expect(restart.calls[0].agent).toBe(AGENT);
    expect(restart.calls[0].reason).toMatch(/personal → work/);
    expect(restart.calls[0].reason).toMatch(/evt_quota_42/);
  });

  it('records from_profile=null when claude_profile was unset (registry default in use)', () => {
    writeProfilesJson({
      default_profile: 'personal',
      profiles: {
        personal: { config_dir: '/Users/x/.claude' },
        work: { config_dir: '/Users/x/.claude-work' },
      },
    });
    writeAgentConfig({
      agent_name: AGENT,
      // claude_profile intentionally absent; agent uses registry default
      fallback_profile: 'work',
    });
    const emit = emitRecorder();
    const restart = restartRecorder();

    const result = runFailover({
      projectRoot: tmpRoot,
      org: ORG,
      agentName: AGENT,
      triggerEventId: 'e1',
      now: new Date('2026-05-08T20:30:00Z'),
      emit: emit.fn,
      sendRestart: restart.fn,
    });

    expect(result.from_profile).toBeNull();
    expect(result.to_profile).toBe('work');
  });

  it('leaves no .tmp file behind after success (atomic write)', () => {
    writeProfilesJson({
      default_profile: 'personal',
      profiles: { personal: { config_dir: '/p' }, work: { config_dir: '/w' } },
    });
    writeAgentConfig({ agent_name: AGENT, fallback_profile: 'work' });

    runFailover({
      projectRoot: tmpRoot,
      org: ORG,
      agentName: AGENT,
      triggerEventId: 'e1',
      emit: emitRecorder().fn,
      sendRestart: restartRecorder().fn,
    });

    expect(existsSync(join(agentDir(), 'config.json.tmp'))).toBe(false);
  });
});

describe('runFailover guard rejections', () => {
  function makeOpts(overrides: Partial<Parameters<typeof runFailover>[0]> = {}) {
    return {
      projectRoot: tmpRoot,
      org: ORG,
      agentName: AGENT,
      triggerEventId: 'e1',
      emit: emitRecorder().fn,
      sendRestart: restartRecorder().fn,
      ...overrides,
    };
  }

  it('throws agent_dir_missing when the agent directory does not exist', () => {
    writeProfilesJson({ default_profile: 'p', profiles: { p: { config_dir: '/p' } } });
    expect(() => runFailover(makeOpts())).toThrowError(
      expect.objectContaining({ name: 'FailoverError', reason: 'agent_dir_missing' }),
    );
  });

  it('throws config_unreadable when config.json is malformed JSON', () => {
    mkdirSync(agentDir(), { recursive: true });
    writeFileSync(join(agentDir(), 'config.json'), '{ not json', 'utf-8');
    writeProfilesJson({ default_profile: 'p', profiles: { p: { config_dir: '/p' } } });
    expect(() => runFailover(makeOpts())).toThrowError(
      expect.objectContaining({ reason: 'config_unreadable' }),
    );
  });

  it('throws no_fallback_configured when the agent has no fallback_profile', () => {
    writeProfilesJson({
      default_profile: 'personal',
      profiles: { personal: { config_dir: '/p' }, work: { config_dir: '/w' } },
    });
    writeAgentConfig({ agent_name: AGENT, claude_profile: 'personal' });
    // boss-LLM should send Saurav a Telegram alert in this case;
    // the CLI exits 2 to signal "manual intervention required".
    expect(() => runFailover(makeOpts())).toThrowError(
      expect.objectContaining({ reason: 'no_fallback_configured' }),
    );
  });

  it('throws registry_missing when orgs/<org>/profiles.json is absent', () => {
    writeAgentConfig({ agent_name: AGENT, fallback_profile: 'work' });
    expect(() => runFailover(makeOpts())).toThrowError(
      expect.objectContaining({ reason: 'registry_missing' }),
    );
  });

  it('throws fallback_profile_unknown when fallback_profile is not in the registry', () => {
    writeProfilesJson({
      default_profile: 'personal',
      profiles: { personal: { config_dir: '/p' } },
    });
    writeAgentConfig({ agent_name: AGENT, fallback_profile: 'enterprise' });
    expect(() => runFailover(makeOpts())).toThrowError(
      expect.objectContaining({ reason: 'fallback_profile_unknown' }),
    );
  });

  it('throws cascade_window_active when target profile recently exhausted', () => {
    // Boss-LLM should NOT auto-failover into a profile that just
    // emitted profile_quota_exhausted itself — that's the cascade
    // shape (mass quota incident). Manual triage required.
    writeProfilesJson({
      default_profile: 'personal',
      profiles: { personal: { config_dir: '/p' }, work: { config_dir: '/w' } },
    });
    writeAgentConfig({ agent_name: AGENT, fallback_profile: 'work' });

    expect(() =>
      runFailover(
        makeOpts({
          recentExhaustionFor: (profile) => profile === 'work',
        }),
      ),
    ).toThrowError(expect.objectContaining({ reason: 'cascade_window_active' }));
  });

  it('does NOT swap config or emit/restart on any guard rejection', () => {
    writeProfilesJson({
      default_profile: 'personal',
      profiles: { personal: { config_dir: '/p' } },
    });
    writeAgentConfig({
      agent_name: AGENT,
      claude_profile: 'personal',
      fallback_profile: 'enterprise', // dangling
    });
    const emit = emitRecorder();
    const restart = restartRecorder();

    expect(() =>
      runFailover(makeOpts({ emit: emit.fn, sendRestart: restart.fn })),
    ).toThrow();

    // Config unchanged
    const cfg = JSON.parse(readFileSync(join(agentDir(), 'config.json'), 'utf-8'));
    expect(cfg.claude_profile).toBe('personal');
    // No side effects
    expect(emit.calls).toHaveLength(0);
    expect(restart.calls).toHaveLength(0);
  });
});

describe('runFailover cascade-prevention via bus log', () => {
  it('detects a fresh profile_quota_exhausted on the target profile', () => {
    writeProfilesJson({
      default_profile: 'personal',
      profiles: { personal: { config_dir: '/p' }, work: { config_dir: '/w' } },
    });
    writeAgentConfig({ agent_name: AGENT, fallback_profile: 'work' });

    const now = new Date('2026-05-08T20:30:00Z');
    // Event landed 10 min ago — within the 30-min cascade window
    const past = new Date(now.getTime() - 10 * 60 * 1000);
    writeBusEvent(past, 'profile_quota_exhausted', { profile: 'work' });

    expect(() =>
      runFailover({
        projectRoot: tmpRoot,
        org: ORG,
        agentName: AGENT,
        triggerEventId: 'e1',
        now,
        emit: emitRecorder().fn,
        sendRestart: restartRecorder().fn,
      }),
    ).toThrowError(expect.objectContaining({ reason: 'cascade_window_active' }));
  });

  it('ignores stale events older than the cascade window', () => {
    writeProfilesJson({
      default_profile: 'personal',
      profiles: { personal: { config_dir: '/p' }, work: { config_dir: '/w' } },
    });
    writeAgentConfig({ agent_name: AGENT, fallback_profile: 'work' });

    const now = new Date('2026-05-08T20:30:00Z');
    // Event landed 45 min ago — beyond the 30-min window
    const past = new Date(now.getTime() - (CASCADE_WINDOW_MS + 15 * 60 * 1000));
    writeBusEvent(past, 'profile_quota_exhausted', { profile: 'work' });

    const emit = emitRecorder();
    const restart = restartRecorder();
    const result = runFailover({
      projectRoot: tmpRoot,
      org: ORG,
      agentName: AGENT,
      triggerEventId: 'e1',
      now,
      emit: emit.fn,
      sendRestart: restart.fn,
    });
    expect(result.to_profile).toBe('work');
  });

  it('ignores events for OTHER profiles', () => {
    // A profile_quota_exhausted on `personal` shouldn't block a
    // failover INTO `work` — only events about the target matter.
    writeProfilesJson({
      default_profile: 'personal',
      profiles: { personal: { config_dir: '/p' }, work: { config_dir: '/w' } },
    });
    writeAgentConfig({ agent_name: AGENT, fallback_profile: 'work' });

    const now = new Date('2026-05-08T20:30:00Z');
    const past = new Date(now.getTime() - 10 * 60 * 1000);
    writeBusEvent(past, 'profile_quota_exhausted', { profile: 'personal' });

    const result = runFailover({
      projectRoot: tmpRoot,
      org: ORG,
      agentName: AGENT,
      triggerEventId: 'e1',
      now,
      emit: emitRecorder().fn,
      sendRestart: restartRecorder().fn,
    });
    expect(result.to_profile).toBe('work');
  });

  it('returns false (not a cascade) when no bus log directory exists', () => {
    // A fresh deployment has no .bus/events/ yet — the failover
    // should proceed, not fail-shut.
    writeProfilesJson({
      default_profile: 'personal',
      profiles: { personal: { config_dir: '/p' }, work: { config_dir: '/w' } },
    });
    writeAgentConfig({ agent_name: AGENT, fallback_profile: 'work' });
    const result = runFailover({
      projectRoot: tmpRoot,
      org: ORG,
      agentName: AGENT,
      triggerEventId: 'e1',
      now: new Date('2026-05-08T20:30:00Z'),
      emit: emitRecorder().fn,
      sendRestart: restartRecorder().fn,
    });
    expect(result.to_profile).toBe('work');
  });
});

describe('FailoverError shape', () => {
  it('exposes the reason as a typed field', () => {
    const err = new FailoverError('cascade_window_active', 'msg');
    expect(err.name).toBe('FailoverError');
    expect(err.reason).toBe('cascade_window_active');
    expect(err.message).toBe('msg');
    expect(err).toBeInstanceOf(Error);
  });
});
