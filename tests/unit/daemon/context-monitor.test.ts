import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ContextMonitor } from '../../../src/daemon/context-monitor';

describe('ContextMonitor — context usage estimation + threshold callbacks', () => {
  let stateDir: string;
  let logPath: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'ctx-monitor-'));
    logPath = join(stateDir, 'stdout.log');
    writeFileSync(logPath, '', 'utf-8');
  });

  afterEach(() => { rmSync(stateDir, { recursive: true, force: true }); });

  it('starts at 0% with a fresh session and empty log', () => {
    const cm = new ContextMonitor('alice', stateDir, logPath, 3600);
    const est = cm.estimate();
    expect(est.pct).toBeLessThan(1);
    expect(cm.classify(est)).toBe('ok');
  });

  it('estimates context from log growth (output_size signal)', () => {
    const cm = new ContextMonitor('alice', stateDir, logPath, 99999, {
      max_session_tokens: 1000,
    });
    // Write ~2000 chars → ~500 tokens → 50% of 1000
    writeFileSync(logPath, 'x'.repeat(2000), 'utf-8');
    const est = cm.estimate();
    expect(est.pct).toBeGreaterThanOrEqual(45);
    expect(est.pct).toBeLessThanOrEqual(55);
    expect(est.signal).toBe('output_size');
  });

  it('classify returns correct thresholds at each level', () => {
    const cm = new ContextMonitor('alice', stateDir, logPath, 3600, {
      warn_pct: 60, alert_pct: 80, critical_pct: 95,
    });
    expect(cm.classify({ pct: 50, tokens_est: 0, max_tokens: 1000, signal: 'time' })).toBe('ok');
    expect(cm.classify({ pct: 65, tokens_est: 0, max_tokens: 1000, signal: 'time' })).toBe('warn');
    expect(cm.classify({ pct: 85, tokens_est: 0, max_tokens: 1000, signal: 'time' })).toBe('alert');
    expect(cm.classify({ pct: 96, tokens_est: 0, max_tokens: 1000, signal: 'time' })).toBe('critical');
  });

  it('fires onWarn callback at warn threshold and writes continuation file', () => {
    const cm = new ContextMonitor('alice', stateDir, logPath, 99999, {
      max_session_tokens: 100, warn_pct: 40, alert_pct: 50, critical_pct: 60,
    });
    const warns: number[] = [];
    cm.setOnWarn((est) => warns.push(est.pct));

    // Push past 40% of 100 tokens → 40+ chars / 4 chars per token
    writeFileSync(logPath, 'x'.repeat(180), 'utf-8');
    cm.check();

    expect(warns.length).toBe(1);
    expect(warns[0]).toBeGreaterThanOrEqual(40);
    expect(existsSync(join(stateDir, 'continuation.md'))).toBe(true);
  });

  it('fires onAlert at alert threshold', () => {
    const cm = new ContextMonitor('alice', stateDir, logPath, 99999, {
      max_session_tokens: 100, warn_pct: 40, alert_pct: 50, critical_pct: 60,
    });
    const alerts: number[] = [];
    cm.setOnAlert((est) => alerts.push(est.pct));

    writeFileSync(logPath, 'x'.repeat(220), 'utf-8'); // ~55 tokens → 55%
    cm.check(); // fires warn (40%)
    cm.check(); // fires alert (50%)

    expect(alerts.length).toBe(1);
  });

  it('fires onCritical at critical threshold', () => {
    const cm = new ContextMonitor('alice', stateDir, logPath, 99999, {
      max_session_tokens: 100, warn_pct: 60, alert_pct: 80, critical_pct: 95,
    });
    const criticals: number[] = [];
    cm.setOnCritical((est) => criticals.push(est.pct));

    writeFileSync(logPath, 'x'.repeat(400), 'utf-8'); // ~100 tokens → 100%
    cm.check();
    cm.check();
    cm.check();

    expect(criticals.length).toBe(1);
  });

  it('each threshold fires only once (no re-fire on repeated checks)', () => {
    const cm = new ContextMonitor('alice', stateDir, logPath, 99999, {
      max_session_tokens: 100, warn_pct: 40, alert_pct: 50, critical_pct: 60,
    });
    const warns: number[] = [];
    cm.setOnWarn((est) => warns.push(est.pct));

    writeFileSync(logPath, 'x'.repeat(180), 'utf-8');
    cm.check();
    cm.check();
    cm.check();

    expect(warns.length).toBe(1);
  });

  it('continuation file contains agent name + estimate', () => {
    const cm = new ContextMonitor('alice', stateDir, logPath, 99999, {
      max_session_tokens: 100, warn_pct: 60,
    });
    writeFileSync(logPath, 'x'.repeat(280), 'utf-8');
    cm.check();

    const content = readFileSync(join(stateDir, 'continuation.md'), 'utf-8');
    expect(content).toContain('alice');
    expect(content).toContain('Context estimate:');
    expect(content).toContain('Tokens estimated:');
  });

  it('start/stop manages the check interval', () => {
    vi.useFakeTimers();
    try {
      const cm = new ContextMonitor('alice', stateDir, logPath, 99999, {
        check_interval_ms: 100, max_session_tokens: 100, warn_pct: 40, alert_pct: 50, critical_pct: 60,
      });
      const warns: number[] = [];
      cm.setOnWarn((est) => warns.push(est.pct));

      writeFileSync(logPath, 'x'.repeat(180), 'utf-8');
      cm.start();
      vi.advanceTimersByTime(150);
      cm.stop();

      expect(warns.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ContextMonitor — burn classification', () => {
  let stateDir: string;
  let logPath: string;
  let taskDir: string;
  let heartbeatDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'ctx-burn-'));
    logPath = join(stateDir, 'stdout.log');
    taskDir = join(stateDir, 'tasks');
    heartbeatDir = join(stateDir, 'heartbeats');
    writeFileSync(logPath, '', 'utf-8');
    const { mkdirSync } = require('fs');
    mkdirSync(taskDir, { recursive: true });
    mkdirSync(heartbeatDir, { recursive: true });
  });

  afterEach(() => { rmSync(stateDir, { recursive: true, force: true }); });

  it('classifies as large_task when agent has an in_progress task + fresh heartbeat', () => {
    // Write a task file
    writeFileSync(join(taskDir, 'task_123_001.json'), JSON.stringify({
      id: 'task_123_001', status: 'in_progress', assigned_to: 'alice',
    }));
    // Write a fresh heartbeat
    const { mkdirSync: mkd } = require('fs');
    mkd(join(heartbeatDir, 'alice'), { recursive: true });
    writeFileSync(join(heartbeatDir, 'alice', 'heartbeat.json'), JSON.stringify({
      last_heartbeat: new Date().toISOString(),
    }));

    const cm = new ContextMonitor('alice', stateDir, logPath, 99999);
    cm.setBurnContext({ taskDir, heartbeatDir });

    const burn = cm.classifyBurn();
    expect(burn.classification).toBe('large_task');
    expect(burn.has_active_task).toBe(true);
    expect(burn.heartbeat_fresh).toBe(true);
  });

  it('classifies as runaway when no active task and stale heartbeat', () => {
    // No tasks, stale heartbeat
    const { mkdirSync: mkd } = require('fs');
    mkd(join(heartbeatDir, 'alice'), { recursive: true });
    writeFileSync(join(heartbeatDir, 'alice', 'heartbeat.json'), JSON.stringify({
      last_heartbeat: '2020-01-01T00:00:00Z',
    }));

    const cm = new ContextMonitor('alice', stateDir, logPath, 99999);
    cm.setBurnContext({ taskDir, heartbeatDir });

    const burn = cm.classifyBurn();
    expect(burn.classification).toBe('runaway');
    expect(burn.has_active_task).toBe(false);
    expect(burn.heartbeat_fresh).toBe(false);
  });

  it('classifies as runaway when log output is repetitive (low entropy)', () => {
    // Write repetitive log output (>40% duplicate lines)
    const repeatedLine = 'ERROR: something went wrong in the loop\n';
    writeFileSync(logPath, repeatedLine.repeat(200), 'utf-8');

    // Even with active task, repetitive output signals runaway
    writeFileSync(join(taskDir, 'task_123_001.json'), JSON.stringify({
      id: 'task_123_001', status: 'in_progress', assigned_to: 'alice',
    }));
    const { mkdirSync: mkd } = require('fs');
    mkd(join(heartbeatDir, 'alice'), { recursive: true });
    writeFileSync(join(heartbeatDir, 'alice', 'heartbeat.json'), JSON.stringify({
      last_heartbeat: new Date().toISOString(),
    }));

    const cm = new ContextMonitor('alice', stateDir, logPath, 99999);
    cm.setBurnContext({ taskDir, heartbeatDir });

    const burn = cm.classifyBurn();
    expect(burn.classification).toBe('runaway');
    expect(burn.log_entropy_low).toBe(true);
  });

  it('returns unknown when no context dirs are configured', () => {
    const cm = new ContextMonitor('alice', stateDir, logPath, 99999);
    // No setBurnContext call
    const burn = cm.classifyBurn();
    expect(burn.classification).toBe('unknown');
  });

  it('check() passes burn analysis to callbacks', () => {
    writeFileSync(join(taskDir, 'task_123_001.json'), JSON.stringify({
      id: 'task_123_001', status: 'in_progress', assigned_to: 'alice',
    }));
    const { mkdirSync: mkd } = require('fs');
    mkd(join(heartbeatDir, 'alice'), { recursive: true });
    writeFileSync(join(heartbeatDir, 'alice', 'heartbeat.json'), JSON.stringify({
      last_heartbeat: new Date().toISOString(),
    }));

    const cm = new ContextMonitor('alice', stateDir, logPath, 99999, {
      max_session_tokens: 100, warn_pct: 40, alert_pct: 50, critical_pct: 60,
    });
    cm.setBurnContext({ taskDir, heartbeatDir });

    let receivedBurn: any = null;
    cm.setOnWarn((_est, burn) => { receivedBurn = burn; });

    writeFileSync(logPath, 'x'.repeat(180), 'utf-8');
    cm.check();

    expect(receivedBurn).not.toBeNull();
    expect(receivedBurn.classification).toBe('large_task');
  });
});
