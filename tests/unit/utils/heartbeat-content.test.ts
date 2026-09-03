/**
 * tests/unit/utils/heartbeat-content.test.ts
 *
 * Unit tests for the pure heartbeat-content gate: normalizeHeartbeatContent()
 * and contentDiffers(). No I/O — plain injected heartbeat objects. Each
 * behavior is paired with a discriminating control so a regressed normalizer or
 * differ would flip an assertion.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeHeartbeatContent,
  contentDiffers,
  WATCHDOG_IDLE,
} from '../../../src/utils/heartbeat-content';
import type { Heartbeat } from '../../../src/types/index';

function hb(overrides: Partial<Heartbeat>): Partial<Heartbeat> {
  return {
    agent: 'a',
    org: 'o',
    status: 'idle',
    current_task: '',
    mode: 'day',
    last_heartbeat: '2026-08-24T10:00:00Z',
    loop_interval: '',
    ...overrides,
  };
}

describe('normalizeHeartbeatContent', () => {
  it('ignores last_heartbeat/mode/loop_interval — only status+current_task drive content', () => {
    const a = normalizeHeartbeatContent(hb({ last_heartbeat: '2026-08-24T10:00:00Z', mode: 'day', loop_interval: '20m' }));
    const b = normalizeHeartbeatContent(hb({ last_heartbeat: '2026-08-24T23:59:59Z', mode: 'night', loop_interval: '4h' }));
    expect(a).toBe(b);
  });

  it('collapses ISO timestamps embedded in status/current_task to a constant token', () => {
    const a = normalizeHeartbeatContent(hb({ current_task: 'sweeping at 2026-08-24T10:00:00Z' }));
    const b = normalizeHeartbeatContent(hb({ current_task: 'sweeping at 2026-08-24T18:30:45Z' }));
    expect(a).toBe(b);
  });

  it('a daemon idle-beat status collapses to WATCHDOG_IDLE', () => {
    const norm = normalizeHeartbeatContent(hb({ status: '[watchdog] a alive — idle session 2026-08-24T10:00:00Z' }));
    expect(norm).toBe(WATCHDOG_IDLE);
  });

  it('two different idle-beat heartbeats normalize to the SAME value (frozen, not changing)', () => {
    const a = normalizeHeartbeatContent(hb({ status: '[watchdog] a alive — idle session 2026-08-24T10:00:00Z' }));
    const b = normalizeHeartbeatContent(hb({ status: '[watchdog] a alive — idle session 2026-08-24T10:50:00Z' }));
    expect(a).toBe(b);
    expect(a).toBe(WATCHDOG_IDLE);
  });

  it('a real working status is NOT collapsed to WATCHDOG_IDLE', () => {
    const norm = normalizeHeartbeatContent(hb({ status: 'working', current_task: 'building the recovery watchdog' }));
    expect(norm).not.toBe(WATCHDOG_IDLE);
    expect(norm).toContain('building the recovery watchdog');
  });

  it('null/empty heartbeat → empty string', () => {
    expect(normalizeHeartbeatContent(null)).toBe('');
    expect(normalizeHeartbeatContent(undefined)).toBe('');
  });
});

describe('contentDiffers — the recovery-verification predicate', () => {
  it('spawn-carry MUST NOT clear: identical normalized content ⇒ differs=false', () => {
    // A restart that re-stamps the SAME status/current_task (only last_heartbeat
    // moves) normalizes identically — recovery did not produce fresh content.
    const captured = normalizeHeartbeatContent(hb({ status: 'working', current_task: 'task A', last_heartbeat: '2026-08-24T10:00:00Z' }));
    const live = normalizeHeartbeatContent(hb({ status: 'working', current_task: 'task A', last_heartbeat: '2026-08-24T10:30:00Z' }));
    expect(live).toBe(captured); // guard: spawn-carry really is byte-identical after normalization
    expect(contentDiffers(live, captured)).toBe(false);
  });

  it('watchdog-idle MUST NOT clear: a live WATCHDOG_IDLE never counts as fresh content', () => {
    const captured = normalizeHeartbeatContent(hb({ status: 'working', current_task: 'task A' }));
    const live = normalizeHeartbeatContent(hb({ status: '[watchdog] a alive — idle session 2026-08-24T11:00:00Z' }));
    expect(live).toBe(WATCHDOG_IDLE); // guard
    expect(contentDiffers(live, captured)).toBe(false);
  });

  it('real-task change MUST clear: genuinely new content ⇒ differs=true', () => {
    const captured = normalizeHeartbeatContent(hb({ status: 'working', current_task: 'task A' }));
    const live = normalizeHeartbeatContent(hb({ status: 'working', current_task: 'task B' }));
    expect(contentDiffers(live, captured)).toBe(true);
  });
});
