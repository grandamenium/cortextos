import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  updateHeartbeat,
  detectDayNightMode,
  readAllHeartbeats,
} from '../../../src/bus/heartbeat';
import type { BusPaths } from '../../../src/types';

function makePaths(dir: string): BusPaths {
  return {
    ctxRoot: dir,
    inbox: join(dir, 'inbox', 'agent-a'),
    inflight: join(dir, 'inflight', 'agent-a'),
    processed: join(dir, 'processed', 'agent-a'),
    logDir: join(dir, 'logs', 'agent-a'),
    stateDir: join(dir, 'state', 'agent-a'),
    taskDir: join(dir, 'tasks'),
    approvalDir: join(dir, 'approvals'),
    analyticsDir: join(dir, 'analytics'),
    deliverablesDir: join(dir, 'deliverables'),
  };
}

describe('heartbeat', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-heartbeat-'));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('detectDayNightMode', () => {
    it('returns day for hour 10 UTC', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-11T10:00:00.000Z'));
      expect(detectDayNightMode('UTC')).toBe('day');
    });

    it('returns night for hour 23 UTC', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-11T23:00:00.000Z'));
      expect(detectDayNightMode('UTC')).toBe('night');
    });

    it('returns day at the hour-8 boundary UTC', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-11T08:00:00.000Z'));
      expect(detectDayNightMode('UTC')).toBe('day');
    });

    it('returns night at the hour-22 boundary UTC', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-11T22:00:00.000Z'));
      expect(detectDayNightMode('UTC')).toBe('night');
    });

    it('falls back gracefully for an invalid timezone', () => {
      const mode = detectDayNightMode('Not/A/Valid/Timezone');
      expect(['day', 'night']).toContain(mode);
    });
  });

  describe('updateHeartbeat', () => {
    it('writes heartbeat.json with correct core fields', () => {
      const paths = makePaths(testDir);
      updateHeartbeat(paths, 'dev', 'idle');
      const hb = JSON.parse(readFileSync(join(testDir, 'state', 'agent-a', 'heartbeat.json'), 'utf-8'));
      expect(hb.agent).toBe('dev');
      expect(hb.status).toBe('idle');
      expect(hb.last_heartbeat).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(['day', 'night']).toContain(hb.mode);
    });

    it('defaults org, current_task, and loop_interval to empty string', () => {
      const paths = makePaths(testDir);
      updateHeartbeat(paths, 'dev', 'working');
      const hb = JSON.parse(readFileSync(join(testDir, 'state', 'agent-a', 'heartbeat.json'), 'utf-8'));
      expect(hb.org).toBe('');
      expect(hb.current_task).toBe('');
      expect(hb.loop_interval).toBe('');
    });

    it('writes all optional fields when provided', () => {
      const paths = makePaths(testDir);
      updateHeartbeat(paths, 'dev', 'active', {
        org: 'glv',
        timezone: 'UTC',
        displayName: 'Dev Agent',
        loopInterval: '4h',
        currentTask: 'task_123',
      });
      const hb = JSON.parse(readFileSync(join(testDir, 'state', 'agent-a', 'heartbeat.json'), 'utf-8'));
      expect(hb.org).toBe('glv');
      expect(hb.display_name).toBe('Dev Agent');
      expect(hb.loop_interval).toBe('4h');
      expect(hb.current_task).toBe('task_123');
    });

    it('omits display_name when displayName option is not provided', () => {
      const paths = makePaths(testDir);
      updateHeartbeat(paths, 'dev', 'idle');
      const hb = JSON.parse(readFileSync(join(testDir, 'state', 'agent-a', 'heartbeat.json'), 'utf-8'));
      expect(Object.hasOwn(hb, 'display_name')).toBe(false);
    });

    it('sets mode to day when UTC hour is 14 (fake timer)', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-11T14:00:00.000Z'));
      const paths = makePaths(testDir);
      updateHeartbeat(paths, 'dev', 'idle', { timezone: 'UTC' });
      const hb = JSON.parse(readFileSync(join(testDir, 'state', 'agent-a', 'heartbeat.json'), 'utf-8'));
      expect(hb.mode).toBe('day');
    });
  });

  describe('readAllHeartbeats', () => {
    it('returns empty array when ctxRoot/state does not exist', () => {
      const paths = makePaths(testDir);
      expect(readAllHeartbeats(paths)).toEqual([]);
    });

    it('returns empty array when state dir has no subdirectories', () => {
      mkdirSync(join(testDir, 'state'), { recursive: true });
      const paths = makePaths(testDir);
      expect(readAllHeartbeats(paths)).toEqual([]);
    });

    it('reads a single agent heartbeat', () => {
      const agentDir = join(testDir, 'state', 'dev');
      mkdirSync(agentDir, { recursive: true });
      const hb = { agent: 'dev', status: 'idle', mode: 'day', last_heartbeat: '2026-05-11T10:00:00Z', org: '', current_task: '', loop_interval: '' };
      writeFileSync(join(agentDir, 'heartbeat.json'), JSON.stringify(hb));
      const paths = makePaths(testDir);
      const results = readAllHeartbeats(paths);
      expect(results).toHaveLength(1);
      expect(results[0].agent).toBe('dev');
      expect(results[0].status).toBe('idle');
    });

    it('reads multiple agent heartbeats', () => {
      for (const name of ['dev', 'analyst', 'scout']) {
        const dir = join(testDir, 'state', name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'heartbeat.json'), JSON.stringify({ agent: name, status: 'idle', mode: 'day', org: '', current_task: '', loop_interval: '', last_heartbeat: '2026-05-11T10:00:00Z' }));
      }
      const paths = makePaths(testDir);
      expect(readAllHeartbeats(paths)).toHaveLength(3);
    });

    it('skips agent dirs without heartbeat.json', () => {
      mkdirSync(join(testDir, 'state', 'dev'), { recursive: true });
      mkdirSync(join(testDir, 'state', 'analyst'), { recursive: true });
      writeFileSync(join(testDir, 'state', 'dev', 'heartbeat.json'), JSON.stringify({ agent: 'dev', status: 'idle', mode: 'day', org: '', current_task: '', loop_interval: '', last_heartbeat: '2026-05-11T10:00:00Z' }));
      // analyst has no heartbeat.json
      const paths = makePaths(testDir);
      const results = readAllHeartbeats(paths);
      expect(results).toHaveLength(1);
      expect(results[0].agent).toBe('dev');
    });

    it('skips agent dirs with corrupt heartbeat.json', () => {
      const devDir = join(testDir, 'state', 'dev');
      const brokenDir = join(testDir, 'state', 'broken');
      mkdirSync(devDir, { recursive: true });
      mkdirSync(brokenDir, { recursive: true });
      writeFileSync(join(devDir, 'heartbeat.json'), JSON.stringify({ agent: 'dev', status: 'idle', mode: 'day', org: '', current_task: '', loop_interval: '', last_heartbeat: '2026-05-11T10:00:00Z' }));
      writeFileSync(join(brokenDir, 'heartbeat.json'), 'not-valid-json!!!');
      const paths = makePaths(testDir);
      const results = readAllHeartbeats(paths);
      expect(results).toHaveLength(1);
      expect(results[0].agent).toBe('dev');
    });
  });
});
