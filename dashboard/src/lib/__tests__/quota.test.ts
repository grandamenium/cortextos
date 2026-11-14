import { describe, it, expect } from 'vitest';
import { parseUsageFractions } from '../quota';

describe('parseUsageFractions', () => {
  it.each([
    [0, 0],
    [1, 0.01], // the old v > 1 heuristic read this as 100% used
    [4, 0.04],
    [100, 1],
  ])('treats nested utilization %d as a percentage → %d', (raw, expected) => {
    const { fiveH, sevenD } = parseUsageFractions({
      five_hour: { utilization: raw },
      seven_day: { utilization: raw },
    });
    expect(fiveH).toBeCloseTo(expected);
    expect(sevenD).toBeCloseTo(expected);
  });

  it('clamps out-of-range values to 0..1', () => {
    expect(parseUsageFractions({ five_hour: { utilization: 120 }, seven_day: { utilization: -3 } })).toEqual({
      fiveH: 1,
      sevenD: 0,
    });
  });

  it('keeps the legacy flat-field fallback', () => {
    const { fiveH, sevenD } = parseUsageFractions({ five_hour_utilization: 0.42, seven_day_utilization: 18 });
    expect(fiveH).toBeCloseTo(0.42);
    expect(sevenD).toBeCloseTo(0.18);
  });

  it('returns 0 when the windows are missing', () => {
    expect(parseUsageFractions({})).toEqual({ fiveH: 0, sevenD: 0 });
  });
});
