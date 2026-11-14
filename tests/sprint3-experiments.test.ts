import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createExperiment,
  runExperiment,
  evaluateExperiment,
  listExperiments,
  gatherContext,
  manageCycle,
  suggestBaselineFromSurface,
} from '../src/bus/experiment.js';

describe('Sprint 3: Experiment Framework', () => {
  const testDir = join(tmpdir(), `cortextos-sprint3-${Date.now()}`);

  beforeEach(() => {
    mkdirSync(join(testDir, 'experiments', 'history'), { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  describe('createExperiment', () => {
    it('generates valid ID and JSON', () => {
      const id = createExperiment(testDir, 'testbot', 'engagement_rate', 'Shorter posts get more likes');
      expect(id).toMatch(/^exp_\d+_[a-z0-9]{5}$/);

      const filePath = join(testDir, 'experiments', 'history', `${id}.json`);
      expect(existsSync(filePath)).toBe(true);

      const exp = JSON.parse(readFileSync(filePath, 'utf-8').trim());
      expect(exp.id).toBe(id);
      expect(exp.agent).toBe('testbot');
      expect(exp.metric).toBe('engagement_rate');
      expect(exp.hypothesis).toBe('Shorter posts get more likes');
      expect(exp.status).toBe('proposed');
      expect(exp.baseline_value).toBe(0);
      expect(exp.result_value).toBeNull();
      expect(exp.decision).toBeNull();
      expect(exp.direction).toBe('higher');
      expect(exp.window).toBe('24h');
      expect(exp.started_at).toBeNull();
      expect(exp.completed_at).toBeNull();
      expect(exp.changes_description).toBeNull();
    });

    it('accepts optional surface, direction, window', () => {
      const id = createExperiment(testDir, 'testbot', 'bounce_rate', 'Less text = lower bounce', {
        surface: 'experiments/surfaces/bounce/current.md',
        direction: 'lower',
        window: '48h',
      });

      const filePath = join(testDir, 'experiments', 'history', `${id}.json`);
      const exp = JSON.parse(readFileSync(filePath, 'utf-8').trim());
      expect(exp.surface).toBe('experiments/surfaces/bounce/current.md');
      expect(exp.direction).toBe('lower');
      expect(exp.window).toBe('48h');
    });

    it('inherits measurement/direction/window/surface from a matching cycle in config.json', () => {
      // Write an experiments/config.json with a cycle for this metric.
      mkdirSync(join(testDir, 'experiments'), { recursive: true });
      writeFileSync(
        join(testDir, 'experiments', 'config.json'),
        JSON.stringify({
          cycles: [
            {
              name: 'retention-cycle',
              agent: 'testbot',
              metric: 'retention',
              metric_type: 'quantitative',
              surface: 'experiments/surfaces/retention/current.md',
              direction: 'higher',
              window: '7d',
              measurement: 'count(distinct users_returning_in_7d) / count(distinct signups)',
              loop_interval: '7d',
              enabled: true,
              created_by: 'testbot',
              created_at: '2026-04-01T00:00:00Z',
            },
          ],
        }),
      );

      const id = createExperiment(testDir, 'testbot', 'retention', 'Better onboarding improves retention');

      const exp = JSON.parse(
        readFileSync(join(testDir, 'experiments', 'history', `${id}.json`), 'utf-8').trim(),
      );
      expect(exp.measurement).toBe('count(distinct users_returning_in_7d) / count(distinct signups)');
      expect(exp.surface).toBe('experiments/surfaces/retention/current.md');
      expect(exp.window).toBe('7d');
      expect(exp.direction).toBe('higher');
    });

    it('explicit options win over matching-cycle defaults', () => {
      mkdirSync(join(testDir, 'experiments'), { recursive: true });
      writeFileSync(
        join(testDir, 'experiments', 'config.json'),
        JSON.stringify({
          cycles: [
            {
              name: 'ctr-cycle',
              agent: 'testbot',
              metric: 'ctr',
              direction: 'higher',
              window: '24h',
              measurement: 'clicks / impressions',
              surface: 'default-surface.md',
              enabled: true,
              created_by: 'testbot',
              created_at: '2026-04-01T00:00:00Z',
              metric_type: 'quantitative',
              loop_interval: '24h',
            },
          ],
        }),
      );

      const id = createExperiment(testDir, 'testbot', 'ctr', 'test', {
        direction: 'lower',
        measurement: 'custom-override',
      });
      const exp = JSON.parse(
        readFileSync(join(testDir, 'experiments', 'history', `${id}.json`), 'utf-8').trim(),
      );
      expect(exp.direction).toBe('lower'); // overrode cycle
      expect(exp.measurement).toBe('custom-override'); // overrode cycle
      expect(exp.window).toBe('24h'); // inherited from cycle
      expect(exp.surface).toBe('default-surface.md'); // inherited from cycle
    });

    it('falls through to static defaults when no matching cycle exists', () => {
      mkdirSync(join(testDir, 'experiments'), { recursive: true });
      writeFileSync(
        join(testDir, 'experiments', 'config.json'),
        JSON.stringify({
          cycles: [
            {
              name: 'other-metric-cycle',
              agent: 'testbot',
              metric: 'different_metric',
              direction: 'higher',
              window: '7d',
              measurement: 'irrelevant',
              surface: '',
              enabled: true,
              created_by: 'testbot',
              created_at: '2026-04-01T00:00:00Z',
              metric_type: 'quantitative',
              loop_interval: '7d',
            },
          ],
        }),
      );

      const id = createExperiment(testDir, 'testbot', 'unrelated_metric', 'test');
      const exp = JSON.parse(
        readFileSync(join(testDir, 'experiments', 'history', `${id}.json`), 'utf-8').trim(),
      );
      expect(exp.measurement).toBe('');
      expect(exp.direction).toBe('higher'); // static default
      expect(exp.window).toBe('24h'); // static default
    });
  });

  describe('runExperiment', () => {
    it('transitions proposed -> running', () => {
      const id = createExperiment(testDir, 'testbot', 'ctr', 'Bold CTA improves CTR');
      const result = runExperiment(testDir, id, 'Changed button color to red');

      expect(result.status).toBe('running');
      expect(result.started_at).toBeTruthy();
      expect(result.changes_description).toBe('Changed button color to red');

      // active.json should exist
      const activePath = join(testDir, 'experiments', 'active.json');
      expect(existsSync(activePath)).toBe(true);
      const active = JSON.parse(readFileSync(activePath, 'utf-8').trim());
      expect(active.id).toBe(id);
      expect(active.status).toBe('running');
    });

    it('throws if experiment is not proposed', () => {
      const id = createExperiment(testDir, 'testbot', 'ctr', 'test');
      runExperiment(testDir, id);
      expect(() => runExperiment(testDir, id)).toThrow("expected 'proposed'");
    });
  });

  describe('evaluateExperiment', () => {
    it('keeps when higher is better and measured > baseline', () => {
      const id = createExperiment(testDir, 'testbot', 'engagement', 'More emojis', {
        direction: 'higher',
      });
      runExperiment(testDir, id);
      const result = evaluateExperiment(testDir, id, 42, { learning: 'Emojis work' });

      expect(result.status).toBe('completed');
      expect(result.decision).toBe('keep');
      expect(result.result_value).toBe(42);
      expect(result.baseline_value).toBe(42); // updated to measured
      expect(result.completed_at).toBeTruthy();
      expect(result.learning).toBe('Emojis work');

      // active.json should be removed
      const activePath = join(testDir, 'experiments', 'active.json');
      expect(existsSync(activePath)).toBe(false);

      // results.tsv should exist with data
      const tsvPath = join(testDir, 'experiments', 'results.tsv');
      expect(existsSync(tsvPath)).toBe(true);
      const tsvContent = readFileSync(tsvPath, 'utf-8');
      expect(tsvContent).toContain('experiment_id\tagent');
      expect(tsvContent).toContain(id);

      // learnings.md should exist with entry
      const learningsPath = join(testDir, 'experiments', 'learnings.md');
      expect(existsSync(learningsPath)).toBe(true);
      const learnings = readFileSync(learningsPath, 'utf-8');
      expect(learnings).toContain(id);
      expect(learnings).toContain('Emojis work');
    });

    it('discards when measured < baseline (direction=higher)', () => {
      const id = createExperiment(testDir, 'testbot', 'engagement', 'Remove images');
      // Manually set a higher baseline by creating, running, evaluating once
      // then creating a new experiment
      runExperiment(testDir, id);

      // Measured 0 vs baseline 0 should discard (not strictly greater)
      const result = evaluateExperiment(testDir, id, 0);
      expect(result.decision).toBe('discard');
      expect(result.baseline_value).toBe(0); // NOT updated
    });

    it('keeps when lower is better and measured < baseline', () => {
      const id = createExperiment(testDir, 'testbot', 'bounce_rate', 'Simplify nav', {
        direction: 'lower',
      });
      runExperiment(testDir, id);
      // baseline is 0, measured -5 is lower -> keep
      const result = evaluateExperiment(testDir, id, -5);
      expect(result.decision).toBe('keep');
    });

    it('throws if experiment is not running', () => {
      const id = createExperiment(testDir, 'testbot', 'ctr', 'test');
      expect(() => evaluateExperiment(testDir, id, 10)).toThrow("expected 'running'");
    });
  });

  describe('G1 zero-delta gate', () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    // Create + run + evaluate a flat (non-improving) window on a surface.
    // direction=higher, baseline starts at 0, so value<=0 → discard.
    function flat(surface: string, value = 0): ReturnType<typeof evaluateExperiment> {
      const id = createExperiment(testDir, 'testbot', 'engagement', 'flat hypothesis', {
        surface,
        direction: 'higher',
      });
      runExperiment(testDir, id);
      return evaluateExperiment(testDir, id, value);
    }

    it('flags the 3rd consecutive flat window on the same surface', () => {
      const s = 'surfaces/g1.md';

      const r1 = flat(s);
      expect(r1.decision).toBe('discard');
      expect(r1.guardrail_note ?? null).toBeNull();

      const r2 = flat(s);
      expect(r2.guardrail_note ?? null).toBeNull();

      const r3 = flat(s);
      expect(r3.decision).toBe('discard');
      expect(r3.guardrail_note).toBeTruthy();
      expect(r3.guardrail_note).toContain(s);

      // Note is persisted to learnings.md (tamper-proof record)
      const learnings = readFileSync(join(testDir, 'experiments', 'learnings.md'), 'utf-8');
      expect(learnings).toContain('zero-delta gate');
    });

    it('does not accumulate flats spread across different surfaces', () => {
      flat('surfaces/a.md');
      flat('surfaces/b.md');
      const r3 = flat('surfaces/c.md');
      expect(r3.guardrail_note ?? null).toBeNull();
    });

    it('a keep resets the flat streak (does not chain)', async () => {
      const s = 'surfaces/reset.md';
      flat(s); // discard 1
      flat(s); // discard 2

      // A genuine improvement (keep) must break the streak. Space completions
      // apart by >1s so the truncated-to-seconds completed_at ordering is
      // unambiguous (the keep sorts newest before the following flat).
      await sleep(1100);
      const k = createExperiment(testDir, 'testbot', 'engagement', 'real improvement', {
        surface: s,
        direction: 'higher',
      });
      runExperiment(testDir, k);
      const rk = evaluateExperiment(testDir, k, 5); // 5 > baseline 0 → keep
      expect(rk.decision).toBe('keep');
      expect(rk.guardrail_note ?? null).toBeNull();

      await sleep(1100);
      const r = flat(s, 0); // baseline now 5, value 0 → discard, but streak reset
      expect(r.decision).toBe('discard');
      expect(r.guardrail_note ?? null).toBeNull();
    });
  });

  describe('G3 baseline drift', () => {
    it('createExperiment honours an explicit baseline', () => {
      const id = createExperiment(testDir, 'testbot', 'quality', 'h', {
        surface: 'surfaces/g3.md',
        baseline: 7,
      });
      const exp = JSON.parse(
        readFileSync(join(testDir, 'experiments', 'history', `${id}.json`), 'utf-8').trim(),
      );
      expect(exp.baseline_value).toBe(7);
    });

    it('suggestBaselineFromSurface returns median of recent results (null when none)', () => {
      const s = 'surfaces/g3-suggest.md';
      expect(suggestBaselineFromSurface(testDir, s)).toBeNull();

      // Produce completed results 4, 6, 8 on the surface (baseline 0, higher).
      for (const v of [4, 6, 8]) {
        const id = createExperiment(testDir, 'testbot', 'quality', 'h', {
          surface: s,
          direction: 'higher',
        });
        runExperiment(testDir, id);
        evaluateExperiment(testDir, id, v);
      }
      // Median of [4,6,8] = 6.
      expect(suggestBaselineFromSurface(testDir, s)).toBe(6);
    });

    it('warns when results cluster within ±1 of baseline for 5+ windows', () => {
      const s = 'surfaces/g3-drift.md';
      // Fixed baseline 7 via explicit baseline; direction lower so results at
      // 7 (== baseline) discard without moving the baseline, keeping it pegged.
      let last: ReturnType<typeof evaluateExperiment> | null = null;
      for (let i = 0; i < 5; i++) {
        const id = createExperiment(testDir, 'testbot', 'quality', 'h', {
          surface: s,
          direction: 'lower',
          baseline: 7,
        });
        runExperiment(testDir, id);
        last = evaluateExperiment(testDir, id, 7); // |7-7|=0 ≤ 1, discard, baseline stays 7
      }
      expect(last!.drift_note).toBeTruthy();
      expect(last!.drift_note).toContain('drift');
    });

    it('does not warn before 5 clustered windows', () => {
      const s = 'surfaces/g3-nodrift.md';
      let last: ReturnType<typeof evaluateExperiment> | null = null;
      for (let i = 0; i < 4; i++) {
        const id = createExperiment(testDir, 'testbot', 'quality', 'h', {
          surface: s,
          direction: 'lower',
          baseline: 7,
        });
        runExperiment(testDir, id);
        last = evaluateExperiment(testDir, id, 7);
      }
      expect(last!.drift_note ?? null).toBeNull();
    });

    it('a result outside ±1 breaks the drift run', () => {
      const s = 'surfaces/g3-break.md';
      const mk = (v: number) => {
        const id = createExperiment(testDir, 'testbot', 'quality', 'h', {
          surface: s,
          direction: 'lower',
          baseline: 7,
        });
        runExperiment(testDir, id);
        return evaluateExperiment(testDir, id, v);
      };
      mk(7);
      mk(7);
      mk(20); // far from baseline → breaks the run
      mk(7);
      const last = mk(7); // only 2 clustered since the break → no warn
      expect(last.drift_note ?? null).toBeNull();
    });
  });

  describe('listExperiments', () => {
    it('returns all experiments sorted by created_at desc', () => {
      createExperiment(testDir, 'bot1', 'metric_a', 'hyp1');
      createExperiment(testDir, 'bot2', 'metric_b', 'hyp2');
      const list = listExperiments(testDir);
      expect(list).toHaveLength(2);
      // Most recent first
      expect(new Date(list[0].created_at).getTime()).toBeGreaterThanOrEqual(
        new Date(list[1].created_at).getTime(),
      );
    });

    it('filters by status', () => {
      const id1 = createExperiment(testDir, 'bot1', 'ctr', 'h1');
      createExperiment(testDir, 'bot1', 'ctr', 'h2');
      runExperiment(testDir, id1);

      const running = listExperiments(testDir, { status: 'running' });
      expect(running).toHaveLength(1);
      expect(running[0].id).toBe(id1);

      const proposed = listExperiments(testDir, { status: 'proposed' });
      expect(proposed).toHaveLength(1);
    });

    it('filters by metric', () => {
      createExperiment(testDir, 'bot1', 'ctr', 'h1');
      createExperiment(testDir, 'bot1', 'engagement', 'h2');

      const ctrOnly = listExperiments(testDir, { metric: 'ctr' });
      expect(ctrOnly).toHaveLength(1);
      expect(ctrOnly[0].metric).toBe('ctr');
    });

    it('filters by agent', () => {
      createExperiment(testDir, 'alpha', 'ctr', 'h1');
      createExperiment(testDir, 'beta', 'ctr', 'h2');

      const alphaOnly = listExperiments(testDir, { agent: 'alpha' });
      expect(alphaOnly).toHaveLength(1);
      expect(alphaOnly[0].agent).toBe('alpha');
    });

    it('returns empty array when no experiments exist', () => {
      const emptyDir = join(testDir, 'empty-agent');
      mkdirSync(emptyDir, { recursive: true });
      const list = listExperiments(emptyDir);
      expect(list).toEqual([]);
    });
  });

  describe('gatherContext', () => {
    it('calculates keep rate from completed experiments', () => {
      // Create 3 experiments: 2 keep, 1 discard
      const id1 = createExperiment(testDir, 'testbot', 'engagement', 'h1');
      runExperiment(testDir, id1);
      evaluateExperiment(testDir, id1, 10); // keep (10 > 0)

      const id2 = createExperiment(testDir, 'testbot', 'engagement', 'h2');
      runExperiment(testDir, id2);
      evaluateExperiment(testDir, id2, 5); // keep (5 > 0)

      const id3 = createExperiment(testDir, 'testbot', 'engagement', 'h3');
      runExperiment(testDir, id3);
      evaluateExperiment(testDir, id3, 0); // discard (0 not > 0)

      const ctx = gatherContext(testDir, 'testbot');
      expect(ctx.agent).toBe('testbot');
      expect(ctx.total_experiments).toBe(3);
      expect(ctx.keeps).toBe(2);
      expect(ctx.discards).toBe(1);
      expect(ctx.keep_rate).toBeCloseTo(2 / 3);
      expect(ctx.learnings).toContain('Experiment Learnings');
      expect(ctx.results_tsv).toContain('experiment_id');
    });

    it('reads IDENTITY.md and GOALS.md if present', () => {
      const { writeFileSync } = require('fs');
      writeFileSync(join(testDir, 'IDENTITY.md'), '# Test Agent\nI am a test agent.\n');
      writeFileSync(join(testDir, 'GOALS.md'), '# Goals\n- Be awesome\n');

      const ctx = gatherContext(testDir, 'testbot');
      expect(ctx.identity).toContain('Test Agent');
      expect(ctx.goals).toContain('Be awesome');
    });

    it('returns empty strings when no experiments exist', () => {
      const emptyDir = join(testDir, 'empty');
      mkdirSync(emptyDir, { recursive: true });
      const ctx = gatherContext(emptyDir, 'testbot');
      expect(ctx.total_experiments).toBe(0);
      expect(ctx.keeps).toBe(0);
      expect(ctx.discards).toBe(0);
      expect(ctx.keep_rate).toBe(0);
      expect(ctx.learnings).toBe('');
      expect(ctx.results_tsv).toBe('');
    });
  });

  describe('manageCycle', () => {
    it('creates a cycle', () => {
      const cycles = manageCycle(testDir, 'create', {
        name: 'daily-engagement',
        agent: 'testbot',
        metric: 'engagement_rate',
        surface: 'surfaces/engagement.md',
        direction: 'higher',
        window: '24h',
      });

      expect(cycles).toHaveLength(1);
      expect(cycles[0].name).toBe('daily-engagement');
      expect(cycles[0].metric).toBe('engagement_rate');

      // Verify config.json was written
      const configPath = join(testDir, 'experiments', 'config.json');
      expect(existsSync(configPath)).toBe(true);
    });

    it('modifies an existing cycle', () => {
      manageCycle(testDir, 'create', {
        name: 'weekly',
        agent: 'testbot',
        metric: 'ctr',
      });

      const cycles = manageCycle(testDir, 'modify', {
        name: 'weekly',
        metric: 'bounce_rate',
        direction: 'lower',
      });

      expect(cycles).toHaveLength(1);
      expect(cycles[0].metric).toBe('bounce_rate');
      expect(cycles[0].direction).toBe('lower');
    });

    it('removes a cycle', () => {
      manageCycle(testDir, 'create', {
        name: 'to-remove',
        agent: 'testbot',
        metric: 'ctr',
      });

      const cycles = manageCycle(testDir, 'remove', { name: 'to-remove' });
      expect(cycles).toHaveLength(0);
    });

    it('lists cycles', () => {
      manageCycle(testDir, 'create', { name: 'c1', agent: 'a', metric: 'm1' });
      manageCycle(testDir, 'create', { name: 'c2', agent: 'b', metric: 'm2' });

      const cycles = manageCycle(testDir, 'list', {});
      expect(cycles).toHaveLength(2);
    });

    it("list with agent filter returns only that agent's cycles", () => {
      manageCycle(testDir, 'create', { name: 'c1', agent: 'alice', metric: 'm1' });
      manageCycle(testDir, 'create', { name: 'c2', agent: 'alice', metric: 'm2' });
      manageCycle(testDir, 'create', { name: 'c3', agent: 'widgetbot', metric: 'm3' });

      const aliceCycles = manageCycle(testDir, 'list', { agent: 'alice' });
      expect(aliceCycles.map((c) => c.name).sort()).toEqual(['c1', 'c2']);

      const widgetCycles = manageCycle(testDir, 'list', { agent: 'widgetbot' });
      expect(widgetCycles.map((c) => c.name)).toEqual(['c3']);

      // No filter still returns all (back-compat)
      const all = manageCycle(testDir, 'list', {});
      expect(all).toHaveLength(3);
    });

    it('throws when modifying non-existent cycle', () => {
      expect(() => manageCycle(testDir, 'modify', { name: 'ghost' })).toThrow('not found');
    });

    it('throws when removing non-existent cycle', () => {
      expect(() => manageCycle(testDir, 'remove', { name: 'ghost' })).toThrow('not found');
    });

    it('throws when creating without required fields', () => {
      expect(() => manageCycle(testDir, 'create', { name: 'x' })).toThrow('requires');
    });
  });
});
