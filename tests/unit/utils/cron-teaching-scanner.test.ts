import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  scanFile,
  scanAgentDir,
  listAgentFiles,
  groupMatchesByFile,
  SENTINEL_MARKER,
} from '../../../src/utils/cron-teaching-scanner';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'cron-teaching-scanner-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function write(rel: string, body: string): string {
  const fp = join(workDir, rel);
  mkdirSync(join(fp, '..'), { recursive: true });
  writeFileSync(fp, body, 'utf-8');
  return fp;
}

describe('scanFile — pattern detection', () => {
  it('flags a recommendation to use CronCreate', () => {
    const fp = write('a.md', 'Use CronCreate to register a heartbeat cron every 4 hours.\n');
    const r = scanFile(fp);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].pattern).toBe('CronCreate');
    expect(r.matches[0].line).toBe(1);
  });

  it('does NOT flag teaching-deprecation lines (do NOT use CronCreate)', () => {
    const body = [
      'Do NOT use `CronCreate` or `/loop` — those are session-only.',
      "Don't use CronCreate for persistent recurring work.",
      'Never use CronCreate for cron registration.',
    ].join('\n');
    const fp = write('teach.md', body);
    const r = scanFile(fp);
    expect(r.matches).toHaveLength(0);
  });

  it('does NOT flag the one-shot reminder fallback (recurring: false)', () => {
    const fp = write('one-shot.md',
      'For one-time reminders, fall back to the Claude Code built-in CronCreate with recurring: false.\n');
    const r = scanFile(fp);
    expect(r.matches).toHaveLength(0);
  });

  it('flags the cron-creation /loop form', () => {
    const fp = write('loop.md', 'Run `/loop 4h heartbeat` to start the heartbeat cron.\n');
    const r = scanFile(fp);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].pattern).toBe('/loop <interval> (cron creation form)');
  });

  it('flags "/loop create cron"', () => {
    const fp = write('loop2.md', 'Then call /loop create cron with the interval.\n');
    const r = scanFile(fp);
    expect(r.matches.some((m) => m.pattern === '/loop create cron')).toBe(true);
  });

  it('flags "(configured in config.json)"', () => {
    const fp = write('cfg.md', 'Heartbeat cron (configured in config.json) fires every 4h.\n');
    const r = scanFile(fp);
    expect(r.matches.some((m) => m.pattern === '(configured in config.json)')).toBe(true);
  });

  it('flags "edit config.json … cron" combined context', () => {
    const fp = write('combo.md',
      'To add a new cron, edit config.json and add an entry to the crons array.\n');
    const r = scanFile(fp);
    expect(r.matches.some((m) => m.pattern === 'edit config.json (cron context)')).toBe(true);
  });

  it('skips a whole file when the m2c1-worker sentinel marker is present', () => {
    const body = [
      `<!-- Note: ${SENTINEL_MARKER} for short-lived worker queue polls. -->`,
      'Use CronCreate to register a cron.',
      '/loop 10m poll-tasks',
    ].join('\n');
    const fp = write('skill.md', body);
    const r = scanFile(fp);
    expect(r.skippedSentinel).toBe(true);
    expect(r.matches).toHaveLength(0);
  });

  it('does not crash on missing file', () => {
    const r = scanFile(join(workDir, 'does-not-exist.md'));
    expect(r.matches).toHaveLength(0);
    expect(r.skippedSentinel).toBe(false);
  });
});

describe('scanFile — apply mode (literal substitutions)', () => {
  it('rewrites "(configured in config.json)" in place when apply=true', () => {
    const fp = write('cfg.md',
      'Heartbeat cron (configured in config.json) fires every 4h.\nReports cron (configured in config.json).\n');
    const r = scanFile(fp, { apply: true });
    expect(r.applied).toBe(2);
    const out = readFileSync(fp, 'utf-8');
    expect(out).not.toContain('(configured in config.json)');
    expect(out).toContain('(configured via cortextos bus add-cron)');
  });

  it('does not rewrite anything when apply=false (default)', () => {
    const original = 'Heartbeat (configured in config.json).\n';
    const fp = write('cfg.md', original);
    const r = scanFile(fp);
    expect(r.applied).toBe(0);
    expect(readFileSync(fp, 'utf-8')).toBe(original);
  });

  it('apply=true does not touch CronCreate references (those are not safe-rewritable)', () => {
    const original = 'Use CronCreate to register heartbeat.\n';
    const fp = write('a.md', original);
    const r = scanFile(fp, { apply: true });
    expect(r.applied).toBe(0);
    expect(readFileSync(fp, 'utf-8')).toBe(original);
    expect(r.matches).toHaveLength(1);
  });
});

