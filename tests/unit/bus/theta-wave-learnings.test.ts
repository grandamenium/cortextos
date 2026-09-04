import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createExperiment,
  runExperiment,
  evaluateExperiment,
  formatThetaWaveLearningEntry,
  parseThetaWaveNumber,
} from '../../../src/bus/experiment';

const THETA_METRIC = 'system_effectiveness';

function thetaWavePath(agentDir: string): string {
  return join(agentDir, '.claude', 'skills', 'theta-wave', 'learnings.md');
}

/** Create + run a fresh experiment; returns its id. baseline is 0, so a positive value keeps. */
function mkExp(agentDir: string, metric: string, hypothesis: string): string {
  const id = createExperiment(agentDir, 'testbot', metric, hypothesis, { direction: 'higher' });
  runExperiment(agentDir, id);
  return id;
}

describe('theta-wave learnings.md auto-write', () => {
  let dir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cortextos-tw-'));
    mkdirSync(join(dir, 'experiments', 'history'), { recursive: true });
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  // 1. Trigger fires on metric + hypothesis match.
  it('writes a ## TW<N> entry for a system_effectiveness + TW<N>: cycle', () => {
    const id = mkExp(dir, THETA_METRIC, 'TW42: something changed');
    evaluateExperiment(dir, id, 7, { learning: 'it worked' });

    const p = thetaWavePath(dir);
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, 'utf-8')).toContain('## TW42');
    // Positive control: remove the writeThetaWaveLearning call site -> file absent -> fails.
  });

  // 2. Negative control — other metric does NOT fire.
  it('does NOT write for a non-system_effectiveness metric even with a TW<N>: hypothesis', () => {
    const id = mkExp(dir, 'engagement', 'TW42: x');
    evaluateExperiment(dir, id, 7, { learning: 'noop' });

    expect(existsSync(thetaWavePath(dir))).toBe(false);
    // Positive control: drop the metric check (unconditional) -> file appears -> fails.
  });

  // 3. Negative control — non-TW hypothesis does NOT fire.
  it('does NOT write for a system_effectiveness cycle whose hypothesis lacks a TW<N>: prefix', () => {
    const id = mkExp(dir, THETA_METRIC, 'Improve things generally');
    evaluateExperiment(dir, id, 7, { learning: 'noop' });

    expect(existsSync(thetaWavePath(dir))).toBe(false);
    // Positive control: drop the hypothesis (parseThetaWaveNumber null) check -> throws/writes -> fails.
  });

  // R1. Loud warning on system_effectiveness + missing prefix; silent for other metrics.
  it('warns loudly when system_effectiveness has no TW<N>: prefix, and stays silent otherwise', () => {
    const sysId = mkExp(dir, THETA_METRIC, 'no prefix here');
    evaluateExperiment(dir, sysId, 7);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('TW<N>');

    warnSpy.mockClear();

    const otherId = mkExp(dir, 'engagement', 'no prefix here either');
    evaluateExperiment(dir, otherId, 7);
    expect(warnSpy).not.toHaveBeenCalled();
    // Positive control: remove the console.warn in the no-prefix branch -> first assertion fails.
  });

  // 4. Exact live format (pure formatter).
  it('formats the entry block byte-for-byte (File B live format)', () => {
    const out = formatThetaWaveLearningEntry({
      n: 42,
      date: 'Aug 24, 2026',
      score: '7',
      decision: 'keep',
      hypothesis: 'TW42: do a thing',
      learning: 'it worked',
    });
    expect(out).toBe(
      '## TW42 — Aug 24, 2026\n\n**Score: 7/10** — KEEP\n\nTW42: do a thing\n\nit worked\n',
    );
    // Positive control: any glyph/spacing change in the formatter -> fails.
  });

  // 5. Empty-learning line.
  it('writes the empty-field body line when no learning is recorded', () => {
    const id = mkExp(dir, THETA_METRIC, 'TW50: empty learning cycle');
    evaluateExperiment(dir, id, 7); // no learning option

    const content = readFileSync(thetaWavePath(dir), 'utf-8');
    expect(content).toContain('No learning field was recorded for this cycle');
    // The body is not blank: the hypothesis line is followed by the literal fallback.
    expect(content).toMatch(/TW50: empty learning cycle\n\nNo learning field was recorded for this cycle/);
    // Positive control: emit '' for empty learning -> assertion fails.
  });

  // 6. Dedupe — existing heading not duplicated.
  it('does not duplicate an existing ## TW<N> heading', () => {
    const p = thetaWavePath(dir);
    mkdirSync(join(dir, '.claude', 'skills', 'theta-wave'), { recursive: true });
    writeFileSync(p, '# Theta Wave Learnings\n\n## TW42 — Aug 1, 2026\n\nmanual pre-seeded entry\n');

    const id = mkExp(dir, THETA_METRIC, 'TW42: retry of the same cycle');
    evaluateExperiment(dir, id, 7, { learning: 'second pass' });

    const content = readFileSync(p, 'utf-8');
    expect((content.match(/^## TW42(?![0-9])/gm) || []).length).toBe(1);
    expect(content).toContain('manual pre-seeded entry');
    // Positive control: remove the dedupe guard -> count 2 -> fails.
  });

  // 7. Dedupe boundary — TW11 vs TW113.
  it('treats TW11 and TW113 as distinct headings', () => {
    const p = thetaWavePath(dir);
    mkdirSync(join(dir, '.claude', 'skills', 'theta-wave'), { recursive: true });
    writeFileSync(p, '# Theta Wave Learnings\n\n## TW113 — Aug 23, 2026\n\nexisting TW113 entry\n');

    const id = mkExp(dir, THETA_METRIC, 'TW11: eleven cycle');
    evaluateExperiment(dir, id, 7, { learning: 'eleven' });

    const content = readFileSync(p, 'utf-8');
    expect(content).toMatch(/^## TW11(?![0-9])/m);
    expect(content).toContain('## TW113');
    // Positive control: drop the (?![0-9]) lookahead -> TW11 deduped against TW113 -> missing -> fails.
  });

  // 8. Path resolution relative to agentDir.
  it('writes to <agentDir>/.claude/skills/theta-wave/learnings.md, not <agentDir>/learnings.md', () => {
    const id = mkExp(dir, THETA_METRIC, 'TW60: path check');
    evaluateExperiment(dir, id, 7, { learning: 'path' });

    expect(existsSync(thetaWavePath(dir))).toBe(true);
    expect(existsSync(join(dir, 'learnings.md'))).toBe(false); // File A must not receive it
    // Positive control: hardcode any other path -> thetaWavePath absent -> fails.
  });

  // 9. Dir auto-create.
  it('auto-creates the theta-wave dir + file when absent', () => {
    expect(existsSync(join(dir, '.claude'))).toBe(false);
    const id = mkExp(dir, THETA_METRIC, 'TW70: dir autocreate');
    evaluateExperiment(dir, id, 7, { learning: 'created' });

    const p = thetaWavePath(dir);
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, 'utf-8')).toContain('## TW70');
    // Positive control: guard on dir existence and skip -> file absent -> fails.
  });

  // Regression guard — File C (experiments/learnings.md) + results.tsv still written for a TW cycle.
  it('still writes the generic experiments/learnings.md and results.tsv for a TW cycle', () => {
    const id = mkExp(dir, THETA_METRIC, 'TW80: regression guard');
    evaluateExperiment(dir, id, 7, { learning: 'both paths' });

    const fileC = readFileSync(join(dir, 'experiments', 'learnings.md'), 'utf-8');
    expect(fileC).toContain(id); // generic per-experiment entry
    const tsv = readFileSync(join(dir, 'experiments', 'results.tsv'), 'utf-8');
    expect(tsv).toContain(id);
  });

  it('parseThetaWaveNumber extracts N only from a leading TW<N>: prefix', () => {
    expect(parseThetaWaveNumber('TW113: hello')).toBe(113);
    expect(parseThetaWaveNumber('Improve things')).toBeNull();
    expect(parseThetaWaveNumber('prefixed TW5: not at start')).toBeNull();
  });

  // 10. Fail-loud backstop throws and persists nothing when the post-write heading is absent.
  it('throws and leaves the experiment running when the backstop finds no heading', async () => {
    const isolated = mkdtempSync(join(tmpdir(), 'cortextos-tw-mock-'));
    mkdirSync(join(isolated, 'experiments', 'history'), { recursive: true });

    vi.resetModules();
    const realFs = await vi.importActual<typeof import('fs')>('fs');
    const learningsMarker = join('theta-wave', 'learnings.md');
    vi.doMock('fs', () => ({
      ...realFs,
      // Force every read of the theta-wave learnings file to lack the heading,
      // so the post-write verify backstop fails. All other reads pass through.
      readFileSync: (pth: unknown, ...rest: unknown[]) =>
        typeof pth === 'string' && pth.includes(learningsMarker)
          ? '# Theta Wave Learnings\n\n'
          : (realFs.readFileSync as (...a: unknown[]) => unknown)(pth, ...rest),
    }));

    const mod = await import('../../../src/bus/experiment');
    const id = mod.createExperiment(isolated, 'testbot', THETA_METRIC, 'TW99: backstop', {
      direction: 'higher',
    });
    mod.runExperiment(isolated, id);

    expect(() => mod.evaluateExperiment(isolated, id, 7, { learning: 'x' })).toThrow(
      "did not produce a '## TW99' heading",
    );

    // Nothing persisted as completed: status stays 'running' (write is before saveExperiment).
    const saved = JSON.parse(
      realFs.readFileSync(join(isolated, 'experiments', 'history', `${id}.json`), 'utf-8').toString(),
    );
    expect(saved.status).toBe('running');

    vi.doUnmock('fs');
    vi.resetModules();
    try {
      rmSync(isolated, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    // Positive control: remove the throw in the verify backstop -> no throw -> fails.
  });
});
