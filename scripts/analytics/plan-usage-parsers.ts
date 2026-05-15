/**
 * scripts/analytics/plan-usage-parsers.ts
 *
 * Pure-function helpers extracted from plan-usage-snapshot.ts so they can
 * be unit-tested without standing up a real Chrome / puppeteer-core stack.
 *
 * No imports, no I/O — keep it that way. Anything DOM-shaped or process-
 * shaped belongs in the main snapshot script.
 */

/**
 * Parse the rendered text of a "%-style" DOM element into a number.
 *
 * Handles the shapes Anthropic's dashboard is observed to use (or likely
 * to use, pending live verification):
 *   - "47%"          → 47
 *   - "47.3 %"       → 47.3
 *   - "0%"           → 0
 *   - "  72%  "      → 72
 *   - "47% used"     → 47   (numeric prefix + trailing label)
 *
 * Anchored to start-of-string: text that doesn't BEGIN with a number is
 * rejected, even if it contains digits later. This blocks the failure
 * mode where a stray version string or label ("Plan v2", "100 tokens
 * remaining of 220000") accidentally returns a meaningless number. The
 * % sign stays optional because dashboards sometimes render a bare
 * number with the unit in a sibling element.
 *
 * Returns null when the input has no leading numeric prefix (callers
 * decide whether null is recoverable or a parse_error).
 */
export function parsePercent(s: string): number | null {
  const m = s.match(/^\s*(\d+(?:\.\d+)?)\s*%?/);
  if (!m) return null;
  return Number(m[1]);
}
