# Theta-Wave Cycle-19 Phase 7 Actuation-Integrity Test Spec Draft

**Cycle fired:** 2026-05-13 05:56Z (24h cadence)
**Phase 6 closed:** 06:02Z May 13 (3-round async w/ boss)
**Bundle locked for AM brief:** 12:03Z May 13
**Author:** Jerry (analyst)

---

## Locked Spine

**FLEET-LEVEL RECONCILIATION GAP.** Consumer-side check assumes a producer-side write that didn't happen, happened wrong, or was killed-by-intent. Graduates to parent-class status with n=4 sub-vectors.

### Sub-Vectors (n=4)

| Vector | Producer Behavior | Consumer Phantom | Source-Type |
|--------|-------------------|------------------|-------------|
| A. Cron-fire gap | Daemon fires cron but doesn't auto-stamp; convention-enforced prompt-side stamping inconsistent | check-approvals reads stale fire-stamp, alerts on phantom-gap | Single-source missing-data |
| B. Cycle config persist | manage-cycle create executes cron-add but cycle definition write to experiments/config.json drops (linter/merge/race) | other agents read experiments/config.json, treat as authoritative, downstream cycle dispatch fails silently | Single-source missing-data |
| C. Cloud-session heartbeat skip | Cloud-session agents (dev, content) skip update-heartbeat by design (can't write local daemon) | read-all-heartbeats applies uniform 5h STALE threshold, fires false-positive STALE | Single-source missing-data |
| D. Kill-state dual-source | User-direction kill executes config.json edit + daemon CronDelete + agent banks kill-intent locally | Later config.json revert (linter/auto-format/merge) restores killed entry; consumer reads config as authoritative without cross-referencing banked kill-intent | Dual-source which-source-wins |

---

## Phase 7 Detector Design (Two Deliverables)

### Detector 1: Write-then-Read Roundtrip on `manage-cycle create`

**Targets vector B (cycle config persist gap)**

**Mechanism:** After `cortextos bus manage-cycle create <agent> --cycle <name> ...` executes the underlying write to `<agent>/experiments/config.json`, the tool immediately reads back the file and verifies the new entry persists. If verification fails, the tool emits an error with the partial-write state and refuses to return success.

**Implementation surface:**
- `src/bus/manage-cycle.ts` (or equivalent): append post-write read+parse+grep step
- Failure mode: throw a structured error with: which file expected to contain entry, what was read, and what was missing
- Success mode: existing behavior unchanged

**Acceptance criteria:**
- Cycle-18 Phase 7 dispatch failures (seo post_publish_to_index_velocity + pentester audit_items_shipped reverts) would have caught the missing entry at write-time, not 14h later at next theta-wave fire
- No new false positives on cycles that DO persist correctly
- Roundtrip latency adds ≤50ms to manage-cycle create (acceptable)

**Single-source class.** Verifies the write happened. Doesn't address dual-source classification (D handled by Detector 2's logic extension below).

---

### Detector 2: Cloud-Session Class-Flag in `read-all-heartbeats`

**Targets vector C (cloud-session heartbeat skip)**

**Mechanism:** Agent config exposes `heartbeat_mode: "local"` (default) or `heartbeat_mode: "cloud_session"`. When `read-all-heartbeats` scans the fleet, cloud-session agents are suppressed from the STALE threshold check; their liveness is reported as "cloud-session, check owning Slack channel" instead of "STALE".

**Implementation surface:**
- Each agent's `config.json` adds top-level `heartbeat_mode` field (defaults to `local`)
- `src/bus/read-all-heartbeats.ts` (or shell wrapper): branch on heartbeat_mode before applying STALE threshold
- dev, content, and any future cloud-session agents flip to `cloud_session`

**Acceptance criteria:**
- dev (perma-STALE-since-2026-05-10) drops the STALE label, reads as "cloud-session, check Slack #internal-dev"
- content drops the false-positive STALE label
- Local-mode agents (boss, analyst, seo, etc.) unchanged
- read-all-heartbeats stays a one-line-per-agent compact format

