# WS10 — Completeness / Correctness Layer (graphify re-index cron · R6 did-vs-claimed ledger · R8 memory-correctness harness)

Spec date: 2026-07-04 · Author: architect (planning pass, no code) · Repo: `clearworks-ai/cortextos` fork, branch off `main`.

> READ-ONLY planning artifact. No code written, no PRs opened, nothing run against prod/live data. Everything below is grounded against the ACTUAL fork at the file:line cited.

---

## 1. GOAL

Make the fleet's own claims falsifiable and its knowledge graph self-refreshing, so Josh gets **certainty** (silent failures and false "done" claims are catchable, memory claims are checkable) without adding a heavyweight new subsystem. Three small, independent pieces that reuse infra WS2/WS4/WS5 already landed:
- **(a)** a graphify re-index cron that keeps the knowledge graph fresh (folds into WS4/WS5).
- **(b) R6** a correlated did-vs-claimed **activity ledger** that cross-references what agents *claimed* against what actually *fired/happened* (pairs with WS2 receipts + the pending silent_failure_detection experiment).
- **(c) R8** a **memory-correctness test harness** that makes MEMORY.md claims (named files/functions/flags) falsifiable in CI.

---

## 2. GROUNDED CURRENT STATE (fork today)

### Shared infra that already exists and is reusable

- **Verification receipts (WS2) — LIVE.** `src/utils/verification-receipt.ts` writes an append-only ledger at `{ctxRoot}/state/verification-receipts.jsonl` (`recordVerificationReceipt`, `receiptLedgerPath:39`, `hasRecentReceipt:74`). CLI: `cortextos bus verify-receipt` (`src/cli/bus.ts:1240`). This is the "claimed I verified" signal.
- **Completion-claim detector (WS2) — LIVE.** `src/utils/claim-detector.ts` `detectsCompletionClaim()` (pure regex; `CLAIM_PATTERNS:22`, `NEGATION_PATTERNS:58`). Fires the warn-only guard.
- **Claim-without-receipt guard (WS2) — LIVE + WIRED.** `emitClaimWithoutReceiptWarning()` (`verification-receipt.ts:122`) is called at the send-telegram choke point (`src/cli/bus.ts:1201`). It logs a warn-only `message/claim_without_receipt` event. So **"agent claimed done in a Telegram message"** is already an event in the log.
- **Structured event log — LIVE.** `src/bus/event.ts` `logEvent():23` appends `{analyticsDir}/events/{agent}/{YYYY-MM-DD}.jsonl`. Every Telegram send auto-emits `message/telegram_sent` (`src/cli/bus.ts` ~1226) and the guard emits `message/claim_without_receipt`. This is the "what was claimed / what surfaced" stream.
- **Cron fire registry — LIVE.** `src/bus/cron-state.ts` `readCronState()/updateCronFire()` → `state/<agent>/cron-state.json` records `{name,last_fire,interval}`. Agents call `cortextos bus update-cron-fire <name>` at the top of every cron prompt (seen in `orgs/clearworksai/agents/larry/config.json`). This is the authoritative "this cron actually fired" signal.
- **Cron execution log — LIVE.** `src/daemon/cron-execution-log.ts` `appendExecutionLog()` → `.cortextOS/state/agents/{agent}/cron-execution.log` (JSONL of `CronExecutionLogEntry {ts,cron,status:'fired'|'retried'|'failed',attempt,duration_ms,error}` — type at `src/types/index.ts:462`). This is the "did it fire and did it error" signal, per-attempt.
- **Fleet reconcile (WS4) — LIVE, pure.** `src/bus/reconcile.ts` `reconcile()` returns a `DriftReport` (missing_process / orphan_process / missing_cron / missing_env). CLI `cortextos bus fleet-reconcile` (`src/cli/bus-reconcile.ts:29`) gathers live inputs, prints, and emits one drift event per finding. **This is the exact architectural template R6 should copy: a pure analyzer + a thin CLI that gathers inputs and emits events.**
- **Memory size lint (WS6) — LIVE but size-only.** `src/utils/memory-lint.ts` `lintMemory()` enforces total bytes + per-line char budget only (`DEFAULT_MEMORY_BUDGET:37`). CLI `cortextos bus memory-lint` (`src/cli/bus.ts:3288`). **It does NOT check whether memory *content* is still true.**
- **graphify skill — LIVE.** `~/.claude/skills/graphify/SKILL.md` (also vendored per-agent under `orgs/.../agents/*/.claude/skills/graphify/`). Supports `--update` (incremental, code-only skips LLM), `--cluster-only`, `query`, git post-commit hook, and `--watch`. larry already has a graph corpus at `orgs/clearworksai/agents/larry/state/knowledge-map/graphify-out/` and `graphify-out/` at repo root.
- **Test conventions.** Pure-logic unit tests live in `tests/unit/{bus,utils,...}`; integration/CLI tests in `tests/integration`. `npm run build` (tsc strict) + `npm test` are the gates (project CLAUDE.md).

