# WS9 — CRM Consolidation → ONE Canonical Store (the `crm` agent)

**Author:** architect (planning pass) · **Date:** 2026-07-04 · **Status:** SPEC — no code, no PR, no prod-ops.
**Repo:** `orgs/clearworksai/agents/crm` (the live crm agent) · verified against fork/main 2026-07-04.
**Framework:** one-big-feature. Three shards (a/b/c), each independently mergeable. See §8.

---

## 1. GOAL

Make the `crm` agent the single, trustworthy canonical store for entity identity (contacts / deals / orgs) so Josh can rely on the CRM as ground truth from his phone — the briefs board can never silently clobber it (a), Clearpath and crm engagements are linkable by one stable id (b), and every new-person signal (Fireflies / Omi / Gmail / calendar) lands through one write surface (c). This directly serves the governing goal (certainty + a reliable remote manager): today the CRM lies because the board overwrites edits and Clearpath drift is invisible.

---

## 2. GROUNDED CURRENT STATE (fork, today, with evidence)

### 2a. sync-board direction — PARTIAL fix already merged, NOT the flip WS9 wants
- `crm/sync-board.py` is a **reverse-sync**: it fetches `GET /api/crm/deals?token=` from the briefs board (`fetch_board_deals`, line 68) and writes the board's `stage` into `pipeline.json` (`reconcile_engagements`, lines 95-129).
- A per-engagement opt-in guard is **already live**: `if not next_engagement.get("crm_authoritative")` (sync-board.py:117). The `--crm-authoritative` flag exists on `upsert-engagement.py:46-50`. Tests exist at `crm/test_sync_board.py`.
- **The gap:** the guard is opt-in per deal. The DEFAULT for every non-flagged engagement is still "board wins, overwrite CRM stage every 15 min." Only a handful of deals were ever flagged. WS9(a) as Josh framed it ("the board NEVER overwrites the crm agent's pipeline.json") wants the **default inverted**: CRM stage is authoritative for ALL engagements; the board is a display/creation surface, not a stage writer.
- `archived` still syncs board→crm unconditionally (sync-board.py:125-127) — that is fine and should stay (the board is the place Josh archives).
- Cron: sync-board is invoked on the briefs side (the crm `config.json` crons do NOT run sync-board; it's a briefs/dashboard-side 15-min job hitting the deals endpoint — the reverse write into `pipeline.json` happens wherever this script is scheduled). The stealth-writer behavior is confirmed by memory `reference_sync_board_reverse_sync_reverts_reclass`.

### 2b. Clearpath ↔ crm link — DOES NOT EXIST
- `clearpath_id` in `pipeline.json` is a **local synthetic integer**, not a real Clearpath row id. Evidence: `next_clearpath_id()` (crm_connect_common.py:208-214) allocates `max + 1` locally; the MSIA record carries `clearpath_id:19` + `merged_from_clearpath_ids:[30]` where 30 is documented as "phantom … incorrectly stood up from a Fireflies sweep" (pipeline.json:4) — i.e. these ids are crm-internal, not Clearpath keys. `reference_stoss_landscape_is_a_deal` memory confirms `clearpath_id=30` is SYNTHETIC, not in Clearpath.
- There is **no Clearpath pull/push script anywhere** in the agent. `grep clearpath crm/*.py` returns only files that reference the local `clearpath_id` field; no HTTP client to Clearpath Postgres or API.
- The OCG engagement literally carries a `_clearpath_stage_divergence` note: *"Writeback required when API key available"* (pipeline.json:38-43). Confirms the crm agent has NEVER had a live Clearpath connection — divergence is tracked by hand.
- `contacts.json` last synced from Clearpath 2026-05-12 (roadmap `02-updated-workstreams.md:7`); 291 contacts vs Clearpath's 651. No `entity_id`, `clearpath_org_id`, or `clearpath_contact_id` field exists on any contact or engagement (`grep -o '"[a-z_]*id"'` on both files returns only `clearpath_id`, `intake_id`, `primary_contact_id`, contact `id`).
- **Josh's ruling (given):** the one-time mass contact BACKFILL is SKIP — only ~102 real delta, mostly junk. So (b) is a CODE task: add a canonical id + a push path, NOT a bulk import.

### 2c. New-person write surfaces — FRAGMENTED, no Omi
- Three independent ingest paths each call `upsert-contact.py` directly:
  - Fireflies: `fireflies-ingest` cron (config.json:45-49) → `crm/upsert-contact.py`.
  - Gmail: `comms-backfill.py` (piggybacked on the heartbeat cron, config.json:24) → `upsert(...)` shells to `upsert-contact.py:54-59`.
  - Calendar: `calendar-backfill.py` (heartbeat piggyback) → upsert-contact.
- **Omi is not wired at all** — no Omi ingest script exists in the agent (roadmap lists Omi people as a passive source, `02-updated-workstreams.md:6`; there IS an `omi` MCP available at the fleet level per the MCP server instructions, but the crm agent's `.mcp.json` only has filesystem+sequential-thinking, both disabled).
- `upsert-contact.py` is a solid canonical writer already: junk-name detection (lines 52-71), suppression list (`_ingest_suppression.json`, lines 34-49), atomic write (line 184), merge-unique on emails/phones/tags/source_refs. This is the right choke point — the fix is to route the missing surfaces (Omi) through it and to give it a stable canonical id, not to rewrite it.

### What's broken / missing (summary)
1. Board silently reverts CRM stage for all non-flagged deals (default is wrong).
2. No stable id linking a crm engagement/contact to its Clearpath counterpart; drift is invisible and hand-tracked.
3. No Clearpath→crm push on contact/deal events.
4. Omi new-person signal never reaches the CRM.

---

## 3. DESIGN (concrete, minimal, reuse existing infra)

Three shards. Each is small, additive, independently shippable. **No broad refactor** — that is the conflict-bomb failure mode called out in the roadmap.

### Shard A — Flip sync-board to CRM-authoritative-by-DEFAULT
The bus-authoritative pattern (same family as WS1): the local store owns the truth; the remote surface may create and may archive, but may not overwrite stage.

- In `reconcile_engagements()` (`crm/sync-board.py`), **invert the default**. Replace the per-engagement `crm_authoritative` opt-in with a store-level policy:
  - Add an env/flag `SYNC_BOARD_STAGE_MODE` with values `crm_authoritative` (new default) | `board_authoritative` (legacy escape hatch).
  - When mode is `crm_authoritative` (default): the board `stage` is NEVER written into `pipeline.json`. The stage-overwrite block (lines 118-123) is skipped for every engagement. Keep the existing per-engagement `crm_authoritative:true` honored too (belt-and-suspenders; already-flagged deals behave identically).
  - `archived` sync (lines 125-127) stays unconditional in both modes.
- Add an **inverse forward-note** so the board isn't left showing stale stages: since sync-board runs on the briefs side and only READS the deals endpoint, the cleanest minimal move is to have sync-board, when it detects a board/crm stage divergence in crm-authoritative mode, **log the divergence** (structured `print(json.dumps({"divergence":[...]}))`) rather than silently drop it. This gives Josh a receipt ("board says X, CRM says Y") without a write. A true forward-sync (push CRM stage UP to the dashboard) is OUT of scope here and owned by the dashboard/briefs team (noted in the existing spec's Out-of-scope, `sync-board-crm-authoritative-override.md:64-69`); flag it as an open question (§7).
- Function to change: `reconcile_engagements` only. No signature change to `sync_board`; thread `stage_mode` through as a keyword with the new default. `main()` reads `os.environ.get("SYNC_BOARD_STAGE_MODE", "crm_authoritative")`.

### Shard B — Canonical ENTITY id + Clearpath→crm push
Give every contact and engagement a stable cross-system id so crm and Clearpath can be linked without a mass backfill.

- **Canonical id field.** Add `entity_id` (a stable, crm-owned UUID/slug) to the contact and engagement schemas. Keep `clearpath_id` (synthetic int) untouched for backward compat. Add optional `clearpath_ref` = `{ "contact_id": "<clearpath uuid>", "org_id": "<clearpath org uuid>", "synced_at": "<iso>" }` — populated ONLY when a real Clearpath link is established, null otherwise. This is the "one place for entity identity" the roadmap asks for (`02-updated-workstreams.md:29`).
  - Add helper `ensure_entity_id(record)` in `crm_connect_common.py` (mint if absent, idempotent). Call it from `upsert-contact.py` (contact create path, line 137) and `reconcile-intake.py` `build_engagement` (line 93).
  - Document all three new fields in `crm/schema.md` §"Engagement schema additions" + a new §"Contact identity" — change-control requires the doc update in the same commit (schema.md:128-135).
- **Clearpath→crm push (event-driven, thin).** Add `crm/clearpath-push.py` — a small, read-only-against-Clearpath, write-only-into-crm reconciler that:
  - Takes a Clearpath contact/deal event payload (from a Clearpath webhook or a pull cursor — see §7 open q on which Clearpath exposes) with `{ clearpath_contact_id, clearpath_org_id, name, email, company, stage?, value? }`.
  - Matches to an existing crm contact by email (primary) then normalized name (fallback) using the existing `_norm` + `contacts_index` helpers.
  - If matched: stamp `clearpath_ref` on the crm record (link only — does NOT overwrite crm-owned fields; Clearpath is a SOURCE not an authority for stage, mirroring Shard A's posture).
  - If unmatched AND not suppressed: route through `upsert-contact.py` (single write surface, Shard C) with `--source-ref clearpath:<id>`.
  - Idempotent: re-running with the same event is a no-op (dedupe on `clearpath_ref.contact_id`).
  - **No mass backfill** (Josh ruling). This handles go-forward events + the ~102 real deltas trickle in naturally as they generate events. A `--dry-run` prints what WOULD link/create without writing.
- Query path for Clearpath data: use the read-only public URL pattern already documented (`reference_auditos_db_query_public_url` is the AuditOS analogue; Clearpath's equivalent is its Railway `DATABASE_PUBLIC_URL` / an intelligence MCP). Confirm the exact reachable surface before implementing (§7).

### Shard C — Single write surface for new-person events (add Omi; keep the rest)
- `upsert-contact.py` is already the canonical writer. Formalize it as THE only contact-creation entry point:
  - Add `crm/omi-ingest.py` — pulls new Omi "people"/memories (via the fleet `omi` MCP: `get_memories` / `search_memories`), extracts person name/email/context, routes each through `upsert-contact.py` with `--source-ref omi:<memory_id>`, and logs an interaction via `add-interaction.py`. Mirror the shape of `fireflies-ingest.py` (dedupe file `ingested-omi.txt`, `--mark`, idempotent).
  - Wire a `omi-ingest` cron into `crm/config.json` crons (2h interval, SILENT-OK, no-Telegram — match the fireflies-ingest cron block, config.json:45-49).
  - Leave Fireflies / Gmail / calendar paths as-is (they already funnel through `upsert-contact.py`). The consolidation is: assert in `schema.md` that `upsert-contact.py` is the SOLE sanctioned contact writer and every ingest path MUST go through it (no direct `contacts.json` writes). Add a one-line lint/test that greps ingest scripts for direct `contacts.json` writes and fails if any bypass the helper.

---

## 4. STAGING / PROD-OPS (Josh-gated, staging-first)

Per the staging-first protocol, anything that touches the live pipeline/contacts data or the running crm agent:

- **[Josh-gated]** Enabling the `omi-ingest` cron in the live crm `config.json` = a running-fleet change. Requires the daemon to pick up the new cron. Gate: Josh sign-off + verify the cron fires once and is SILENT-OK before trusting it. Do NOT hot-edit live config; ship via PR then reload.
- **[Josh-gated + staging-first]** First run of `clearpath-push.py` against real Clearpath data + live `contacts.json`: run `--dry-run` first, review the WOULD-link/create counts, run against a COPY of contacts.json, diff, and only then apply. This writes into the canonical store — treat like any dedup/ingest op. Never point it at prod contacts.json on the first live run.
- **[Not prod-ops]** Shard A + the `entity_id` minting are pure code + the id is stamped lazily on next write; no bulk mutation. Shipping Shard A does NOT require a data migration (existing flagged deals already behave; unflagged ones simply stop being overwritten). This is the safe, high-value first merge.
- **Explicitly NOT in scope (Josh ruling):** the one-time mass contact backfill from Clearpath's 651. Do not plan or run it.

---

## 5. FILES TO TOUCH (tight)

Shard A:
- `orgs/clearworksai/agents/crm/crm/sync-board.py` — invert default in `reconcile_engagements` + `stage_mode` kwarg + divergence log.
- `orgs/clearworksai/agents/crm/crm/test_sync_board.py` — new default-mode tests.

Shard B:
- `orgs/clearworksai/agents/crm/crm/crm_connect_common.py` — `ensure_entity_id` + `clearpath_ref` helpers.
- `orgs/clearworksai/agents/crm/crm/upsert-contact.py` — mint `entity_id` on create.
- `orgs/clearworksai/agents/crm/crm/reconcile-intake.py` — mint `entity_id` in `build_engagement`.
- `orgs/clearworksai/agents/crm/crm/clearpath-push.py` — NEW, thin push/link reconciler.
- `orgs/clearworksai/agents/crm/crm/schema.md` — document `entity_id`, `clearpath_ref`, sole-writer rule.

Shard C:
- `orgs/clearworksai/agents/crm/crm/omi-ingest.py` — NEW.
- `orgs/clearworksai/agents/crm/config.json` — new `omi-ingest` cron block.
- Tests: `test_clearpath_push.py`, `test_omi_ingest.py`, `test_entity_id.py` (beside the scripts, importlib pattern per `02-master-plan.md:41`).

Do NOT touch: the briefs/dashboard repo (forward-sync is out of scope), the 12+ `.claude/worktrees/**/agentic-crm-assistant/crm` copies (those are stale worktree snapshots, not the live agent — the live agent is `orgs/clearworksai/agents/crm/`).

---

## 6. TEST PLAN

Follow the existing beside-the-script importlib pattern (`test_sync_board.py`, `test_reconcile_intake.py`); run `python3 -m pytest -q` from `crm/`.

Shard A (`test_sync_board.py`):
- Default mode (`crm_authoritative`): board stage differs from CRM stage → stage NOT changed, `changed`==0 for stage; a divergence is logged.
- Default mode: `archived:true` on board → still applied (unconditional).
- Escape hatch `board_authoritative`: board stage differs → reverts (legacy behavior preserved).
- Regression: existing per-engagement `crm_authoritative:true` case still passes.

Shard B:
- `ensure_entity_id`: absent → mints; present → unchanged (idempotent).
- `upsert-contact.py` create path stamps `entity_id`; re-upsert does not change it.
- `clearpath-push.py`: matched-by-email → stamps `clearpath_ref`, does NOT overwrite crm stage/name; unmatched → routes to upsert-contact; re-run same event → no-op; `--dry-run` writes nothing.

Shard C:
- `omi-ingest.py`: new Omi person → one upsert-contact call + one interaction; `--mark`ed id skipped on re-run.
- Sole-writer lint: a script writing `contacts.json` directly (not via helper) fails the check.
- Regression: full existing crm test suite green (`test_sync_board`, `test_reconcile_intake`, `test_build_company_*`).

Proof it works: after Shard A, a simulated 15-min board sync with a divergent stage leaves `pipeline.json` stage untouched and emits a divergence receipt — the exact bug (`reference_sync_board_reverse_sync_reverts_reclass`) can no longer recur by default.

---

## 7. RISKS + OPEN QUESTIONS FOR JOSH

**Risks**
- *Board shows stale stage after the flip.* Once CRM is authoritative and we don't push stage UP, the dashboard deal card can display an older stage than the CRM. Mitigation: the divergence log gives a receipt; the real fix (forward-sync CRM→board) is a follow-up the dashboard team owns. Flagged, not silently accepted.
- *entity_id churn.* Minting lazily on next write means records touched later get ids at different times — fine (idempotent, no ordering dependency), but the store won't be 100% id-covered until every record is touched once. Acceptable; avoids a bulk migration Josh didn't ask for.
- *Omi MCP availability in the crm agent runtime.* The `omi` MCP is a fleet-level server; the crm agent's `.mcp.json` currently disables its two servers. Need to confirm the crm agent can actually reach the `omi` MCP (or call it via a bus/helper) before Shard C ships.

**Open questions**
1. **Clearpath surface for the push:** does Clearpath expose a webhook on contact/deal events, or do we pull on a cursor from its Postgres public URL / an intelligence MCP? This decides whether `clearpath-push.py` is event-driven or a polling cron. (The `deal-enrichment` cron already calls `mcp__clearpath-intelligence__get_contact_intelligence` with `org_id 0ce7b73b-...` — so an intelligence MCP link exists; is that the same surface we push through?)
2. **Forward-sync CRM→board:** do you want the dashboard to reflect CRM stage (a small forward-sync the briefs team builds), or is a divergence receipt to you enough for now? WS9 as written only guarantees "board can't clobber CRM"; showing CRM stage on the board is the natural next step but not in this scope.
3. **`entity_id` format:** UUID (opaque, safe) vs a readable slug derived from name/email (greppable, but collides/changes)? Recommend UUID for stability; confirm.
4. **Merge order of the three shards:** Shard A is the safe, highest-value, no-data-migration first merge (kills the daily clobber bug). B and C follow. Confirm you want A shipped independently first.

---

## 8. EFFORT + PIPELINE

- **Shard A:** S. ~15 lines + tests, no data migration, no prod-op. Ship first, independently. Near-direct job (it extends an already-reviewed spec).
- **Shard B:** M. New `clearpath-push.py` + schema change + id helper; blocked on open question 1 (Clearpath surface). Needs the build pipeline (spec→review→build) because it introduces a new external-system integration and a schema change under change-control.
- **Shard C:** M. New `omi-ingest.py` + cron + sole-writer lint; blocked on confirming Omi MCP reachability from the crm runtime. Full pipeline.

**Overall: M**, and it **needs the full build pipeline** — but Shard A can be split out as a small direct job merged ahead of B/C. Recommended sequence: A (now, safe) → B → C, each one cortextos PR, no broad refactor.
