/**
 * Lint-as-test: guards against `rawTelegramApi()` callers spreading
 * outside the documented allowlist.
 *
 * `TelegramConnector.rawTelegramApi()` is an `@internal @deprecated PR2`
 * escape hatch — it returns the underlying TelegramAPI so FastChecker's
 * legacy callback-edit + answer-query paths (which PR1 intentionally
 * leaves Telegram-direct) can continue working through the connector
 * indirection. PR2 designs a proper interactive-message lifecycle
 * abstraction and removes this method.
 *
 * Until then, this guard fails the build if `rawTelegramApi` appears in
 * any file outside the documented allowlist below. Add a new entry here
 * only if you've discussed the call site with a maintainer; otherwise
 * route through the generic MessageConnector interface.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const REPO_ROOT = join(__dirname, '..');

const ALLOWED_CALLERS = new Set<string>([
  // Production: agent-manager populates FastChecker's telegramApi field
  // via this escape hatch (PR1 transitional bridge — PR2 removes).
  'src/daemon/agent-process.ts',
  'src/daemon/agent-manager.ts',
  // The connector class itself + its tests
  'src/connectors/telegram/telegram-connector.ts',
  'tests/unit/connectors/telegram-connector.test.ts',
  'tests/unit/connectors/conformance.test.ts',
  // This guard file references the symbol in its docstring — must self-allow.
  'tests/lint-no-stray-raw-api.test.ts',
]);

const SCAN_DIRS = ['src', 'tests', 'dashboard/src'];

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      walk(full, out);
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx') || entry.endsWith('.js')) {
      out.push(full);
    }
  }
}

describe('CI grep guard: rawTelegramApi escape-hatch scope', () => {
  it('only the documented allowlist references rawTelegramApi()', () => {
    const files: string[] = [];
    for (const dir of SCAN_DIRS) {
      walk(join(REPO_ROOT, dir), files);
    }

    const violations: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      if (!content.includes('rawTelegramApi')) continue;
      const rel = relative(REPO_ROOT, file);
      if (!ALLOWED_CALLERS.has(rel)) {
        violations.push(rel);
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `rawTelegramApi() is used in files outside the documented allowlist:\n  ${violations.join('\n  ')}\n` +
        `Either route through the generic MessageConnector interface, or add the file to ALLOWED_CALLERS ` +
        `in tests/lint-no-stray-raw-api.test.ts AFTER discussing with a maintainer.`,
      );
    }
    expect(violations).toEqual([]);
  });
});
