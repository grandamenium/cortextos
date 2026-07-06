# WS5 — Knowledge / Document Pipeline (fail-loud in, reliable out)

Spec date: 2026-07-04 · Author: Architect · Status: PLANNING (no code, no PRs, no prod runs)
Repo: `/Users/joshweiss/code/cortextos` (fork = clearworks-ai/cortextos, branch `main`)

---

## 1. GOAL

Make documents flowing **in** (KB ingest) fail loud instead of silently reporting success, and documents flowing **out** (wiki re-publish) reliably visible — so Josh gets *certainty* that his knowledge base and wiki are actually current, and can trust the "New Wiki Articles" section of his remote brief. Set up (but do NOT run) the one-time Clearpath intel export + Gemini 768d re-embed, and land the in-house intel-extraction port so cortextOS stops depending on Clearpath for meeting intelligence.

---

## 2. GROUNDED CURRENT STATE (fork today)

### 2a. The masking bug is real and lives in `cmd_ingest`
`knowledge-base/scripts/mmrag.py:2600 cmd_ingest` counts errors but **never signals them to the caller**:
- `knowledge-base/scripts/mmrag.py:2634-2636` — per-file exception → `errors += 1`, printed as `ERROR:` line, loop continues.
- `knowledge-base/scripts/mmrag.py:2656-2661` — prints `Done! Ingested {total} new chunk(s)` and, only *if* `errors`, an extra `Errors: N` line. **No `sys.exit(1)`.**
- `knowledge-base/scripts/mmrag.py:~3648` — `commands[args.command](args)` calls `cmd_ingest` and `main()` falls through to a normal (exit 0) return. So a run where every file 500s (e.g. "Anthropic credit balance too low" → here it's a Gemini embed failure) still exits 0 with `total=0`.
- `bus/kb-ingest.sh:17` uses `set -euo pipefail`, and line 116 runs mmrag directly, so the wrapper faithfully inherits mmrag's exit code — which is the problem: mmrag hands it a 0. Note lines 120-126 (`exit_code=$?`) are effectively dead under `pipefail` since a real non-zero already aborts; they are not the fix point. **The fix belongs in `cmd_ingest`, not the wrapper.**
- The ingest parser (`mmrag.py:3538 p_ingest`) has **no `--json` and no `--fail-on-error` flag** — there is no machine-readable success/fail signal at all.

This is exactly `incident_anthropic_api_credits_depleted_2026-07-03` + `reference_kb_embeddings_gemini_not_openai`: `generated=0` looks identical to `generated=0, errored=N`, and callers key on "did it print Done".

### 2b. Where ingest actually runs (there is NO dedicated nightly kb-ingest cron)
Grounded from live `~/.cortextos/cortextos1/.cortextOS/state/agents/*/crons.json`. The doc-IN surfaces are:
- **Per-agent memory ingest** — `templates/agent/HEARTBEAT.md:135-146` Step 10 runs `cortextos bus kb-ingest ./MEMORY.md ./memory/<date>.md ... --force` every heartbeat. This is the highest-frequency ingest and the one most exposed to the silent-fail (Gemini key/credit).
- **crm `fireflies-ingest`** (2h) — pulls meetings → crm files; not an mmrag ingest but IS a doc-in path with its own `SILENT-OK if no new meetings → respond 'OK'` contract (same masking class if the pull errors).
- **larry `kb-reconcile-nightly`** (09:30 daily) — `mmrag.py reconcile --json` against `knowledge-sync/wiki,raw`, writes a dated JSON report, `SILENT-OK unless errors or purged_chunks>500`. This is the mirror-integrity path, already fail-loud-ish because it uses `--json`.

### 2c. Wiki re-publish: exists, but forked into two divergent crons
`~/code/knowledge-sync/scripts/wiki-synthesis.py` exists (24KB, mtime 2026-05-18). It is invoked by **two different `daily-wiki-prep` crons** with different args and different failure contracts:
- **frank2 `daily-wiki-prep`** (02:07 daily): `wiki-synthesis.py --max-files 50 --source-path raw/areas/clearworks`, then `git add wiki/ && commit`, writes `/tmp/wiki-new-articles.txt`, and **already has an explicit fail-loud Telegram** to `6690120787` on non-zero exit or "0 files when raw backlog non-empty" (comment: "failed 3 nights May-Jun 2026, Josh escalated").
- **larry `daily-wiki-prep`** (02:07 daily): `wiki-synthesis.py --max-files 400` (full corpus), `SILENT-OK if generated=0`, explicitly "Do NOT git push". No fail-loud.

**Two crons, same name, same time, same script, contradictory contracts** (one commits + is fail-loud, one is silent + no-commit, different `--max-files`, different scope). This is a drift/duplication bug: they race on the same `.synthesis-state.json` and the silent one can mask what the loud one would catch.

### 2d. Clearpath intel source (for parts c + d) — confirmed in local `~/code/clearpath`
- `shared/schema.ts:482 intelligenceExtractions` — `result: text`, `promptKey/promptLabel`, `firefliesMeetingId`, `contentHash`, `orgId`, `status`, `impactScore` (jsonb). This `.result` text is the high-value extracted intel. This is the ~2,700-row corpus to export.
- `shared/schema.ts:1613 intelligenceEmbeddings` — Clearpath's OWN pgvector embeddings (`embedding: vector`, `chunkText`, `meetingTitle/Date`). Clearpath already chunk+embeds; cortextOS wants these re-embedded into MMRAG at Gemini 768d (not reuse Clearpath's vectors, which are a different model/dim).
- `server/services/briefing-generator.ts` + intel extraction services exist and are the "deep intel-extraction" to port (part d).
- DB access pattern is already known: `reference_auditos_db_query_public_url` establishes the Railway `DATABASE_PUBLIC_URL` read-only pattern; Clearpath has the same shape.

