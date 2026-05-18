/**
 * Multi-host conformance — static-analysis tests that fail loudly when
 * someone reintroduces the two classes of bug that surfaced when Wave-1
 * deployed to the Mac mini (host #2) on 2026-05-17.
 *
 * The two bugs (both lived in supposedly-tested code):
 *   1. src/daemon/agent-process.ts kept a `runtime === 'codex'` check after
 *      the rest of the codebase + every test was renamed to
 *      'codex-app-server'. Result: every new codex agent silently routed
 *      to the wrong PTY class on the Mac mini and crashed at stop.
 *   2. src/cli/scope-plugins.ts fell back to a hardcoded
 *      `/Users/hari/cortextos` string when CTX_FRAMEWORK_ROOT wasn't set.
 *      Result: on Mac mini (user subbu_ai_assistant) the CLI exited with
 *      "Could not load agents.yaml from /Users/hari/cortextos" because
 *      shell-invoked CLI doesn't inherit PM2 env.
 *
 * Both bugs are "if you write the line, the test will go red". That's the
 * goal — these checks should be embarrassingly mechanical so a future
 * regression is impossible to merge.
 *
 * What is intentionally NOT enforced here:
 *   - Comments / docstrings can mention paths like `/Users/hari/cortextos`
 *     (we strip them before scanning).
 *   - Tests can hardcode whatever they need; this scan is `src/` only.
 *   - `homedir()` calls in module-level constants / macOS-specific paths
 *     (Library/, .cloudflared/) — those are correct uses of HOME and
 *     not multi-host hazards.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = join(__dirname, '..', '..');
const SRC_ROOT = join(REPO_ROOT, 'src');

// --- File walker ------------------------------------------------------------

/** Recursively walk a directory and yield every `.ts` file. */
function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: import('fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Return file content with comments + string-literal interiors blanked out,
 * preserving line numbers so a violation report can point at the original
 * line. Used to keep the scanners from false-positiving on path mentions
 * in comments + doc-comments.
 *
 * Strategy (deliberately lightweight — not a full parser):
 *   - // line comments → blanked through end-of-line
 *   - /* ... *​/ block comments → blanked between markers
 *   - " ... ", ' ... ', ` ... ` strings → KEPT as-is, because the bugs we
 *     guard against ARE string literals. Stripping strings would defeat
 *     check (a)'s "no hardcoded /Users/" rule.
 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '/' && next === '/') {
      // Line comment — replace through newline with spaces (preserve newlines)
      while (i < src.length && src[i] !== '\n') {
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
    } else if (ch === '/' && next === '*') {
      // Block comment — replace through */ with spaces (preserve newlines)
      out += '  ';
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < src.length) {
        out += '  ';
        i += 2;
      }
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/** Pretty-print a violation list as a single multi-line string. */
function formatViolations(violations: Array<{ file: string; line: number; text: string }>): string {
  if (violations.length === 0) return '';
  return violations
    .map(v => `  ${v.file.replace(REPO_ROOT + '/', '')}:${v.line}\n      ${v.text.trim()}`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// (a) No hardcoded /Users/<user>/ paths in src/
// ---------------------------------------------------------------------------

describe('Multi-host conformance (a): no hardcoded /Users/ paths in src/', () => {
  it('src/ files do not contain non-comment /Users/<user>/ paths', () => {
    const files = walkTsFiles(SRC_ROOT);
    expect(files.length).toBeGreaterThan(0); // sanity — walker reached src/

    const violations: Array<{ file: string; line: number; text: string }> = [];
    // Match /Users/<lowercase identifier>/ — covers /Users/hari/, /Users/subbu_ai_assistant/, etc.
    // Note: /Users/<x> ONLY at the start of a path triggers; bare "Users" in
    // identifiers won't match.
    const pattern = /\/Users\/[a-z][a-z0-9_]*\//;

    for (const file of files) {
      const raw = readFileSync(file, 'utf-8');
      const stripped = stripComments(raw);
      const lines = stripped.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i])) {
          violations.push({ file, line: i + 1, text: raw.split('\n')[i] });
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `Found ${violations.length} hardcoded /Users/<user>/ path(s) in src/.\n` +
        `These break multi-host setups (the install user is not always 'hari').\n` +
        `Use process.env.CTX_FRAMEWORK_ROOT or join(homedir(), ...) instead.\n\n` +
        formatViolations(violations),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// (b) No `runtime === 'codex'` checks (renamed to 'codex-app-server')
// ---------------------------------------------------------------------------

describe('Multi-host conformance (b): codex runtime rename', () => {
  it("src/daemon/ files do not reintroduce runtime === 'codex' checks", () => {
    // Files most at risk for the rename regression.
    const targets = [
      join(SRC_ROOT, 'daemon', 'agent-process.ts'),
      join(SRC_ROOT, 'daemon', 'agent-manager.ts'),
    ];

    // Also scan the whole src/ tree because the runtime literal could be
    // checked anywhere (e.g. a future config-reader). Belt-and-suspenders.
    const allFiles = walkTsFiles(SRC_ROOT);
    const filesToScan = Array.from(new Set([...targets, ...allFiles]));

    const violations: Array<{ file: string; line: number; text: string }> = [];

    // Match the SPECIFIC runtime-config patterns — not bare uses of the
    // string 'codex' (which is also the binary name spawned via node-pty,
    // a perfectly valid reference we MUST allow).
    //
    // Variants covered (each one was actually shipped by the bug):
    //   config.runtime === 'codex'
    //   config?.runtime === "codex"
    //   runtime: 'codex',            (object-literal default in tests/config)
    //   runtime === 'codex'          (after destructuring)
    //
    // The closing quote MUST be immediately followed by something that's
    // NOT `-` (which would make it the renamed value 'codex-app-server').
    const runtimeEqPattern = /runtime\s*[?]?\s*(?:===|==)\s*['"]codex['"](?!-)/;
    const runtimeObjPattern = /\bruntime\s*:\s*['"]codex['"](?!-)/;

    for (const file of filesToScan) {
      let raw: string;
      try {
        raw = readFileSync(file, 'utf-8');
      } catch {
        continue;
      }
      const stripped = stripComments(raw);
      const lines = stripped.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Defensive: skip any line that already references the new name.
        // The dual-pattern regexes above SHOULD reject 'codex-app-server'
        // via the `(?!-)` lookahead, but this is a belt-and-suspenders
        // guard against tokenization edge cases in future regex tweaks.
        if (line.includes('codex-app-server') && !runtimeEqPattern.test(line) && !runtimeObjPattern.test(line)) continue;
        if (runtimeEqPattern.test(line) || runtimeObjPattern.test(line)) {
          violations.push({ file, line: i + 1, text: raw.split('\n')[i] });
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `Found ${violations.length} usage(s) of the old 'codex' runtime literal in src/.\n` +
        `The runtime was renamed to 'codex-app-server'. Update these to match —\n` +
        `the 2026-05-17 Mac mini deploy caught this exact bug class.\n\n` +
        formatViolations(violations),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// (c) homedir() calls paired with 'cortextos' must consult CTX_FRAMEWORK_ROOT
// ---------------------------------------------------------------------------

describe('Multi-host conformance (c): homedir() framework-root fallbacks', () => {
  it("homedir() calls building a 'cortextos' framework path are paired with CTX_FRAMEWORK_ROOT", () => {
    // Scope narrowed to the specific bug class: homedir() that derives the
    // FRAMEWORK ROOT (path that ends with '/cortextos', NOT '/.cortextos/').
    // CTX_ROOT-style installs (`~/.cortextos/<instance>`) are different —
    // those are the per-instance state dir, not the framework checkout.
    // The 2026-05-17 bug was scope-plugins falling back to
    // `'/Users/hari/cortextos'` for the framework root.
    const files = walkTsFiles(join(SRC_ROOT, 'cli'));
    expect(files.length).toBeGreaterThan(0);

    const violations: Array<{ file: string; line: number; text: string }> = [];

    // Pattern: `homedir()` followed by 'cortextos' on the same line, where
    // the path is NOT `.cortextos` (the per-instance state dir prefix).
    // We capture by looking for `homedir()` ... `, 'cortextos'` on the
    // same line — only matches when the next path segment is exactly
    // 'cortextos' (the framework checkout), not '.cortextos'.
    const frameworkRootPattern = /homedir\(\)\s*,\s*['"]cortextos['"]/;

    for (const file of files) {
      const raw = readFileSync(file, 'utf-8');
      const stripped = stripComments(raw);
      const lines = stripped.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!frameworkRootPattern.test(lines[i])) continue;
        // Pair-check: the preceding 5 lines should contain a CTX_FRAMEWORK_ROOT
        // env lookup, OR the same line should.
        const windowStart = Math.max(0, i - 5);
        const window = lines.slice(windowStart, i + 1).join('\n');
        const hasFrameworkEnv = /CTX_FRAMEWORK_ROOT/.test(window);
        if (!hasFrameworkEnv) {
          violations.push({ file, line: i + 1, text: raw.split('\n')[i] });
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `Found ${violations.length} homedir()+'cortextos' framework-root path(s) ` +
        `not paired with CTX_FRAMEWORK_ROOT in src/cli/.\n` +
        `Pattern: \`process.env.CTX_FRAMEWORK_ROOT ?? join(homedir(), 'cortextos')\`\n` +
        `Without the env fallback, multi-host installs break (Mac mini ran as\n` +
        `user subbu_ai_assistant; PM2 env was not visible to shell-invoked CLI).\n\n` +
        formatViolations(violations),
      );
    }
  });
});