describe('listAgentFiles', () => {
  it('returns CLAUDE.md / AGENTS.md / ONBOARDING.md when present', () => {
    write('CLAUDE.md', 'a\n');
    write('AGENTS.md', 'b\n');
    write('ONBOARDING.md', 'c\n');
    const files = listAgentFiles(workDir);
    expect(files.map((f) => f.split('/').pop())).toEqual(
      expect.arrayContaining(['CLAUDE.md', 'AGENTS.md', 'ONBOARDING.md']),
    );
  });

  it('walks .claude/skills/**/SKILL.md', () => {
    write('.claude/skills/cron-management/SKILL.md', 'cm\n');
    write('.claude/skills/agent-management/SKILL.md', 'am\n');
    write('.claude/skills/agent-management/notes.md', 'ignored\n'); // not SKILL.md
    const files = listAgentFiles(workDir);
    const basenames = files.map((f) => f.replace(workDir + '/', ''));
    expect(basenames).toContain('.claude/skills/cron-management/SKILL.md');
    expect(basenames).toContain('.claude/skills/agent-management/SKILL.md');
    expect(basenames).not.toContain('.claude/skills/agent-management/notes.md');
  });

  it('handles missing top files / missing skills dir', () => {
    const files = listAgentFiles(workDir);
    expect(files).toEqual([]);
  });
});

describe('scanAgentDir', () => {
  it('scans top files + skills, separates sentinel-skipped files', () => {
    write('CLAUDE.md', 'Use CronCreate to register heartbeat.\n');
    write('AGENTS.md', 'Heartbeat (configured in config.json).\n');
    write('.claude/skills/cron-management/SKILL.md',
      'Never use /loop or CronCreate for persistent recurring work.\n');
    write('.claude/skills/m2c1-worker/SKILL.md',
      `<!-- Note: ${SENTINEL_MARKER} for worker polls. -->\nUse CronCreate.\n`);

    const r = scanAgentDir(workDir);

    expect(r.scannedFiles).toHaveLength(3);
    expect(r.skippedSentinelFiles).toHaveLength(1);
    expect(r.skippedSentinelFiles[0]).toContain('m2c1-worker');

    // Two stale matches (CLAUDE.md + AGENTS.md). The cron-management
    // skill's sentence has "never use" which is teaching, not stale.
    expect(r.matches).toHaveLength(2);
    expect(r.matches.find((m) => m.file.endsWith('CLAUDE.md'))?.pattern).toBe('CronCreate');
    expect(r.matches.find((m) => m.file.endsWith('AGENTS.md'))?.pattern).toBe(
      '(configured in config.json)',
    );
  });

  it('apply=true rewrites only the safe substitutions', () => {
    write('AGENTS.md',
      'Heartbeat (configured in config.json).\nUse CronCreate to register.\n');
    const r = scanAgentDir(workDir, { apply: true });

    expect(r.appliedSubstitutions).toBe(1);
    const out = readFileSync(join(workDir, 'AGENTS.md'), 'utf-8');
    expect(out).toContain('(configured via cortextos bus add-cron)');
    // CronCreate line is still there (not safe to mechanically rewrite).
    expect(out).toContain('Use CronCreate to register.');

    // The CronCreate match is still reported even when --apply ran.
    expect(r.matches.some((m) => m.pattern === 'CronCreate')).toBe(true);
  });
});

describe('groupMatchesByFile', () => {
  it('groups matches by file', () => {
    const fpA = write('CLAUDE.md', 'Use CronCreate.\nAnd /loop 4h heartbeat.\n');
    const fpB = write('AGENTS.md', '(configured in config.json)\n');
    const r = scanAgentDir(workDir);
    const grouped = groupMatchesByFile(r.matches);
    expect(grouped.get(fpA)?.length).toBe(2);
    expect(grouped.get(fpB)?.length).toBe(1);
  });
});