### 2e. What's missing / broken (summary)
1. `cmd_ingest` cannot fail loud — no non-zero exit, no `--json`, no `--fail-on-error`.
2. Memory-ingest heartbeat step (the most frequent ingest) has no error surfacing at all.
3. Two conflicting `daily-wiki-prep` crons; the silent larry one can mask failures.
4. No Clearpath intel export tool exists in the fork (part c is greenfield).
5. In-house intel extraction (part d) does not exist in cortextOS — meeting intel today is either Clearpath-side or the thin crm `fireflies-ingest`.

---

## 3. DESIGN (minimal, reuse existing infra)

### Part (a) — FAIL-LOUD KB ingest  [core, do this first]
Make the ingest signal errors without changing its happy-path behavior.

1. **`cmd_ingest` exit code** (`mmrag.py` ~2656-2661): add, after printing the summary:
   - new arg `--fail-on-error` (default **False** to preserve every existing caller) on `p_ingest` (`mmrag.py:3538`).
   - when `errors > 0` **and** `args.fail_on_error`: `sys.exit(1)` after the summary print. This keeps mmrag's current default behavior byte-for-byte for callers that don't opt in.
2. **`cmd_ingest` `--json`** (`mmrag.py:3538` + end of `cmd_ingest`): add `--json` that, instead of the human summary, prints one line: `{"collection":..., "generated": total, "skipped": skipped, "errored": errors}`. This gives crons a machine-readable `errored` field — the exact thing missing in the depletion incident. `--json` should also honor `--fail-on-error` for exit code.
3. **`bus/kb-ingest.sh`**: pass `--fail-on-error` through by default (add a `--no-fail-on-error` escape hatch). Because the wrapper is `set -euo pipefail`, a mmrag `sys.exit(1)` now aborts the wrapper → the calling cron sees non-zero. Keep the existing lines 120-126 but they become correct (they only run on 0 now).
4. **Memory-ingest heartbeat** (`templates/agent/HEARTBEAT.md:135-146` + the mirrored copies under `community/agents/*`, `templates/*/HEARTBEAT.md`): append a fail-loud tail to the documented command so a per-agent memory-ingest failure is visible in that agent's daily memory/events (NOT Telegram — heartbeat is silent-ok by design). Concretely: run kb-ingest capturing exit; on non-zero, `cortextos bus log-event action kb_ingest_failed warn`. This is a template/doc change, not code.
5. **larry `kb-reconcile-nightly`** already reads `--json`; no change needed — it is the model to copy.