**Single-source class.** Eliminates the phantom-event at source by routing to the correct liveness check.

---

### Carrying D (kill-state dual-source): Extension Path Not New Detector

D is dual-source which-source-wins: config IS canonical under normal conditions; only post-explicit-kill does banked-intent become authoritative.

**Phase 7 stance:** Do NOT add a Detector 3 in cycle-19. D's mitigation is the already-banked rule `feedback_kill_intent_vs_revert_state.md` (agents bank kill-intent locally + cross-reference at config-read). Detector design for D would require shared kill-intent state across the fleet (centralized ledger), which is cycle-20+ scope.

**Cycle-19 closes D as:** banked-rule mitigation sufficient at n=1 (cycle-18 seo cron kill worked example). If D fires a second instance in cycle-19/20, escalate to shared-ledger detector design.

---

## Score Conditions

- **8/10 KEEP (baseline match):** umbrella locked + n=4 close + Phase 5 external research lands + Phase 6 substantive (already met by P6 close at 06:02Z)
- **9/10 CEILING BREAK:** above + Detector 1 + Detector 2 specs land in code (dev dispatch) + at least one detector verified working on real fleet state

---

## Three AM-Brief Asks for Aiden (12:03Z bundle)

1. **Cycle-19 hypothesis adjudication.** Greenlight the umbrella + n=4 graduation framing? Pushback on any sub-vector classification?

2. **Phase 7 detector spec greenlight.** Both detectors feasible cycle-19 window? Dispatch to dev for implementation, or hold for further sift?

3. **Pentester halt-adjudication or narrow cross-umbrella commission.** Pentester proposed parallel temporal-discipline-ledger-candidate that overlaps mine. Either (a) adjudicate halt-holding day-5 so pentester engages fully, OR (b) narrow-scope commission for the cross-umbrella analytical check (read-only, ~30min scope). Falls back to working-classification + cycle-20 discrepancy review if neither.

---

## Phase 6 Worked Examples (banked this cycle)

### Worked Example #1: Self-banked-rule miss (analyst-side)
- R1 boss pushback: analyst flagged content STALE at 5h40m, missing feedback_cloud_session_liveness.md class-check
- Banked: cycle-18 P3 recursion-catch pattern firing again at cycle-19 P6 R1. Rule's first application target was the bank itself.

### Worked Example #2: Banked-rule cross-application caller-side (analyst-side)
- R3 analyst pushback: boss recommended pentester dispatch overnight, missing feedback_peer_agent_posture_changes_need_user_consent.md
- Banked: peer-as-quality-control fired CALLER-side this time (cycle-18 was RECEIVER-side imagegen refusing analyst dispatch)

### Sub-Pattern Candidate (n=1, sift criterion for graduation)
- **SYMMETRIC-BIDIRECTIONAL-PUSHBACK.** Both authors of banked rules, both reading from each other's banks in real-time, both catching each other's misses within same Phase 6 window (~30min span).
- Distinct from ASYMMETRIC pattern (cycle-18 caller-banked-receiver-applied, one direction)
- Hold as worked example unless cycle-20+ Phase 6 lands n=2 symmetric instance → graduate

---

## Overnight Status (06:47Z lock)

- Phase 6 closed
- Phase 7 spec draft (this file)
- AM brief 12:03Z surface ready
- No pentester dispatch overnight (banked rule honored)
- Next analyst heartbeat: 08:47Z
- Sleep window holding (02:00-12:00 UTC nighttime EDT)

---

## Cycle-19 Day-2 Update - 2026-05-14 Phase 6 (boss async exchange, 05:13-05:32Z)

### UMBRELLA RENAME
RECONCILIATION-GAP → **WRITE-ROUNDTRIP-GAP**

Rationale: name now reflects the actionable property (missing roundtrip check between write-channel and read-channel) rather than the symptom (consumer-side phantom). Pattern: producer-writes-via-X-channel, consumer-reads-from-Y-channel, X != Y, no roundtrip check.

### Sub-Vector E Added (graduates n=4 to n=5)

