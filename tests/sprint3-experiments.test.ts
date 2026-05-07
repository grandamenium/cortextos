import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

  describe('measurement window', () => {
    it('runExperiment populates measurement_start (= started_at) and measurement_end (= start + window)', () => {
      const id = createExperiment(testDir, 'testbot', 'ctr', 'test', { window: '72h' });
      const before = Date.now();
      const exp = runExperiment(testDir, id);
      const after = Date.now();

      expect(exp.measurement_start).toBe(exp.started_at);
      expect(exp.measurement_end).toBeTruthy();

      const startMs = new Date(exp.measurement_start as string).getTime();
      const endMs = new Date(exp.measurement_end as string).getTime();
      const windowMs = 72 * 60 * 60 * 1000;

      // nowISO() truncates milliseconds, so the recorded start can fall up
      // to ~1s before the wall clock we sampled at the call site.
      expect(startMs).toBeGreaterThanOrEqual(before - 1000);
      expect(startMs).toBeLessThanOrEqual(after);
      // end - start should equal the window within a small tolerance for
      // the millisecond truncation in nowISO()
      expect(endMs - startMs).toBeGreaterThanOrEqual(windowMs - 1000);
      expect(endMs - startMs).toBeLessThanOrEqual(windowMs + 1000);
    });

    it.each([
      ['30s', 30 * 1000],
      ['15m', 15 * 60 * 1000],
      ['24h', 24 * 60 * 60 * 1000],
      ['7d', 7 * 24 * 60 * 60 * 1000],
      ['2w', 14 * 24 * 60 * 60 * 1000],
      ['2 hours', 2 * 60 * 60 * 1000],
    ])('parses window "%s" into the right offset', (window, expectedMs) => {
      const id = createExperiment(testDir, 'testbot', 'ctr', 'test', { window });
      const exp = runExperiment(testDir, id);
      const startMs = new Date(exp.measurement_start as string).getTime();
      const endMs = new Date(exp.measurement_end as string).getTime();
      expect(endMs - startMs).toBeGreaterThanOrEqual(expectedMs - 1000);
      expect(endMs - startMs).toBeLessThanOrEqual(expectedMs + 1000);
    });

    it('leaves measurement_end null and warns when window is unparseable', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const id = createExperiment(testDir, 'testbot', 'ctr', 'test', { window: 'forever' });
      const exp = runExperiment(testDir, id);
      expect(exp.measurement_start).toBeTruthy();
      expect(exp.measurement_end).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Could not parse window "forever"'),
      );
      warnSpy.mockRestore();
    });

    it('evaluateExperiment soft-warns (does not throw) when called before measurement_end', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const id = createExperiment(testDir, 'testbot', 'ctr', 'test', { window: '24h' });
      runExperiment(testDir, id);
      const result = evaluateExperiment(testDir, id, 10);
      expect(result.status).toBe('completed');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('before measurement_end'),
      );
      warnSpy.mockRestore();
    });

    it('evaluateExperiment does not warn when measurement_end is in the past', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const id = createExperiment(testDir, 'testbot', 'ctr', 'test', { window: '1s' });
      runExperiment(testDir, id);
      // Sleep just past the 1s window so measurement_end is in the past.
      const filePath = join(testDir, 'experiments', 'history', `${id}.json`);
      const exp = JSON.parse(readFileSync(filePath, 'utf-8'));
      const past = new Date(Date.now() - 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      exp.measurement_end = past;
      writeFileSync(filePath, JSON.stringify(exp, null, 2));
      warnSpy.mockClear();

      evaluateExperiment(testDir, id, 10);
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('before measurement_end'),
      );
      warnSpy.mockRestore();
    });

    it('evaluateExperiment does not warn when measurement_end is missing (legacy experiment)', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // Hand-craft a legacy experiment file without the new fields.
      const id = 'exp_legacy_99999';
      const filePath = join(testDir, 'experiments', 'history', `${id}.json`);
      mkdirSync(join(testDir, 'experiments', 'history'), { recursive: true });
      writeFileSync(filePath, JSON.stringify({
        id,
        agent: 'testbot',
        metric: 'ctr',
        hypothesis: 'legacy',
        surface: '',
        direction: 'higher',
        window: '24h',
        measurement: '',
        status: 'running',
        baseline_value: 0,
        result_value: null,
        decision: null,
        learning: '',
        experiment_commit: null,
        tracking_commit: null,
        created_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        completed_at: null,
        changes_description: null,
        // measurement_start / measurement_end intentionally omitted
      }, null, 2));
      warnSpy.mockClear();

      const result = evaluateExperiment(testDir, id, 10);
      expect(result.status).toBe('completed');
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('before measurement_end'),
      );
      warnSpy.mockRestore();
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
