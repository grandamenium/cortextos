# Cron-teaching scanner hardening — stop over-flagging corrective/canonical text and frontmatter

## Goal
`cortextos bus upgrade-cron-teaching <agent>` (source: `src/utils/cron-teaching-scanner.ts`) must stop reporting **false positives** on lines that are *teaching the correct behavior* (canonical/corrective text) or are *metadata* (YAML frontmatter keyword arrays). Today it flags them, which cries wolf and makes the W1 cron-teaching verification untrustworthy.

## Root cause (verified in source + live scanner output, 2026-07-05)
Verified by running the scanner on `larry` (2 hits) and `frank2` (9 hits) — **every remaining hit is a false positive**. Three distinct defects in `cron-teaching-scanner.ts`:

1. **Markdown emphasis defeats negation detection.** `NEGATION_PATTERNS` (line 113–125) test the raw line. frank2 `AGENTS.md` L42 reads `Do **not** ... call CronCreate/CronList` — the `**` between `Do` and `not` breaks `/\bdo\s+not\b/i`, so the negation whitelist misses it and the `CronCreate` pattern fires. This is corrective text (it forbids CronCreate) being flagged AS stale teaching.

2. **"NOT <banned-term>" without an action verb isn't recognized as corrective.** The negation patterns require a verb (`use|edit|write|call|put`). Canonical lines like `crons are ... NOT config.json / /loop / CronCreate` (frank2 L445, L33), `... are NOT the mechanism` (L35), and `config.json is inert` (larry L184) are corrective/canonical but carry no such verb, so they slip past the whitelist and get flagged.

3. **YAML frontmatter `triggers:` keyword arrays are scanned as prose.** Both agents' skill frontmatter L4 `triggers: ["...","cron","loop",...]` is a keyword list (skill activation metadata), not teaching — but the term substrings trip the patterns.

The daemon advisory (`src/daemon/cron-migration.ts`) consumes the same `scanAgentDir()` result, so fixing the scanner fixes the boot-time advisory too.

## Scope
Single repo (cortextos framework), single module + its unit test. **`src/utils/cron-teaching-scanner.ts`** logic only; **`tests/`** add coverage. No CLI surface change, no behavior change to `--apply` substitutions. Spec: `03-specs/spec-01-scanner-whitelist.md`.

## Non-goals
- Do NOT change the `SAFE_SUBSTITUTIONS` set or `--apply` behavior.
- Do NOT touch `src/cli/bus.ts` command wiring or `src/daemon/cron-migration.ts`.
- Do NOT try to whitelist genuine migration-runbook table rows that literally instruct editing config.json for crons (e.g. frank2 `| config.json crons | Port ... |`) — those are arguably still worth a human glance; leaving them as true-ish positives is acceptable and lower-risk than over-broadening the whitelist.

## Done =
Running `cortextos bus upgrade-cron-teaching larry` and `... frank2` reports **0 stale references** (all current hits are the three false-positive classes above). Genuine stale teaching (a bare `Use CronCreate to schedule...` with no corrective/canonical context) still flags. New unit tests in `tests/` cover: markdown-emphasis negation, verb-less "NOT <term>" corrective lines, `is inert`/`docs-only`/`no longer`/`not the mechanism` corrective tokens, and `triggers:` frontmatter skip — plus a positive control that real stale teaching still flags. `npm run build` clean, `npm test` green.