### What's missing / broken

1. **No graphify re-index cron anywhere.** `grep graphify orgs/clearworksai/agents/larry/config.json` = 0 matches. The graph goes stale; larry's `state/knowledge-map/graphify-out` is only ever rebuilt by hand. (Confirmed no reindex/knowledge-map cron in larry config.)
2. **No correlation between claimed and fired.** The three signal streams exist (receipts, events, cron-state/exec-log) but nothing joins them. A cron whose prompt says `SILENT-OK if healthy` that silently never fired looks identical to a healthy silent run. A `claim_without_receipt` warning is logged but never rolled up into a "these N claims had no backing action" report. This is R6's gap and it pairs directly with the pending **silent_failure_detection** experiment (grep confirms that experiment is NOT yet built in `src/`).
3. **Memory claims are unfalsifiable.** MEMORY.md and topic files name concrete files/functions/flags (per the memory protocol: "A memory that names a specific function, file, or flag is a claim that it existed *when written*"). Nothing checks that `reference_*`/`project_*` file-path and symbol references still resolve. memory-lint only checks size. This is R8's gap.

---

## 3. DESIGN (concrete, minimal, in-scope)

Three independent deliverables. Each is small and reuses the reconcile-style "pure analyzer + thin CLI + optional cron" shape. **No broad refactor** — all new files plus one cron-config append.

### (a) graphify re-index cron

The lightest possible piece: a **cron declaration only** (no new TypeScript). Add a recurring cron to larry's `config.json` crons array (larry owns the knowledge-map corpus and already owns repo-health/upstream-sync fleet crons).

