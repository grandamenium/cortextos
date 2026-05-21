import { describe, it, expect } from 'vitest';
import { checkRoutingHealth } from '../../../src/bus/routing-health';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function makeEventLine(category: string, eventName: string, metadata: Record<string, unknown> = {}) {
  return JSON.stringify({
    category,
    event_name: eventName,
    timestamp: new Date().toISOString(),
    metadata,
  });
}

let tempDir: string;

function setupEvents(agentName: string, lines: string[]): string {
  tempDir = mkdtempSync(join(tmpdir(), 'routing-health-'));
  const today = new Date().toISOString().split('T')[0];
  const dir = join(tempDir, 'events', agentName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${today}.jsonl`), lines.join('\n') + '\n');
  return tempDir;
}

describe('checkRoutingHealth', () => {
  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns insufficient_data when fewer than 10 events', () => {
    const analyticsDir = setupEvents('forge', [
      makeEventLine('message', 'telegram_sent'),
    ]);
    const report = checkRoutingHealth(analyticsDir, 24);
    expect(report.status).toBe('insufficient_data');
  });

  it('returns healthy when Codex:Claude ratio >= 0.5', () => {
    const lines = [
      ...Array(5).fill(makeEventLine('message', 'telegram_sent')),
      ...Array(10).fill(makeEventLine('action', 'task_completed', { commit: 'abc1234' })),
    ];
    const analyticsDir = setupEvents('forge', lines);
    const report = checkRoutingHealth(analyticsDir, 24);
    expect(report.status).toBe('healthy');
    expect(report.ratio).toBeGreaterThanOrEqual(0.5);
  });

  it('returns drift_warning when ratio is between 0.2 and 0.5', () => {
    const lines = [
      ...Array(20).fill(makeEventLine('message', 'telegram_sent')),
      ...Array(6).fill(makeEventLine('action', 'task_completed', { commit: 'abc1234' })),
    ];
    const analyticsDir = setupEvents('forge', lines);
    const report = checkRoutingHealth(analyticsDir, 24);
    expect(report.status).toBe('drift_warning');
  });

  it('returns drift_critical when ratio is below 0.2', () => {
    const lines = [
      ...Array(50).fill(makeEventLine('message', 'telegram_sent')),
      ...Array(2).fill(makeEventLine('action', 'task_completed', { commit: 'abc1234' })),
    ];
    const analyticsDir = setupEvents('forge', lines);
    const report = checkRoutingHealth(analyticsDir, 24);
    expect(report.status).toBe('drift_critical');
  });

  it('only counts task_completed events with commit hash as Codex completions', () => {
    const lines = [
      ...Array(10).fill(makeEventLine('message', 'telegram_sent')),
      makeEventLine('action', 'task_completed', { commit: 'abc1234' }), // Codex
      makeEventLine('action', 'task_completed', {}), // non-Codex (no commit)
    ];
    const analyticsDir = setupEvents('forge', lines);
    const report = checkRoutingHealth(analyticsDir, 24);
    expect(report.codexTaskCompletions).toBe(1);
  });
});