### Part (b) — Wiki re-publish cron (de-dupe + fail-loud)
Resolve the two-cron conflict into ONE authoritative wiki re-publish, matching Josh's fail-loud standard.
- **Keep larry as the owner** of `daily-wiki-prep` (larry owns the wiki/briefs build per `feedback_briefs_to_website_not_telegram` + memory), **remove frank2's duplicate** `daily-wiki-prep` cron so they stop racing `.synthesis-state.json`.
- **Port frank2's fail-loud contract onto larry's cron**: change larry's `daily-wiki-prep` from `SILENT-OK if generated=0` to: run `wiki-synthesis.py --max-files 400`; if it exits non-zero, OR `generated==0` while the raw backlog is provably non-empty (compare against `.synthesis-state.json` unsynced count), route the error to **larry** (per `feedback_railway_alerts_route_to_larry` — larry investigates, Josh sees only diagnosis). Success stays SILENT-OK.
- **Keep the commit + `/tmp/wiki-new-articles.txt`** step (from frank2's version) so the morning brief "New Wiki Articles" section has real data. Route this into larry's cron. Do NOT `git push` from the cron — auto-sync handles commits (larry's existing constraint).
- These are **cron-prompt edits** in `~/.cortextos/cortextos1/.cortextOS/state/agents/{larry,frank2}/crons.json` via `cortextos bus add-cron/remove-cron` — no repo code. Mark as fleet-ops (see §4).

### Part (c) — Clearpath intel EXPORT + 768d re-embed  [SETUP ONLY — RUN IS JOSH-GATED]
Build the tool and document the exact command; DO NOT execute it.
- **New script `knowledge-base/scripts/export-clearpath-intel.py`** (standalone, mirrors the read-only Railway pattern in `reference_auditos_db_query_public_url`):
  - Connect read-only via Clearpath's `DATABASE_PUBLIC_URL` (from Clearpath Railway `railway variables --json`).
  - `SELECT id, org_id, fireflies_meeting_id, prompt_key, prompt_label, result, content_hash, impact_score, created_at FROM intelligence_extractions WHERE result IS NOT NULL AND status='completed'` (confirm the live "completed" status value at setup time).
  - Write each row as a markdown doc into a staging export dir `~/code/knowledge-sync/raw/areas/clearworks/clearpath-intel/<meeting>-<prompt_key>.md` with front-matter (source meeting id, prompt label, content_hash, date). Dedup on `content_hash`.
  - Emit a count report (rows found / files written / skipped-dup). Target ~2,700; assert the count is in a sane band and **stop** (don't silently write 4 files).
- **Re-embed** = reuse existing infra: once files are staged, `bus/kb-ingest.sh <dir> --org clearworksai --collection shared-clearworksai` runs MMRAG with the Gemini embedder (768d) already wired (`reference_kb_embeddings_gemini_not_openai`). No new embed code. Because part (a) lands first, this ingest is now fail-loud.
- **Re-enable nightly ingest**: after the export ingest is validated, confirm the memory/reconcile crons pick up the new `clearpath-intel/` dir (it's under `knowledge-sync/raw`, already in `kb-reconcile-nightly --roots`). No new cron required — the corpus just grows.
- The **actual export RUN and the ingest of ~2,700 rows are Josh-gated + staging-first** (§4).

### Part (d) — Port Clearpath deep intel-extraction in-house
Bring the extraction *logic* (not just exported rows) into cortextOS so future meetings get Clearpath-grade intel without Clearpath.
- **New skill `templates/*/.claude/skills/intel-extraction/SKILL.md`** describing the extraction: given a Fireflies transcript, run the prompt-key set (port Clearpath's `promptKey/promptLabel` catalog from `server/services/default-prompts.ts`) through the LLM, producing `result` blocks + `impactScore`, writing markdown docs into `knowledge-sync/raw/...` (same shape as part c's export, so the export and the ongoing pipeline converge on one format).
- **Wire into the existing crm `fireflies-ingest` cron** as an added step (upgrade, don't replace): after step 3 (action items), run intel-extraction on the transcript and drop the intel doc for the next kb-ingest. This reuses the cron that already pulls transcripts — no new polling.
- Keep this **additive and behind the export**: land parts a+b+c first; d is the largest and can follow. Do NOT rebuild the crm ingest wholesale (conflict-bomb risk) — add one step.

---

## 4. STAGING / PROD-OPS (Josh-gated, staging-first)

Per the Staging-First Protocol and `feedback_railway_alerts_route_to_larry`:

- **[JOSH-GATED] Clearpath intel export RUN (part c).** Reading Clearpath prod (read-only) is lower risk, but the **ingest of ~2,700 docs into `shared-clearworksai`** is a structural KB write. Validate on a staging/scratch collection first: `bus/kb-ingest.sh <exportdir> --collection scratch-clearpath-intel`, verify chunk counts + spot-check queries, THEN run against `shared-clearworksai`. Do not run either the export or the ingest until Josh gives the go. This spec plans the command; it does not execute it.
- **[JOSH-GATED / FLEET-OPS] Cron edits (part b).** Removing frank2's `daily-wiki-prep` and rewriting larry's is a live-fleet change. Do it via `cortextos bus remove-cron`/`add-cron` (no daemon restart needed — crons are daemon-managed), but confirm with Josh before mutating the running fleet's cron set. Verify with `cortextos bus list-crons` after.
- **[SAFE] Parts a + d code** land as a normal PR against fork/main (no prod data touched). The fail-loop change is behind an opt-in flag so it cannot regress existing callers.

---

## 5. FILES TO TOUCH (tight)

Code (PR-able, no prod data):
- `knowledge-base/scripts/mmrag.py` — `cmd_ingest` (+`sys.exit(1)` on errors under flag) and `p_ingest` parser (+`--json`, +`--fail-on-error`). ~15 lines, surgical.
- `bus/kb-ingest.sh` — pass `--fail-on-error` by default, add `--no-fail-on-error` escape.
- `knowledge-base/scripts/export-clearpath-intel.py` — NEW (part c setup).
- `templates/*/.claude/skills/intel-extraction/SKILL.md` + `templates/*/plugins/.../skills/knowledge-base/SKILL.md` note — NEW/edited (part d).
- `templates/agent/HEARTBEAT.md` (+ mirrored HEARTBEAT copies) — add fail-loud tail to Step 10 memory ingest.

Fleet-ops (not repo, Josh-gated):
- `~/.cortextos/cortextos1/.cortextOS/state/agents/larry/crons.json` — rewrite `daily-wiki-prep`.
- `~/.cortextos/cortextos1/.cortextOS/state/agents/frank2/crons.json` — remove `daily-wiki-prep`.

Explicitly NOT touching: `cmd_reconcile`, `cmd_query`, `cmd_deliver`, `cmd_reindex_indexes`, the Clearpath repo (read-only only), the crm ingest core (add one step, don't refactor).

---

## 6. TEST PLAN

Reuse the existing `knowledge-base/scripts/_test_clients/` harness (there's already `test_mmrag_*.py` + `fault_injection.py`).
- **New `test_mmrag_fail_loud.py`**: inject an embed failure via `fault_injection.py`, run `cmd_ingest --fail-on-error` on a dir where all files error → assert exit code == 1 AND `--json` output shows `"errored" > 0, "generated": 0`. Run WITHOUT the flag → assert exit 0 (proves no regression to existing callers). This is the direct regression test for the depletion-masking incident.
- **`--json` shape test**: happy path → `{"generated": N>0, "errored": 0}` and exit 0.
- **`bus/kb-ingest.sh` test**: shell test that a mmrag exit 1 propagates as wrapper exit 1 (and `--no-fail-on-error` yields 0).
- **export-clearpath-intel.py**: unit test against a fixture rowset (no live DB) — assert dedup on `content_hash`, correct front-matter, count-band assertion fires when rows < threshold.
- **Wiki cron**: dry-run larry's rewritten prompt against a seeded `.synthesis-state.json` with a known backlog → assert it would fire the larry-route on `generated==0`-with-backlog. (Manual/staged, not CI.)
- Proof of done: `npm run build` + `npm test` green; new pytest passes; `test_mmrag_fail_loud` fails on the CURRENT code (demonstrating it catches the real bug) and passes after the change.

---

## 7. RISKS + OPEN QUESTIONS

Risks:
- **Regression on existing callers** if `--fail-on-error` defaulted True. Mitigation: default False in mmrag; only `bus/kb-ingest.sh` opts in. The heartbeat memory-ingest goes through the wrapper, so it gets fail-loud without any per-agent edit.
- **Cron de-dup breaks the morning brief's "New Wiki Articles"** if the `/tmp/wiki-new-articles.txt` + commit step isn't carried from frank2 onto larry. Mitigation: explicitly port that step (§3b).
- **Export count wildly off** (schema/status drift). Mitigation: count-band assertion + staging collection first; never ingest into `shared-clearworksai` blind.
- **Two crons at 02:07 racing `.synthesis-state.json`** could already be corrupting synthesis state today. Removing the duplicate is a fix, not just cleanup.

Open questions for Josh:
1. Confirm the live `intelligence_extractions.status` value for "done" (`completed`? `active`?) before the export SELECT is finalized.
2. Is ~2,700 the right corpus, or filter by `impactScore`/`orgId` (only clearworksai, or all Clearpath orgs)? Affects export volume and KB relevance.
3. Part (d): should ported intel-extraction run inside the existing crm `fireflies-ingest` cron (my recommendation), or as a separate agent/cron? Confirms who owns meeting intel going forward.
4. On the wiki cron consolidation — keep larry as sole owner (my recommendation), or does frank2 need its narrower `raw/areas/clearworks` scope for a different reason?

---

## 8. EFFORT

- **Part (a) fail-loud ingest:** S — surgical, high-value, do first. Direct job (small PR), no full pipeline.
- **Part (b) wiki cron de-dup:** S — cron-prompt edits, fleet-ops, Josh-gated.
- **Part (c) export setup:** M — one new script + staged ingest; the RUN is Josh-gated, not built now.
- **Part (d) in-house extraction port:** L — needs the full M2C1 build pipeline (port prompt catalog, skill, wire into cron, tests). Land last, additive.

Overall: **a+b are S and shippable immediately; c is M (setup-only); d is the L that needs the sharded build.** Only part (d) warrants the full discovery→spec→build pipeline; a/b/c are direct jobs.

---

## PART (e) — RETRIEVAL-CORRECTNESS + INDEX INTEGRITY (added 2026-07-04, Josh: "this is how the whole project started — it needs to be fixed")

The origin failure (Logan Currie incident): an article was written to disk but the wiki `_index.md` was never regenerated, so it was invisible to the index; and retrieval surfaced a shallow SUMMARY doc instead of the raw source. Parts a–d make ingest/publish fail-loud but do NOT guarantee that what's on disk is discoverable or that queries return the real source. Part (e) closes that.

### Grounded current state
- `~/code/knowledge-sync/scripts/wiki-synthesis.py:166 build_slug_index()` enumerates on-disk `*.md` slugs (excluding `_`-prefixed) to skip already-written articles — but the script **never writes or regenerates `_index.md`/`_master-index.md`** (`INDEX_FILENAMES` at :34 is only used to SKIP them as sources). => index drifts from disk on every run. (knowledge-sync repo.)
- `knowledge-base/scripts/mmrag.py:3216 cmd_query` already supports `--docs`/`--parent` + `--full` → `_read_full_document` returns the raw source. But default mode returns ranked CHUNKS, so a summary chunk can outrank the source. No "prefer source doc" contract, no self-check. (cortextos repo.)
- `mmrag.py:2664 cmd_reconcile` detects `missing_from_disk` (chunks whose file is gone) but NOT the inverse — files on disk that are absent from the wiki index (the actual Logan Currie drift). (cortextos repo.)

### Design — split by repo (two clean PRs)

**e1 (cortextos repo — mmrag):**
1. **Index-drift detection in reconcile:** add an `--index-check <wiki_root>` mode (or extend the reconcile report) that walks the wiki dir, parses each dir's `_index.md`, and flags any on-disk non-`_` `.md` file NOT listed in its index. Emit `{indexed, on_disk, missing_from_index:[...]}` in the `--json` report. The nightly `kb-reconcile-nightly` cron already runs reconcile → it surfaces drift with no new cron. Fail-loud threshold: `missing_from_index > 0` is a WARN the cron routes to larry.
2. **Retrieval source-correctness:** add `mmrag.py verify-retrieval --collection <c> --expect-source <path> --query <q>` that runs the real query and asserts the given source file appears in `source_files`/`documents` (exit 1 if not). This is the regression guard for "query returned a summary, not the source." Also add a `--prefer-source` flag to `cmd_query` that boosts parent/source docs over derived-summary chunks (metadata `type != summary`), default OFF (no behavior change to existing callers).
3. Tests: `test_mmrag_index_check.py` (seed a wiki dir with a file missing from `_index.md` → assert it's flagged; add it → clean) and `test_mmrag_verify_retrieval.py` (fixture collection; expect-source present → exit 0, absent → exit 1).

**e2 (knowledge-sync repo — wiki index regeneration):**
1. Add `write_index(wiki_dir)` to `wiki-synthesis.py`: after articles are (re)written, deterministically regenerate each dir's `_index.md` from the on-disk `*.md` set (title from frontmatter/H1, relative link, sorted) so the index can NEVER drift from disk. Idempotent. Also refresh `_master-index.md` top-level.
2. Call it at the end of the synthesis run (both the per-area and full-corpus paths).
3. Test: run against a temp wiki dir with a new file → assert `_index.md` now lists it.
This is a separate knowledge-sync PR; keep it small and additive.

### Effort: e1 = S (mmrag surgical + tests), e2 = S (one function + call site). Both additive, no prod-data run.