- **Name:** `graph-reindex`.
- **Cadence:** `interval: "24h"` (nightly; matches Josh's "nightly incremental is fine" rule from `feedback_kb_pipeline_token_resilient`). Use `--update` so unchanged content is not re-embedded and code-only changes skip the LLM path entirely (SKILL.md `--update` behavior, lines 762–836).
- **Prompt shape** (mirrors the existing larry cron prompts exactly — fire-marker + task + instruction):
  ```
  cortextos bus update-cron-fire graph-reindex --interval 24h 2>/dev/null;
  GRAPH RE-INDEX — Run `/graphify <corpus> --update` on larry's knowledge-map corpus
  (orgs/clearworksai/agents/larry/state/knowledge-map). If graphify reports
  "No files changed since last run", record a verify-receipt (kind=graph-reindex,
  ref=no-change) and stop SILENT-OK. If it re-extracted, record a verify-receipt
  (kind=graph-reindex, ref=<N nodes/edges>) and SILENT-OK. On error, ping Larry-diagnose,
  never Josh raw (feedback_railway_alerts_route_to_larry generalizes: infra noise → larry).
  ```
- **Why a receipt on completion:** it makes this cron *itself* legible to R6 (a cron that claims to have run leaves a receipt R6 can correlate against its cron-state fire). Dogfoods (b).
- **Corpus scope decision → OPEN QUESTION Q1** (which corpus is canonical to keep fresh — larry's knowledge-map only, or also the wiki under knowledge-sync). Default to larry's knowledge-map only to stay in-scope; WS5 owns the wiki re-publish cron separately.

No code. This is a config edit + a documented prompt. Token-resilient by construction (`--update` + content-hash cache already in the skill).

### (b) R6 — Correlated did-vs-claimed activity ledger

A **pure analyzer + thin CLI**, cloned structurally from `reconcile.ts` + `bus-reconcile.ts`. It does not invent a new storage format; it *reads the four existing signal streams for a time window and reports mismatches*.

**New pure module: `src/bus/activity-ledger.ts`**
- Exported types:
  - `ClaimSignal { agent, kind: 'telegram_claim'|'claim_without_receipt', ts, ref? }` — derived from event JSONL (`message/telegram_sent` whose preview trips `detectsCompletionClaim`, and `message/claim_without_receipt`).
  - `ActionSignal { agent, kind: 'receipt'|'cron_fire'|'cron_exec', ts, ref? }` — from `verification-receipts.jsonl`, `cron-state.json`, and `cron-execution.log`.
  - `LedgerFinding { kind: 'claim_without_action' | 'silent_cron' | 'cron_error_unreported', agent, detail, message, claimTs?, windowStart, windowEnd }`.
  - `LedgerReport { findings, clean, total, counts }`.
- Exported pure fn `correlateActivity(input: { claims: ClaimSignal[]; actions: ActionSignal[]; declaredCrons: {agent,name,interval}[]; now: number; windowMs: number }): LedgerReport`.
- **Correlation rules (deliberately conservative — warn-only, mirrors WS2 posture):**
  1. `claim_without_action`: a `telegram_claim` (agent said done/shipped/fixed/live) with **no** `receipt` ActionSignal from the same agent within ±`windowMs`. Reuses `detectsCompletionClaim` from `claim-detector.ts` for the claim test — single source of truth for "is this a completion claim." (Note: `claim_without_receipt` events are already the precomputed form of this; R6 also rolls the raw `telegram_sent` previews so it catches claims made where the guard didn't fire.)
  2. `silent_cron`: a cron declared in an agent's config with interval I, where cron-state `last_fire` is older than `2×I` **and** no `cron-execution.log` entry within `2×I`. This is the "SILENT-OK masked a cron that never ran" failure (Anthropic-credits incident pattern: `SILENT-OK generated=0 masks it`). Deliberately reuses the daemon's existing `2×interval` gap heuristic (`cron-state.ts` doc comment).
  3. `cron_error_unreported`: a `cron-execution.log` entry with `status:'failed'` in-window for which no corresponding `message/*` surfacing event or receipt exists → the failure happened but nothing was said.
- **Purity contract:** identical to `reconcile.ts` — no fs, no shell, no env reads inside `correlateActivity`. Gathering the signals is the CLI's job. This keeps it unit-testable without a live fleet.

**New CLI: `src/cli/bus-activity-ledger.ts`** (registered in `src/cli/bus.ts` next to `fleetReconcileCommand`)
- Command: `cortextos bus activity-ledger [--window <dur>] [--agent <name>] [--json] [--emit-events]`.
- Gathers: reads each agent's event JSONL for the window (`{analyticsDir}/events/*/*.jsonl`), `verification-receipts.jsonl`, each `state/<agent>/cron-state.json`, each `.cortextOS/state/agents/<agent>/cron-execution.log`, and declared crons from config (same source `fleet-reconcile` already reads via IPC `list-all-crons`).
- Calls `correlateActivity`, prints the report.
- `--emit-events`: emits one `system/did_vs_claimed_drift` warning event per finding (severity `warning`), mirroring `bus-reconcile.ts`'s per-finding `logEvent`. **Warn-only. Never blocks, never messages Josh directly.** Routing of surfaced findings goes through larry (per `feedback_railway_alerts_route_to_larry`).
- Intended caller: a larry worker cron `did-vs-claimed-check` (interval `6h`), analogous to the fleet-reconcile worker. Cron declaration included in Files-To-Touch but the *worker SKILL* itself is out of scope for this spec (it's a prompt, add in the same larry config edit as (a)).

**Relationship to silent_failure_detection experiment:** R6 is the *measurement* the experiment needs. The experiment (pending, not yet in `src/`) can wrap `activity-ledger --json` as its metric collector: baseline = findings/day now, treatment = findings/day after a fix. No new experiment code in this spec — just note the seam so the experiment can consume R6's JSON.

### (c) R8 — Memory-correctness test harness

Make memory claims falsifiable. A **pure claim-extractor + verifier** plus a **test** that runs it over the fleet's memory files, so a memory that references a now-deleted file/function fails CI (or a lint) instead of silently misleading an agent.

**New pure module: `src/utils/memory-correctness.ts`**
- `extractClaims(markdown: string): MemoryClaim[]` where `MemoryClaim = { kind:'file'|'symbol'|'wikilink', value, line }`.
  - `file`: backtick-wrapped tokens that look like repo paths (`src/...`, `orgs/...`, `*.ts`/`*.py`/`*.md`/`*.json` with a `/`). Conservative regex — only flags things that clearly *assert a path exists*.
  - `symbol`: backtick-wrapped `identifierCase()` or `--flag-name` tokens (a memory naming a function or CLI flag).
  - `wikilink`: `[[slug]]` cross-references (the memory protocol's own link format) → must resolve to a sibling memory file.
- `verifyClaims(claims, resolver): MemoryClaimResult[]` — pure; takes a `resolver` object `{ fileExists(path):boolean; symbolExists(name):boolean; memoryExists(slug):boolean }` injected by the caller so the core stays fs-free and unit-testable (same DI pattern as reconcile taking plain data).
- Verdicts: `resolved` | `unresolved` | `skipped` (ambiguous — don't fail on things we can't confidently classify; conservative, matches the memory doc's "verify before recommending" spirit without being a false-positive machine).

**New test: `tests/unit/utils/memory-correctness.test.ts`**
- Unit-tests `extractClaims` (fixtures: a memory naming `src/bus/reconcile.ts` → file claim; one naming `detectsCompletionClaim()` → symbol claim; one naming `[[project-foo]]` → wikilink; prose with no claims → none).
- Unit-tests `verifyClaims` with a stub resolver (resolved vs unresolved).

**New integration test / lint: `tests/integration/memory-correctness-fleet.test.ts`** (the falsifiability gate)
- Walks the fleet memory files (the shared index + `project_*`/`reference_*`/`feedback_*` topic files under the agent-memory dirs), extracts claims, and verifies **file** and **wikilink** claims against the real filesystem (`existsSync`) and sibling memory files. **Symbol** claims verified best-effort by grep across `src/` (a symbol claim is `unresolved` only if grep finds it nowhere).
- **Report-only by default, opt-in fail:** prints an audit table (memory → claim → verdict). Gated so it does not break CI on day one (memory rot is pre-existing). Env flag `MEMORY_CORRECTNESS_STRICT=1` makes `unresolved` file/wikilink claims fail the test — that's the CI switch Josh can flip once the backlog is clean. This mirrors how memory-lint exits non-zero (`src/utils/memory-lint.ts` doc) but starts non-blocking to avoid a wall of red on legacy rot.

**Optional CLI (nice-to-have, include only if cheap): `cortextos bus memory-correctness [--strict] [--json]`** next to `memory-lint` in `bus.ts` — lets larry run the check as a cron and route unresolved-claim findings for cleanup. If it risks scope-creep, defer to a follow-up; the test harness is the load-bearing deliverable.

---

## 4. STAGING / PROD-OPS (Josh-gated, staging-first)

Nothing here mutates prod data or reorganizes anything, but three items touch the running fleet and are **Josh-gated**:

1. **Enabling the `graph-reindex` cron on the live larry** (a). Adding it to `config.json` schedules a real recurring LLM run. Gate: Josh sign-off before it goes live; first run observed once, manually, on larry's real corpus to confirm `--update` behaves (no runaway token spend) **before** leaving it enabled. Not destructive, but it spends tokens — treat like any new cron.
2. **Enabling the `did-vs-claimed-check` worker cron** (b). Same posture: land the code, but leave the *cron* off until Josh approves; dry-run `cortextos bus activity-ledger --window 24h --json` once by hand and eyeball the findings for false positives before scheduling. Warn-only, so low blast radius, but a noisy first run erodes signal (the exact WS2 concern).
3. **Flipping `MEMORY_CORRECTNESS_STRICT=1`** (c). Do NOT flip in the same change that lands the harness — legacy memory rot would turn CI red. Land report-only; Josh/larry clean the backlog; flip strict later. This is the staging-first equivalent for a lint gate.

Per `reference_fleet_daemon_restart_guard`: any cron activation that needs a daemon reload uses `cortextos restart larry --instance cortextos1` (single-agent), never a full daemon bounce.

---

## 5. FILES TO TOUCH (tight)

New (all additive — no edits to shared logic, minimizing conflict surface):
- `src/bus/activity-ledger.ts` — pure `correlateActivity` + types (R6).
- `src/cli/bus-activity-ledger.ts` — `activity-ledger` CLI command (R6).
- `src/utils/memory-correctness.ts` — pure `extractClaims`/`verifyClaims` (R8).
- `tests/unit/bus/activity-ledger.test.ts` — R6 pure-logic tests.
- `tests/unit/utils/memory-correctness.test.ts` — R8 extractor/verifier tests.
- `tests/integration/memory-correctness-fleet.test.ts` — R8 fleet falsifiability gate (report-only).

Edited (surgical, additive only):
- `src/cli/bus.ts` — register `activityLedgerCommand` (import + `.addCommand`) next to `fleetReconcileCommand` at ~line 40; optionally register `memory-correctness` next to `memory-lint` at ~3288. No changes to existing command bodies.
- `orgs/clearworksai/agents/larry/config.json` — append `graph-reindex` cron (a) + `did-vs-claimed-check` cron (b, left disabled/Josh-gated). Config-only.

Explicitly **NOT** touched: `verification-receipt.ts`, `claim-detector.ts`, `event.ts`, `reconcile.ts`, `cron-state.ts`, `memory-lint.ts` — R6/R8 *read* these, they do not modify them. (Broad refactor is the stated conflict-bomb failure mode; avoided.)

---

## 6. TEST PLAN

- **R6 `correlateActivity` (unit, `tests/unit/bus/activity-ledger.test.ts`):**
  - claim + matching receipt in-window → 0 findings (clean).
  - claim, no receipt in-window → one `claim_without_action`.
  - declared cron, last_fire > 2×interval, no exec entry → one `silent_cron`.
  - cron-exec `status:'failed'`, no surfacing event → one `cron_error_unreported`.
  - failed cron that WAS surfaced → 0 findings (no false positive).
  - purity: called twice with same input → identical output; no fs/env access (assert by running with a frozen fixture, no tmpdir).
- **R6 CLI (integration, optional):** seed a tmp `ctxRoot` with fixture event/receipt/cron-state files; run `activity-ledger --json`; assert findings match the pure result. Confirms the gather layer maps files → signals correctly.
- **R8 extractor/verifier (unit):** fixtures per claim kind (file/symbol/wikilink/none); stub resolver for resolved vs unresolved; assert `skipped` on ambiguous tokens (no false fails).
- **R8 fleet gate (integration):** run over real memory files in report-only mode → asserts it *runs and produces a table* (does not assert zero unresolved, since legacy rot exists). A second assertion: with `MEMORY_CORRECTNESS_STRICT=1` against a fixture memory dir containing one known-bad path, the test fails — proving the gate bites when flipped.
- **Gates:** `npm run build` (tsc strict, no `any`) + `npm test` green. Proves-it-works = the R6 tests catch a synthetic silent cron and a synthetic false claim; the R8 gate fails on a synthetic dangling file reference.

---

## 7. RISKS + OPEN QUESTIONS

**Risks & mitigations:**
- *R6 false positives erode signal* (the WS2 lesson, and the false-crash incident). Mitigation: reuse `detectsCompletionClaim` (already tuned conservative), warn-only, ±window tolerance, and a mandatory manual dry-run before the cron is enabled. Never message Josh directly — route through larry.
- *R6 window mis-tuning* — receipts and claims can legitimately straddle the window boundary. Mitigation: symmetric ±window (default 30 min, matching `CLAIM_RECEIPT_WINDOW_MS`), configurable via `--window`.
- *R8 over-flags legacy rot and floods CI red.* Mitigation: report-only by default; `STRICT` is opt-in and flipped only after backlog cleanup (see §4.3). Symbol claims are grep-based best-effort and default to `skipped` when ambiguous.
- *graphify `--update` token runaway on a large corpus.* Mitigation: `--update` uses the content-hash cache + code-only-skips-LLM path already in the skill; nightly cadence; first run observed manually (§4.1).
- *Reading all agents' event JSONL each run is O(files).* Mitigation: window-bounded (only today + yesterday's daily files for a 24h window); this is the same read pattern `hasRecentReceipt` and the reconcile worker already use.

**Open questions for Josh:**
- **Q1 (a):** Which corpus is canonical for the re-index cron to keep fresh — larry's `state/knowledge-map` only (my default, in-scope), or also the knowledge-sync wiki? (The wiki re-publish is nominally WS5's; I'd keep them separate.)
- **Q2 (b):** Cadence for `did-vs-claimed-check` — 6h (my default, matches fleet-reconcile rhythm) or tie it to run right after each fleet-reconcile pass so drift + did-vs-claimed surface together?
- **Q3 (b):** Should `claim_without_action` findings feed the pending **silent_failure_detection** experiment automatically (R6 JSON as its metric source), or stay a standalone larry report for now?
- **Q4 (c):** Who owns memory-rot cleanup when R8 surfaces unresolved claims — larry auto-opens a cleanup task, or it's report-only until you review? (Affects whether the optional CLI/cron is worth building now.)
- **Q5 (c):** Scope of the R8 fleet walk — just the shared fleet index + agent-memory topic files, or also the knowledge-sync wiki `[[wikilinks]]`? (I scoped to fleet memory to stay minimal.)

---

## 8. EFFORT

- **(a) graph-reindex cron:** **S** — config + prompt only, no code. Direct job.
- **(b) R6 ledger:** **M** — one pure module + one CLI + tests, cloned from the reconcile shape. Small, self-contained; does NOT need the full build pipeline but benefits from a spec→build→adversarial-review pass because the correlation rules are where subtle false positives hide.
- **(c) R8 harness:** **S–M** — one pure module + two tests; optional CLI is the only thing that could push it to M.

**Overall: M.** Full sharded build pipeline is overkill; this is a spec → single focused build (codexer) → adversarial review, with the three pieces buildable in parallel since they share zero files. The only cross-file touch is two `.addCommand` lines in `bus.ts` — trivial, non-conflicting.
