/**
 * Phase 1 plan-utilization-monitor: parsePercent must survive every
 * "%-shaped string" Anthropic's dashboard could plausibly render. The
 * DOM is brittle by spec (boss directive 2026-05-15) — the regex is the
 * one place where a one-character drift in copy ("47 %" vs "47%") must
 * not become a selector_drift false alarm.
 */
import { describe, it, expect } from 'vitest';
import { parsePercent } from '../../../scripts/analytics/plan-usage-parsers';

describe('parsePercent', () => {
  it('parses the canonical "47%" shape', () => {
    expect(parsePercent('47%')).toBe(47);
  });

  it('parses a decimal "47.3%"', () => {
    expect(parsePercent('47.3%')).toBe(47.3);
  });

  it('parses with whitespace before the % sign', () => {
    expect(parsePercent('47 %')).toBe(47);
  });

  it('parses with surrounding whitespace', () => {
    expect(parsePercent('  72%  ')).toBe(72);
  });

  it('parses without the % sign at all (bare number)', () => {
    // Intentional: dashboards sometimes render the number in one element
    // and the "%" unit in a sibling, so a bare number is a valid read.
    expect(parsePercent('0')).toBe(0);
  });

  it('rejects digits buried in non-numeric prefix (anchored)', () => {
    // The regex anchors at start-of-string to block stray matches like
    // a version label or token-count phrase from passing as a percentage.
    expect(parsePercent('Plan v2')).toBeNull();
    expect(parsePercent('100 tokens remaining')).toBe(100); // leading digit OK
    expect(parsePercent('Plan 47%')).toBeNull(); // leading non-digit blocks
  });

  it('parses zero', () => {
    expect(parsePercent('0%')).toBe(0);
  });

  it('returns null on a completely non-numeric string', () => {
    expect(parsePercent('—')).toBeNull();
    expect(parsePercent('N/A')).toBeNull();
    expect(parsePercent('')).toBeNull();
  });

  it('takes the first numeric run when extra text trails', () => {
    // Realistic shape if Anthropic includes labels: "47% used".
    expect(parsePercent('47% used of 100%')).toBe(47);
  });
});
