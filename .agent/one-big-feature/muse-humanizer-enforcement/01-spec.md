# Spec — Muse Humanizer Enforcement Hook

**Author:** Larry · **Date:** 2026-06-10 · **Status:** SPEC v2 (post architect adversarial review — SPEC_PASS pending Josh)
**Revision note:** v2 folds in architect review R1–R4 (blocking) + S2/S3 + ledger versioning. The byte-level hash contract is now pinned; this is the part v1 left ambiguous and the part Codex must implement exactly.
**Slug:** `muse-humanizer-enforcement` · **Repo:** `/Users/joshweiss/code/cortextos`
**Requested by:** Josh (relayed via crm, task `task_1781068445730_25215347`)

## Josh's exact request

> "look at what muse sends me every day none of it sounds like me or like clearworks."

the-humanizer skill is now universal (canonical `orgs/clearworksai/skills/the-humanizer/`, symlinked into every agent, soft rule appended to each AGENTS.md). The soft rule (`muse/AGENTS.md:538`) is skippable. Josh wants a **hard hook on Muse** that enforces the humanizer pass on every external-facing draft before it leaves Muse.

## Problem framing

A cortextOS agent is a Claude Code session. Crons inject prompts; the session emits via tool calls. The only deterministic enforcement layer is a **PreToolUse hook** in `muse/.claude/settings.json` (same contract as Larry's `gate-codexer-planning.sh`: stdin JSON → `.tool_name` / `.tool_input`; block via `{"decision":"block","reason":...}`; `exit 0` allows).

A bash hook cannot itself run a Claude skill (skills execute inside the model's agentic loop). So enforcement is **verify-and-gate**, not rewrite: the humanizer skill records that a specific piece of content passed; the hook checks that record before letting the content leave.

---

## 1. Hook trigger — the catch-all enforcement point

A single PreToolUse hook (`enforce-humanizer.sh`) matching **Bash, Write, Edit**. It classifies each call by **sink** (where the content is going), not by guessing intent. External sinks for Muse:

| # | Sink | How Muse emits it | Detection in hook |
|---|------|-------------------|-------------------|
| A | Telegram to Josh | `cortextos bus send-telegram <josh_chat> '<text>'` (Bash) | `tool_input.command` matches `bus send-telegram`; content = the message arg |
| B | LinkedIn queue | `scripts/enqueue-post.py --text/--file` (Bash) **or** Write/Edit to `*/memory/post-queue.json` / `*/queue/posts.json` | command match OR `tool_input.file_path` match; content = `--text` value / `--file` contents / queue `text` fields |
| C | LinkedIn live post | `scripts/process-posts.py` (auto-post cron drainer) | command match — see §note-drainer |
| D | Newsletter / blog / proposal drafts | Write/Edit to a content-draft path (`muse/memory/drafts/**`, `muse/queue/**`, or any `*.md` Muse marks as outbound copy) | `tool_input.file_path` under the content-draft globs |
| E | Brief publish | `publish-brief.py` / `publish_wiki.py` (Bash) | command match |

Everything not matching A–E falls through to `exit 0` (allow). This is an **allowlist-of-sinks** model: new external channels must be added explicitly, but the common four (Telegram content, LinkedIn, drafts, brief) are covered day one.

**§note-drainer:** `process-posts.py` only drains entries already gated at enqueue time (sink B). It is **exempted from the hook** to avoid double-gating, but gets a cheap defense-in-depth check inside the script itself (see §3 belt-and-suspenders) so it refuses to post any queue entry not stamped `humanized:true`.

## 2. Hook check — did this content go through the humanizer?  *(v2: byte contract pinned — R1, R2)*

**Signal: a content-hash ledger** written by the skill, checked by the hook. Channel-agnostic — one mechanism covers Telegram, queue, file, brief without per-sink schema.

### 2a. The canonical hash contract (R2 — the single highest-risk decision; both sides MUST agree byte-for-byte)

The hash is computed over **one and only one thing: the fully Unicode-decoded `text` string of the content** — never the raw Bash command line, never a queue entry as JSON, never `text_preview`, never image paths or notes. The `—` em-dash stored in `post-queue.json` decodes to the 3-byte UTF-8 `—`; the model drafting prose holds the same `—`; they only match if **both sides decode through the same parser**.

Canonical normalization (ONE shared Python function, `lib_normalize.py`, imported by skill-emit helper, hook, `enqueue-post.py`, and `process-posts.py` — NOT reimplemented in bash; a bash `sha256` of a shell variable diverges from Python's string on the first non-ASCII byte):

```python
import unicodedata, hashlib, re
def humanizer_hash(text: str) -> str:
    s = unicodedata.normalize('NFC', text)        # precomposed vs combining cannot diverge
    s = re.sub(r'\s+', ' ', s).strip()            # collapse all whitespace runs, trim ends
    return hashlib.sha256(s.encode('utf-8')).hexdigest()   # no case-fold: case variants must not pass
```

Both sides obtain `text` via a **parser**, never the command line:
- LinkedIn (sink B): hook reads the decoded `--file` contents or the `--text` value *after* Python `argparse`/decode — the spec REQUIRES LinkedIn content arrive via `enqueue-post.py` (which decodes), so the hook hashes the same decoded string. Direct `Write` to `post-queue.json` is hashed over the decoded `text` field via `json.load`.
- Telegram (sink A): the hook hashes the decoded message payload extracted from `tool_input` (JSON-parsed, already Unicode-decoded by `jq`/Python), not the raw shell token.

### 2b. Ordering — the skill hashes the FINAL string, in the same turn it emits (R1)

The chicken-and-egg killer: the ledger line must exist *before* the emit, and must hash *the exact bytes that get emitted* — not the prose as it appeared mid-draft. So:

- **Skill Step 4.5 (Component 1):** immediately after self-check passes AND immediately before handing text to the emit tool call, in the **same turn**, the skill computes `humanizer_hash(final_text)` and appends one line to `$CTX_AGENT_DIR/state/humanizer-ledger.jsonl`:
  ```json
  {"v":1,"hash":"<humanizer_hash(final_text)>","channel":"telegram|linkedin|newsletter|blog|brief|email","ts":"<iso8601>","agent":"<CTX_AGENT_NAME>"}
  ```
  `"v":1` = ledger schema version (future format changes can't silently break other agents that adopt the hook). `$CTX_AGENT_DIR` keeps the **shared** skill agent-generic. Mirror to bus for Josh-visible audit: `cortextos bus log-event content humanizer_pass info --meta '{"hash":...,"channel":...,"agent":...}'`.
- **`enqueue-post.py` is the source of truth for LinkedIn (R1):** it computes `humanized_hash = humanizer_hash(text)` itself and stamps it on the queue entry (NOT a session-supplied value, NOT an unconditional boolean). The entry carries `humanized_hash` with it.
- **Hook side:** `humanizer_hash(outgoing_text)`, search ledger lines within retention for a matching `hash`. Match → allow. No match → fail action (§3).

### 2c. Retention (S2)

Ledger lookup is by hash with no tight line cap (jsonl grep of a few thousand lines is trivial). Retention window = **max(30 days, longest `scheduled_for` horizon in the queue)**. A post humanized days before its scheduled fire MUST still find its ledger line — 7 days was too tight and would block the first scheduled post at cron time (no humanizer session to recover).

**Brittleness note:** any post-humanizer edit changes the hash → re-block → forces re-humanization. **Intended** — an edited draft is an unverified draft.

## 3. Action on fail — recommendation: **(a) BLOCK + bus log error**

Reject option (b) inline-rewrite. Reasoning:

1. **A PreToolUse bash hook cannot invoke a Claude skill.** "Run the humanizer inline" would mean spawning a headless `claude -p` session from the hook — slow (blocks the tool call up to the hook timeout), itself failure-prone, runs **outside** the originating session's context (no access to the brief, the calendar entry, the thread it was drafting), and doubles model spend. The rewritten text would also bypass the session's own learning loop, so Muse never improves.
2. **Block returns a structured reason the model consumes.** The block reason instructs Muse to invoke `the-humanizer` skill on *this exact content* (with full session context) and retry. Deterministic, fast, and it trains the behavior instead of silently laundering it.
3. **Unifies with the §5 fallback posture** (default-deny). One predictable code path for every failure mode.

Option (b)'s "better UX" is illusory here: the better UX is the model doing it right in-context on the retry, which block-and-instruct produces.

**On block:** emit `cortextos bus log-event content humanizer_block warn --meta '{"channel":...,"reason":...}'` so Josh sees every gated send. Block reason text lists the §6 reference files and the one-line instruction: *"Invoke the-humanizer skill on this content, then resend."*

**Belt-and-suspenders (sink C) — real hash check, not a boolean (R1):** `process-posts.py` is a cron subprocess the PreToolUse hook never sees (it is not a tool call in Muse's session). So the LinkedIn live-post guard lives *inside the script*: before posting, recompute `humanizer_hash(post['text'])` and require it equals the stored `post['humanized_hash']`; on mismatch/absent, **skip + log** `humanizer_block` and do not post. A boolean flag anyone can set proves nothing — the stored hash, recomputed against the actual text at post time, does. This is the only enforcement at sink C (the hook cannot reach it).

## 4. Scope — external-only channel filter (explicit)

**ENFORCE (gate):** sinks A–E in §1.

**NEVER ENFORCE (always `exit 0`):**
- `cortextos bus send-message <agent> ...` — inter-agent bus traffic.
- `cortextos bus log-event ...`, `update-task`, `create-task`, heartbeat writes.
- Write/Edit to `memory/**`, `state/**`, `*.json` config, `MEMORY*.md`, daily-memory files.
- Reads, `git`, test/build commands, all non-emit Bash.

**Hook evaluation order is fixed (R4) — pin it so a missing ref file never deadlocks ops status:**
1. **Classify sink.** Not A–E → `exit 0` (allow) immediately.
2. **Telegram (sink A) only:** run the ops-vs-content discriminator. Ops ping → `exit 0` immediately (BEFORE any ref-precondition or ledger check).
3. **Humanizer escape hatch (R3):** any send whose payload carries the hook's own sentinel `[humanizer]` (block/error notices the hook itself tells Muse to relay) → `exit 0`. The system must always be able to tell Josh "I'm blocked."
4. **Content sinks only:** run §6 ref-precondition, then §2 ledger check, then §3 action.

**Telegram ops-vs-content discriminator (A is dual-use).** Status pings and content drafts share Josh's chat. Filter:
- **Pass-through** if operational: length ≤ 280 chars **AND** matches the ops allowlist regex (`booting|restart|context window full|approval needed|^OK$|^back |online|heartbeat|^ack|will be back|crash`).
- **Gate** otherwise (multi-paragraph, > 280 chars, content-shaped). Daily content suggestions — exactly what Josh complained about — are long-form and land in the gated path.
- Known residual (accepted for v1, architect S1): a short status line containing an ops keyword can slip through as ops, and a long *session-issued* status summary with no ops keyword can be gated. The LinkedIn post body — the thing Josh actually complained about — is gated at sink B **independent of Telegram**, so the discriminator failing open on a status line does not leak a post. **Fast-follow (v1.1):** instruct Muse in AGENTS.md to wrap genuine content sends in an explicit marker so anything *without* it is treated as ops. The R3 circuit breaker (below) guarantees a misfire can't loop.

## 5. Fallback — default-deny

Only a **verified ledger hash** lets external content out. Every failure mode converges on block:
- Skill skipped → no ledger line → no hash match → **block**.
- Skill errored / model error → no ledger line → **block**.
- References unreachable → **block** (explicit precondition, below).
- Ledger unwritten / unreadable → no match → **block**.

**Precondition ref-check (content path only — R4):** for **content sinks only** (after step 2 of the §4 order has already let ops pings through), the hook verifies the four §6 files exist and are readable. Any missing/unreachable → block "humanizer references unreachable: `<path>`" + `log-event content humanizer_refs_unreachable error`. A missing ref blocks *content*, never *ops status* — so a rotated voice-sample filename can't brick Muse's ability to say "I'm online."

**Escape hatch (R3):** the hook's own block/error notifications carry the `[humanizer]` sentinel and are never gated (§4 order step 3), so a humanizer failure is always visible to Josh rather than silently swallowed.

**Circuit breaker (R3) — fail-closed on leakage, NOT into an infinite silent loop:** the hook tracks consecutive blocks of the same content hash in `$CTX_AGENT_DIR/state/humanizer-breaker.json`. After **N=3** consecutive blocks of the same hash within **M=30 min**, the hook **allows-with-loud-audit** (`log-event content humanizer_breaker_open error` + a `[humanizer]` Telegram to Josh naming the channel + a content preview) rather than re-blocking forever. Rationale: blocking raw content from leaking is right; blocking a cron into an endless silent retry that sends Josh nothing is its own failure. Breaker counters reset on any successful (ledgered) send. N/M are tunable constants at the top of the hook.

Net posture: **fail-closed on content, fail-loud on deadlock.** Raw Muse output never reaches an external reader without a verified pass *except* the explicit breaker path, which is loudly audited to Josh. Every block and every breaker-open is a visible bus event.

## 6. Reference files the hook guarantees are loadable

The hook precondition-checks (existence + readability) and re-lists these in every block reason; the skill's Step 0 does the actual loading:
- `~/code/knowledge-sync/raw/resources/brand/josh-voice-prompt.md`
- `~/code/knowledge-sync/raw/resources/brand/josh-voice-sample-blank-page-2026-06-09.md`
- `~/code/knowledge-sync/raw/areas/clearworks/muse-blog-voice-template.md`
- `~/code/cortextos/orgs/clearworksai/skills/the-humanizer/reference-full.md`

---

## Files this feature touches (for codexer)

1. **NEW** `orgs/clearworksai/agents/muse/.claude/hooks/enforce-humanizer.sh` — the PreToolUse hook (Bash/Write/Edit). Reuses Larry's hook I/O pattern. Evaluation order pinned per §4. Shells `lib_normalize.py` to hash (never bash sha256 of a shell var — R2). Implements escape hatch + circuit breaker (§5).
2. **NEW** `orgs/clearworksai/agents/muse/scripts/lib_normalize.py` — the single shared `humanizer_hash(text)` (NFC + collapse-ws + trim + sha256, §2a). Imported by `enqueue-post.py` and `process-posts.py`; invoked by the hook as `python3 lib_normalize.py <<<"$content"`. **One implementation, Python only** (R2 — a bash reimpl diverges on the first non-ASCII byte, e.g. the `—` em-dash).
3. **EDIT** `orgs/clearworksai/agents/muse/.claude/settings.json` — wire the hook as the **first** PreToolUse entry for `Bash`, `Write`, `Edit` (preserve existing `AskUserQuestion` entry).
4. **EDIT** `orgs/clearworksai/skills/the-humanizer/SKILL.md` — add Step 4.5: in the **same turn as emit**, hash the final string via `lib_normalize` and append the versioned ledger line (`"v":1`) to `$CTX_AGENT_DIR/state/humanizer-ledger.jsonl` + bus audit event. Agent-generic via `$CTX_AGENT_DIR`/`$CTX_AGENT_NAME` (R1, ledger versioning).
5. **EDIT** `orgs/clearworksai/agents/muse/scripts/enqueue-post.py` — compute `humanized_hash = humanizer_hash(text)` itself (source of truth) and stamp it on the queue entry alongside `humanized: true`. Import `lib_normalize` (R1/R2).
6. **EDIT** `orgs/clearworksai/agents/muse/scripts/process-posts.py` — before each live post, recompute `humanizer_hash(post['text'])` and require equality with stored `post['humanized_hash']`; on mismatch/absent → skip + `log-event humanizer_block` (R1; this is the only enforcement at sink C). Note `process-posts.py` sends its own status Telegram via `subprocess.run` — those are NOT session tool calls and are NOT hook-governed.
7. **GATE check on sink list (S3):** `linkedin-post.py` is directly executable and is the real API caller — add it to the hook's gated command set (or assert in tests that direct invocation outside `process-posts.py` is blocked). Loose draft `.txt` files in `scripts/` are gated **at emit**, never at draft-write — the hook must NOT gate every `.txt` Write (would break unrelated tooling).
8. **TESTS** — `tests/` (python, env-clean per `feedback_cortextos_test_env_clean_first`): ops-ping pass-through; `[humanizer]` escape-hatch pass-through; content-send block-when-unledgered; allow-when-ledgered (incl. an em-dash/emoji unicode case proving skill-hash == hook-hash — R2 regression); refs-unreachable blocks content but NOT ops; inter-agent `send-message` pass-through; queue-write gating; `enqueue-post.py` hash stamp; `process-posts.py` hash-mismatch skip; circuit-breaker opens after N blocks and audits.

## Out of scope (v1)
- Rolling the hook out to other agents (Muse-only per Josh's ask; skill change is already universal).
- The AGENTS.md content-marker hardening (fast-follow).
- Inline auto-rewrite (explicitly rejected, §3).

## Open questions — RESOLVED by architect adversarial review (2026-06-10)
1. **Content-hash ledger right signal?** Yes — but the byte contract was the gap. Pinned in §2a (NFC-decoded `text` field, one shared Python `humanizer_hash`, never the raw command line). This was the `—` divergence the review caught.
2. **Telegram heuristic robust for v1?** Acceptable for v1 *because the LinkedIn body is gated at sink B independent of Telegram*. AGENTS.md content-marker is the v1.1 hardening; R3 circuit breaker prevents any misfire from looping.
3. **Retention?** 30 days / by-hash lookup (not 7 / line-capped) — scheduled posts humanize days ahead. §2c.
4. **post-queue.json double-gate?** Pick one boundary: gate at the **enqueue** (`enqueue-post.py` computes hash as source of truth); `process-posts.py` (the drainer) verifies hash equality in-script since the hook can't see a cron subprocess. §3 belt-and-suspenders + §1 §note-drainer.

**Architect verdict:** SPEC_FAIL on v1 → all four blocking changes (R1 hash ordering, R2 normalization, R3 escape-hatch+breaker, R4 eval order) folded into this v2 → **SPEC_PASS**. Suggested S1/S2/S3 + ledger versioning also incorporated.
