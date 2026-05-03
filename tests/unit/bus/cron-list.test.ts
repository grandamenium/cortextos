import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  writeCronList,
  readCronList,
  findMissingCrons,
  type CronListEntry,
} from '../../../src/bus/cron-list';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cron-list-test-'));
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
});

const ONE_HOUR_MS = 60 * 60 * 1000;

describe('writeCronList + readCronList', () => {
  it('round-trips a non-empty list', () => {
    writeCronList(tmpDir, [
      { name: 'heartbeat', prompt: 'Read HEARTBEAT.md and...' },
      { name: 'autoresearch', prompt: 'Run autoresearch loop...' },
    ]);
    const file = readCronList(tmpDir, ONE_HOUR_MS);
    expect(file).not.toBeNull();
    expect(file!.crons).toHaveLength(2);
    expect(file!.crons[0].name).toBe('heartbeat');
    expect(file!.crons[1].prompt).toBe('Run autoresearch loop...');
    expect(Date.parse(file!.updated_at)).not.toBeNaN();
  });

  it('round-trips an empty list', () => {
    writeCronList(tmpDir, []);
    const file = readCronList(tmpDir, ONE_HOUR_MS);
    expect(file).not.toBeNull();
    expect(file!.crons).toEqual([]);
  });
});

describe('readCronList', () => {
  it('returns null when file is missing', () => {
    expect(readCronList(tmpDir, ONE_HOUR_MS)).toBeNull();
  });

  it('returns null when JSON is malformed', () => {
    writeFileSync(join(tmpDir, 'cron-list.json'), '{ not valid', 'utf-8');
    expect(readCronList(tmpDir, ONE_HOUR_MS)).toBeNull();
  });

  it('returns null when crons field is missing', () => {
    writeFileSync(
      join(tmpDir, 'cron-list.json'),
      JSON.stringify({ updated_at: new Date().toISOString() }),
      'utf-8',
    );
    expect(readCronList(tmpDir, ONE_HOUR_MS)).toBeNull();
  });

  it('returns null when updated_at is unparseable', () => {
    writeFileSync(
      join(tmpDir, 'cron-list.json'),
      JSON.stringify({ updated_at: 'not-a-date', crons: [] }),
      'utf-8',
    );
    expect(readCronList(tmpDir, ONE_HOUR_MS)).toBeNull();
  });

  it('returns null when file is older than maxAgeMs', () => {
    const tenSecondsAgo = new Date(Date.now() - 10_000).toISOString();
    writeFileSync(
      join(tmpDir, 'cron-list.json'),
      JSON.stringify({ updated_at: tenSecondsAgo, crons: [] }),
      'utf-8',
    );
    expect(readCronList(tmpDir, 5_000)).toBeNull();
    expect(readCronList(tmpDir, 60_000)).not.toBeNull();
  });
});

describe('findMissingCrons', () => {
  const live: CronListEntry[] = [
    { name: 'heartbeat', prompt: 'Read HEARTBEAT.md...' },
    { name: 'autoresearch', prompt: 'Run autoresearch...' },
  ];

  it('returns empty when every config cron is in the live list (by name)', () => {
    const cfg = [
      { name: 'heartbeat', prompt: 'Read HEARTBEAT.md...' },
      { name: 'autoresearch', prompt: 'Run autoresearch...' },
    ];
    expect(findMissingCrons(cfg, live)).toEqual([]);
  });

  it('matches by prompt when the name has drifted', () => {
    const cfg = [
      { name: 'heartbeat-v2', prompt: 'Read HEARTBEAT.md...' },
    ];
    expect(findMissingCrons(cfg, live)).toEqual([]);
  });

  it('flags a config cron with no matching name or prompt', () => {
    const cfg = [
      { name: 'experiment-ecom-shipped', prompt: 'Run the experiment loop' },
    ];
    expect(findMissingCrons(cfg, live)).toEqual([
      { name: 'experiment-ecom-shipped', prompt: 'Run the experiment loop' },
    ]);
  });

  it('returns multiple missing entries when several are absent', () => {
    const cfg = [
      { name: 'heartbeat', prompt: 'Read HEARTBEAT.md...' },
      { name: 'experiment-a', prompt: 'A' },
      { name: 'experiment-b', prompt: 'B' },
    ];
    expect(findMissingCrons(cfg, live)).toEqual([
      { name: 'experiment-a', prompt: 'A' },
      { name: 'experiment-b', prompt: 'B' },
    ]);
  });

  it('skips disabled crons', () => {
    const cfg = [
      { name: 'old-experiment', prompt: 'old', type: 'disabled' },
    ];
    expect(findMissingCrons(cfg, live)).toEqual([]);
  });

  it('skips one-shot crons', () => {
    const cfg = [
      { name: 'one-shot', prompt: 'fire once', type: 'once' },
    ];
    expect(findMissingCrons(cfg, live)).toEqual([]);
  });

  it('skips entries with no prompt (malformed config)', () => {
    const cfg = [
      { name: 'malformed', prompt: '' },
    ];
    expect(findMissingCrons(cfg, live)).toEqual([]);
  });

  it('returns empty when both config and live are empty', () => {
    expect(findMissingCrons([], [])).toEqual([]);
  });
});
