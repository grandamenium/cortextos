# Master Plan — Muse Humanizer Enforcement

**Slug:** `muse-humanizer-enforcement` · **Framework:** one-big-feature · **Repo:** `/Users/joshweiss/code/cortextos`
**Status:** SPEC_PASS (architect-reviewed v2) — awaiting Josh SCOPE_VALIDATION before codexer dispatch.

## Goal
A hard PreToolUse hook on Muse that fails-closed: no external-facing draft leaves Muse without a verified the-humanizer pass. Source of truth = full spec `01-spec.md`.

## Why one-big-feature (not M2C1)
Single cohesive feature, single repo (`cortextos`), no schema migration, no new repo. The shared-skill edit is purely additive + agent-generic (writes to `$CTX_AGENT_DIR/state/`, no cross-agent coupling) and is ledger-versioned (`"v":1`) so it stays a clean contract, not an unversioned multi-agent dependency. Architect concurred.

## Approach (verify-and-gate, fail-closed)
1. Skill records a content-hash ledger line on pass, in the same turn it emits (`01-spec.md` §2b).
2. Hook hashes outgoing external content via the shared Python `humanizer_hash`, checks the ledger, blocks on miss (`§2a`, `§3`).
3. Eval order pinned so ops/status pings and the hook's own `[humanizer]` notices are never gated (`§4`); circuit breaker prevents silent loops (`§5`).

## Phases
- **P1 — Shared hash lib + skill ledger emit.** `lib_normalize.py`; SKILL.md Step 4.5. Gate of everything else.
- **P2 — The hook.** `enforce-humanizer.sh` (classify→ops→escape→content: ref-precondition→ledger→action), wire into `settings.json` first.
- **P3 — LinkedIn sink hardening.** `enqueue-post.py` stamps real `humanized_hash`; `process-posts.py` verifies hash equality at post time.
- **P4 — Tests.** Python, env-clean. The unicode (em-dash/emoji) skill==hook hash regression is the must-have (R2). Plus ops pass-through, escape hatch, unledgered block, refs-block-content-not-ops, send-message pass-through, breaker-opens.

## Acceptance
- A long content Telegram with no ledger line → blocked + `humanizer_block` bus event.
- Same content after a humanizer pass → allowed.
- Operational ping ("back —", "online", < 280 + ops keyword) → never blocked.
- `send-message` to another agent → never blocked.
- A queue entry whose `humanized_hash` doesn't match its `text` → `process-posts.py` skips it.
- Missing reference file → content blocked, ops still flows.
- 3 consecutive blocks of one hash in 30 min → breaker opens, loud audit to Josh, no silent loop.
- Full test suite green; `npm run build`/relevant checks clean.

## Risks
- **Hash divergence** (R2) — mitigated by single Python impl + unicode regression test. Highest risk.
- **Telegram heuristic false-neg** — bounded; LinkedIn body gated independently; v1.1 AGENTS.md marker.
- **Deadline** — must be live before Muse's next content cron (tomorrow AM); P1+P2 are the critical path.

## Process gate
Codexer dispatch will carry: `GATE: build framework=one-big-feature slug=muse-humanizer-enforcement repo=/Users/joshweiss/code/cortextos`. Diff returns to Larry for adversarial build-review (scope match, no `any`/`console.log`, tests present, fail-closed verified) before any PR.
