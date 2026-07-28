import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goals-data-test-'));
process.env.CTX_ROOT = tmpDir;
process.env.CTX_FRAMEWORK_ROOT = tmpDir;

const ORG = 'acme';
const goalsPath = path.join(tmpDir, 'orgs', ORG, 'goals.json');

let getGoals: typeof import('../goals')['getGoals'];
let writeGoals: typeof import('../goals')['writeGoals'];

beforeAll(async () => {
  const mod = await import('../goals');
  getGoals = mod.getGoals;
  writeGoals = mod.writeGoals;
});

/**
 * Seed goals.json with the shape the CLI/agents actually write: the four fields
 * the dashboard models, plus `north_star` and `updated_at`, which it does not.
 */
function seed(): void {
  fs.mkdirSync(path.dirname(goalsPath), { recursive: true });
  fs.writeFileSync(
    goalsPath,
    JSON.stringify(
      {
        north_star: 'Ship the thing',
        bottleneck: 'old bottleneck',
        goals: [{ id: 'g1', title: 'First goal', progress: 25, order: 0 }],
        daily_focus: 'focus text',
        daily_focus_set_at: '2026-07-28T00:00:00Z',
        updated_at: '2026-07-28T00:00:00Z',
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );
}

function readRaw(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(goalsPath, 'utf-8'));
}

beforeEach(seed);

describe('goals read-modify-write round-trip', () => {
  it('preserves fields the dashboard does not model', () => {
    const data = getGoals(ORG);
    data.bottleneck = 'new bottleneck';
    writeGoals(ORG, data);

    const onDisk = readRaw();
    // The modelled field is updated...
    expect(onDisk.bottleneck).toBe('new bottleneck');
    // ...and the unmodelled ones survive rather than being silently dropped.
    expect(onDisk.north_star).toBe('Ship the thing');
    expect(onDisk.updated_at).toBe('2026-07-28T00:00:00Z');
  });

  it('preserves keys it has never heard of', () => {
    const seeded = readRaw();
    seeded.some_future_field = { nested: true };
    fs.writeFileSync(goalsPath, JSON.stringify(seeded, null, 2) + '\n', 'utf-8');

    const data = getGoals(ORG);
    data.bottleneck = 'changed';
    writeGoals(ORG, data);

    expect(readRaw().some_future_field).toEqual({ nested: true });
  });

  it('still round-trips the fields it does model', () => {
    const data = getGoals(ORG);
    data.goals = [
      ...data.goals,
      { id: 'g2', title: 'Second goal', progress: 0, order: 1 },
    ];
    data.daily_focus = 'new focus';
    writeGoals(ORG, data);

    const onDisk = readRaw() as {
      goals: Array<Record<string, unknown>>;
      daily_focus: string;
    };
    expect(onDisk.goals).toHaveLength(2);
    expect(onDisk.goals[0].title).toBe('First goal');
    expect(onDisk.goals[1].title).toBe('Second goal');
    expect(onDisk.daily_focus).toBe('new focus');
  });

  it('clears a modelled optional field when it is explicitly removed', () => {
    // A merge must not resurrect a field the caller deliberately dropped.
    const data = getGoals(ORG);
    delete data.daily_focus;
    writeGoals(ORG, data);

    const onDisk = readRaw();
    expect(onDisk.daily_focus).toBeUndefined();
    // ...while still leaving unmodelled fields alone.
    expect(onDisk.north_star).toBe('Ship the thing');
  });

  it('writes a fresh file when none exists', () => {
    fs.rmSync(goalsPath);
    writeGoals(ORG, { bottleneck: 'first', goals: [] });
    expect(readRaw().bottleneck).toBe('first');
  });
});
