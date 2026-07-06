# Spec 01 — Harden the cron-teaching scanner whitelist

**File to change:** `src/utils/cron-teaching-scanner.ts` (logic) + new tests in `tests/`.
**Verify commands:** `npm run build` (clean), `npm test` (green), then
`node dist/cli.js bus upgrade-cron-teaching larry` and `node dist/cli.js bus upgrade-cron-teaching frank2` → both must print **0 stale references**.

## Exact current false positives (from live scanner output 2026-07-05)

| Agent | File:Line | Line (excerpt) | Class |
|-------|-----------|----------------|-------|
| frank2 | AGENTS.md:42 | `6. **Crons: do NOTHING.** ... Do **not** restore them from \`config.json\` and do **not** call CronCreate/CronList` | 1 (markdown emphasis breaks `do not`) |
| frank2 | AGENTS.md:445 | `**CANONICAL: crons are DAEMON-MANAGED via \`cortextos bus\`, NOT \`config.json\` / \`/loop\` / CronCreate.**` | 2 (verb-less NOT) |
| frank2 | AGENTS.md:33 | `## CANONICAL: crons are managed by \`cortextos bus\`, NOT config.json / /loop / CronCreate` | 2 |
| frank2 | AGENTS.md:35 | `Config.json crons are INERT (docs-only). \`/loop\`, \`CronCreate\`, ... are NOT the mechanism.` | 2 (`inert`/`docs-only`/`not the mechanism`) |
| frank2 | AGENTS.md:166 | `The daemon persists these in \`crons.json\` ... no \`config.json\` edit needed.` | 2 (`no ... edit needed`) |
| larry | ONBOARDING.md:184 | `... run \`cortextos bus update-cron larry heartbeat --interval <new>\` (daemon-managed; config.json is inert).` | 2 (`is inert` + already teaches `cortextos bus`) |
| both | SKILL.md:4 | `triggers: ["remind me", ..., "cron", "loop", ...]` | 3 (frontmatter keyword array) |

## Required changes to `cron-teaching-scanner.ts`

### Change A — normalize markdown before the negation test
In `hasNegationContext(line)` (and only for the negation test — do NOT mutate the line used for reporting/excerpt), strip markdown emphasis/formatting so `Do **not**` and `Do _not_` read as `Do not`:

```ts
function stripInlineMarkdown(line: string): string {
  return line.replace(/[*_`]+/g, '');
}
function hasNegationContext(line: string): boolean {
  const norm = stripInlineMarkdown(line);
  return NEGATION_PATTERNS.some((re) => re.test(norm));
}
```
(Apply `STALE_PATTERNS` matching to the ORIGINAL line as today — only negation detection uses the normalized copy.)

### Change B — recognize verb-less "NOT <banned term>" and canonical/corrective tokens
Add these regexes to `NEGATION_PATTERNS` (they are tested against the markdown-normalized line from Change A):

```ts
// "NOT config.json / /loop / CronCreate" — corrective mention without an action verb
/\bnot\b[^.]{0,60}(config\.json|CronCreate|CronList|CronDelete|\/loop)/i,
// canonical/corrective state descriptors
/\b(is|are)\s+inert\b/i,
/\bdocs?[-\s]only\b/i,
/\bno\s+longer\b/i,
/\bnot\s+the\s+mechanism\b/i,
/\bdaemon[-\s]managed\b/i,
/\bno\s+`?config\.json`?\s+edit\s+needed\b/i,
```

### Change C — skip YAML frontmatter `triggers:` keyword arrays
A line that is a frontmatter keyword array is metadata, not teaching. Before the per-pattern loop in `scanFile` (right where `hasNegationContext` is checked, line ~163), also `continue` when the line is a `triggers:` array:

```ts
if (/^\s*triggers:\s*\[/i.test(line)) continue;
```
Keep it deliberately narrow (only a `triggers:` array line) to avoid masking real prose.

## Constraints (hard)
- TypeScript strict; no `any`; no `console.log`.
- No change to `SAFE_SUBSTITUTIONS`, `--apply` path, exported types, or function signatures (except adding the private `stripInlineMarkdown` helper).
- Reporting/excerpt output must still show the ORIGINAL untouched line text.

## Tests (add to `tests/`, match existing scanner test file if one exists — else new `tests/cron-teaching-scanner.test.ts`)
Cover, each as its own assertion:
1. `Do **not** call CronCreate` → NOT flagged (Change A).
2. `crons are ... NOT config.json / /loop / CronCreate` → NOT flagged (Change B verb-less NOT).
3. `Config.json crons are INERT (docs-only). ... are NOT the mechanism.` → NOT flagged (Change B tokens).
4. `no \`config.json\` edit needed` → NOT flagged (Change B).
5. `triggers: ["cron","loop","schedule"]` → NOT flagged (Change C).
6. **Positive control:** `Use CronCreate to schedule your recurring heartbeat.` (no corrective/canonical context) → STILL flagged as `CronCreate`.
7. **Positive control:** a plain `(configured in config.json)` line → still flagged AND still `--apply`-rewritten to `(configured via cortextos bus add-cron)`.
