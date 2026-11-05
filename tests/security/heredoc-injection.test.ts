/**
 * tests/security/heredoc-injection.test.ts
 *
 * Guards the hardening of UNQUOTED heredocs in shipped template guidance
 * (AGENTS.md / HEARTBEAT.md / ONBOARDING.md / CLAUDE.md / SKILL.md).
 *
 * The framework does NOT execute these heredocs itself — agents copy the
 * documented idiom at write time. The risk: an unquoted heredoc
 * (`cat >> file << MEMEOF`) command-substitutes/expands agent-authored
 * free-text and secrets. The fix documents a SAFE idiom: the dynamic
 * timestamp is expanded OUTSIDE the body via a printf argument, and the
 * body is a QUOTED heredoc (`cat <<'MEMEOF'`) so nothing inside expands.
 *
 * Three parts:
 *   (i)   EXPANSION direction  — the fixed idiom still writes a real timestamp.
 *   (ii)  NO-EXEC direction    — the fixed idiom treats a hostile body as
 *                                literal text (with a non-vacuous NEGATIVE
 *                                CONTROL: the OLD unquoted form DOES execute it).
 *   (iii) STATIC GUARD         — no tracked template line reintroduces an
 *                                unquoted heredoc.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const SCAN_DIRS = [join(process.cwd(), 'templates'), join(process.cwd(), 'community')];

// The hostile body used in both the fixed test and the negative control.
// If either form expands it, `touch $DIR/PWNED` runs and PWNED appears.
const HOSTILE_LINE =
  '- hostile: `touch $DIR/PWNED` and $(touch $DIR/PWNED)';

function runBash(script: string, work: string): void {
  const scriptPath = join(work, 'script.sh');
  writeFileSync(scriptPath, script, 'utf-8');
  execSync(`bash "${scriptPath}"`, {
    env: { ...process.env, WORK: work, DIR: work },
    stdio: 'pipe',
  });
}

/** Recursively collect every file under a directory. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

describe('heredoc injection hardening', () => {
  let work: string;

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'heredoc-sec-'));
  });

  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  // (i) EXPANSION direction ------------------------------------------------
  it('fixed idiom still expands the timestamp outside the quoted body', () => {
    // Mirrors the canonical Group-A session-start form.
    const script = [
      'set -e',
      'cd "$WORK"',
      'TODAY=$(date -u +%Y-%m-%d)',
      'mkdir -p memory',
      `{ printf '\\n## Session Start - %s\\n' "$(date -u +'%H:%M:%S UTC')"; cat <<'MEMEOF'`,
      '- Status: online',
      '- Crons active: <list from `cortextos bus list-crons $CTX_AGENT_NAME`>',
      'MEMEOF',
      '} >> "memory/$TODAY.md"',
      '',
    ].join('\n');

    runBash(script, work);

    // Glob the newest memory file rather than reconstructing the date name.
    const memDir = join(work, 'memory');
    const files = readdirSync(memDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f));
    expect(files.length).toBe(1);

    const dateStamp = files[0].replace(/\.md$/, '');
    // Today's UTC date must be present as the file name.
    expect(dateStamp).toBe(new Date().toISOString().slice(0, 10));

    const content = readFileSync(join(memDir, files[0]), 'utf-8');
    // A real HH:MM:SS UTC timestamp was expanded into the header.
    expect(content).toMatch(/## Session Start - \d\d:\d\d:\d\d UTC/);
    // The body placeholder stayed literal (backticks + $VAR NOT expanded).
    expect(content).toContain('<list from `cortextos bus list-crons $CTX_AGENT_NAME`>');
  });

  // (ii) NO-EXEC direction + negative control ------------------------------
  it('fixed idiom writes a hostile body verbatim and executes nothing', () => {
    const script = [
      'set -e',
      'cd "$WORK"',
      `{ printf '\\n## Session Start - %s\\n' "$(date -u +'%H:%M:%S UTC')"; cat <<'MEMEOF'`,
      HOSTILE_LINE,
      'MEMEOF',
      '} >> "$WORK/fixed.md"',
      '',
    ].join('\n');

    runBash(script, work);

    // Nothing executed: no PWNED file.
    expect(existsSync(join(work, 'PWNED'))).toBe(false);

    // The hostile strings were written verbatim (no command substitution).
    const content = readFileSync(join(work, 'fixed.md'), 'utf-8');
    expect(content).toContain('`touch $DIR/PWNED`');
    expect(content).toContain('$(touch $DIR/PWNED)');
  });

  it('NEGATIVE CONTROL: the OLD unquoted form DOES execute the hostile body', () => {
    // Proves the hostile payload is genuinely capable of executing, so the
    // "no PWNED" assertion above is non-vacuous.
    const script = [
      'set -e',
      'cd "$WORK"',
      'cat >> "$WORK/old.md" << MEMEOF',
      HOSTILE_LINE,
      'MEMEOF',
      '',
    ].join('\n');

    runBash(script, work);

    // The unquoted heredoc ran `touch $DIR/PWNED`.
    expect(existsSync(join(work, 'PWNED'))).toBe(true);
  });

  // (ii-b) Indented codex/opencode variant --------------------------------
  it('indented codex/opencode form terminates, expands the stamp, keeps body literal', () => {
    // templates/agent-codex/AGENTS.md and agent-opencode/AGENTS.md indent the
    // whole session-end block (body indented) with the closing delimiter
    // de-indented to column 0. A real bug lived here in the first pass: an
    // indented `   MEMEOF` closer does NOT terminate `<<'MEMEOF'`, so bash
    // consumes to EOF and errors. This guards the specific fixed block:
    // indented body, col0 closer under a quoted delimiter.
    const script = [
      'set -e',
      'cd "$WORK"',
      'mkdir -p memory',
      'TODAY=$(date -u +%Y-%m-%d)',
      `   { printf '\\n   ## Session End - %s\\n' "$(date -u +'%H:%M:%S UTC')"; cat <<'MEMEOF'`,
      '   - Status: [done/interrupted/context-full]',
      `   ${HOSTILE_LINE.slice(2)}`, // indented hostile line
      'MEMEOF',
      '   } >> "memory/$TODAY.md"',
      '',
    ].join('\n');

    // If the closer were indented, this execSync would throw (unterminated
    // heredoc / non-zero exit), failing the test — which is the point.
    runBash(script, work);

    const memDir = join(work, 'memory');
    const files = readdirSync(memDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f));
    expect(files.length).toBe(1);

    const content = readFileSync(join(memDir, files[0]), 'utf-8');
    // Timestamp expanded outside the body.
    expect(content).toMatch(/## Session End - \d\d:\d\d:\d\d UTC/);
    // Nothing executed, hostile body kept literal.
    expect(existsSync(join(work, 'PWNED'))).toBe(false);
    expect(content).toContain('`touch $DIR/PWNED`');
    expect(content).toContain('$(touch $DIR/PWNED)');
  });

  // (iii) STATIC GUARD -----------------------------------------------------
  it('no tracked template or community file reintroduces an unquoted heredoc', () => {
    // An unquoted opener is `<<` then optional `-`/`~`, optional whitespace,
    // then a delimiter token (letter/underscore start) that is NOT immediately
    // preceded by a quote. Matches ANY delimiter name — not just MEMEOF/MEMORY/
    // EOF — so a reintroduced `<< JSON`, `<< SETTINGS`, `<< CONF`, etc. is also
    // caught. A quoted `<<'MEMEOF'` / `<<"EOF"` has the quote right after the
    // optional `-~`/whitespace, so the negative lookahead makes it IGNORED.
    // Scans BOTH the private templates/ tree and the PUBLIC community/ catalog
    // (what users pull via install) — both ship these idioms verbatim.
    const UNQUOTED = /<<[-~]?[ \t]*(?!['"])[A-Za-z_][A-Za-z0-9_]*/;
    const offenders: string[] = [];

    for (const dir of SCAN_DIRS) {
      if (!existsSync(dir)) continue;
      for (const file of walk(dir)) {
        const lines = readFileSync(file, 'utf-8').split('\n');
        lines.forEach((line, idx) => {
          if (UNQUOTED.test(line)) {
            offenders.push(`${file}:${idx + 1}: ${line.trim()}`);
          }
        });
      }
    }

    expect(offenders).toEqual([]);
  });
});