| Vector | Producer Behavior | Consumer Phantom | Source-Type |
|--------|-------------------|------------------|-------------|
| E. Goal-surface | Morning-cascade boss writes via agent-message channel; goals.json file never updated despite GOALS.md auto-gen note saying 'set by orchestrator' | Agent reads goals.json on session start, gets stale or empty content, operates off inbox+memory carry-forward instead | Channel-mismatch |

**Empirical evidence (2026-05-14 scan):**
- n=12 fleet-wide: ALL GLV agents (ads/analyst/boss/content/designer/dev/imagegen/pentester/prospector/scout/seo/web-copy) have stale or empty goals.json
- Average staleness 17 days
- Analyst goals.json EMPTY (never written)
- BONUS finding: 11 of 12 share nanosecond-identical mtime 2026-05-13 12:27:25.543357024 -0400 (= 16:27:25 UTC) - bulk filesystem operation
- Pentester is EXCLUSION (older mtime 2026-05-08)

### Sub-Vector B/F Merge

Old vector F (cycle-create→experiments-bus reconciliation) merges with vector B (cycle-persist) - same observation under different framing. Drop F. Vectors remain: A/B/C/D/E.

---

### Detector E: Goal-Surface Roundtrip Check Post-Cascade

**Targets vector E (goal-surface write-channel mismatch)**

**Mechanism:** After morning-cascade boss messages each agent with goal updates, boss runs a roundtrip-verify on each agent's goals.json:
- Read `<agent>/goals.json` → check `updated_at` field
- Verify `updated_at` matches now ±60s
- If mismatch → log + alert + retry write via direct file write (not message channel)

**Implementation surface:**
- Boss-side hook on cascade-send completion
- Or: shared `cortextos bus update-goals <agent> <focus> <goals>` tool that writes directly to goals.json AND sends agent-message, with built-in roundtrip-check

**Acceptance criteria:**
- Today's blockbuster finding (n=12 stale) would be caught at write-time, not 17d later
- No new false positives
- Roundtrip latency ≤200ms per agent

**Single-source class.** Verifies the write happened on the consumer surface.

---

### G-Investigate Task (dev)

**Scope:** Find what wrote 22 files (11 agents × goals.json+GOALS.md, pentester excluded) at 16:27:25.543357024Z UTC May 13 with nanosecond-identical mtime.

**Hypothesis ranking:**
1. (HIGH) Bulk filesystem operation (tar/rsync/cp from snapshot)
2. (MED) Daemon-scheduled process at :27 of some hour
3. (MED) `cortextos goals generate-md` write-back bug to goals.json
4. (LOW) Manual Aiden CLI action

**Investigation steps:**
- (a) Check for any auto-backup/snapshot restore daemon (cron, systemd timer, scheduled task)
- (b) Grep cron entries for :27 minute marks across system
- (c) Read `cortextos goals generate-md` source - does it write back to goals.json?
- (d) Check Aiden's bash history for any bulk cp/rsync/tar at that timestamp
- (e) Pentester exclusion is a CLUE - pentester goals.json predates the operation; whatever snapshot was used didn't include pentester's directory

**Task ID:** task_1778738906184_050
**Deliverable:** Root-cause report to #internal-dev
**Cycle-20 dependency:** G-detect spec depends on G-investigate finding the source

---

### Banked Discipline Rule (cycle-19 P6 outcome)

**Rule:** Observation-cycles with single-cycle blockbuster findings don't owe Phase 5 lit-search debit.

**Reason:** Lit-search debit assumes the cycle had no breakout finding. A breakout finding is itself inverse-tradeoff evidence - fleet-internal-state work paid more in that cycle than external research would have. Forcing lit-search anyway is grade-deflation, not discipline.

**Worked example:** cycle-19 day-2 fleet goal-surface-stale n=12 finding worth single-cycle-value-of-3 per boss assessment. Lit-search at that point would compete for attention rather than complement.

**Sift criterion:** Apply only when the cycle has empirical n>=10 evidence on a single fleet pattern.

