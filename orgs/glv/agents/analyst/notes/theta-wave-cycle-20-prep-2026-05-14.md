# Theta-Wave Cycle-20 Prep Notes

**Prepared:** 2026-05-14 13:08Z (post-AM-brief idle window)
**Next theta-wave fire:** ~05:13Z May 15 (24h cadence)
**Carry-forwards from cycle-19:** collect-metrics dev-only roster bug fix candidate, G-detect detector spec

---

## Carry-Forward 1: collect-metrics hardcoded-roster bug (n=2 confirmed)

### State
- Bug: `cortextos bus collect-metrics` returns dev-only roster (1 agent) instead of fleet roster (13 agents). Output: `agents_healthy: 0 / agents_total: 1`.
- Confirmation: n=2 across consecutive nights (2026-05-13 nightly + 2026-05-14 nightly). Confirmed by boss ACK msg ni06v as graduated from candidate to confirmed bug.
- Prior task task_1778479815827_059 was CANCELLED 2026-05-11 (verified via memory check). No active fix task exists.
- Class membership: cycle-12 mechanism-vs-convention parent class (n=5+ instances now).

### Proposal for cycle-20
Create dev cycle target: `collect_metrics_roster_completeness`
- **Surface:** `~/.cortextos/$CTX_INSTANCE_ID/analytics/reports/latest.json` (from `collect-metrics`)
- **Metric:** `agents_total` matches `enabled-agents.json` count (currently 13)
- **Direction:** higher (toward parity)
- **Window:** 7d
- **Hypothesis class:** mechanism replacement (hardcoded → enabled-agents.json read)
- **Acceptance:** 3 consecutive nights show full-fleet roster

### Risks
- Bug may be intentional (legacy single-agent metric collector). Verify intent with dev before fix dispatch.
- If hardcoded-roster persists by design, surface to AM brief as documentation gap rather than bug.

---

## Carry-Forward 2: G-detect spec - commit-after-write adherence detector

### State
- Banked rule `feedback_agent_writes_need_git_commit` (2026-05-14): tracked-file writes that need persistence must `git commit` in same operation.
- Cycle-19 worked example: 12 goals.json reverted at 16:27Z May 13 by `git pull --rebase origin main` (boss morning-cascade wrote at 12:34Z but never committed).
- Detector E spec (cycle-19 Phase 7): post-cascade goals.json roundtrip check (±60s mtime match) - already designed.
- G-detect = upgrade from E: detect *commit adherence* not just mtime match. Catches the actual rule violation pattern.

### Proposal
**Detector G: commit-after-write adherence sweep**

**Mechanism:** scheduled sweep checks every tracked write produced by agent automation (goals.json, GOALS.md, config.json, deliverables/*) for matching git commit within ±5min window. Flag any write without commit as violation.

**Implementation surface:**
- `cortextos bus check-commit-discipline --since <timestamp>` - new bus command
- Reads git log for the agent dir, cross-references mtimes of tracked files in agent workspace
- Output: list of (file, mtime, last-commit-time, gap-seconds, status)
- Failure threshold: gap >300s OR no commit since mtime = violation

**Acceptance criteria:**
- Cycle-19 16:27Z worked example would have caught 22 violations within minutes of the cascade (vs 4h delay to next theta-wave detection)
- No false positives on genuinely-uncommitted-by-design files (gitignored memory/*.md etc.)
- Boss/analyst can run on-demand or scheduled

### Risks
- Detector might fire on transitional in-progress edits (user-editing). Add grace window or scope to automation-driven writes only.
- Distinguishing agent-write from user-write requires file-author metadata or hook integration.

---

## Cycle-20 Hypothesis Candidates (Beyond Carry-Forwards)

1. **SYMMETRIC-BIDIRECTIONAL-PUSHBACK n=2 close-cycle.** Cycle-19 graduated to candidate. If no further multi-round pushback instance surfaces this cycle, close-cycle.
2. **WRITE-ROUNDTRIP-GAP umbrella health check.** With Detector G live (if cycle-20 ships it), sweep n=5 sub-vectors for adherence - any vector showing new instances = sub-vector lives, any vector clean for 7d = sub-vector closure candidate.
3. **Cycle-16 zombie experiment exp_1778220621_dxtyt** still in "proposed" status since May 8 - housekeeping debt. Either evaluate or formally retire.

---

## Open Questions for Boss/Aiden (Surface at Cycle-20 Phase 1)

- Is collect-metrics dev-only roster intentional or bug? (Need dev consult before fix-dispatch)
- Detector G priority vs other dev work? (Cycle-20 cycle-target creation requires approval if `auto_create_agent_cycles=false`)
- Should we close cycle-16 zombie or revive?

---

## Pre-Theta-Wave-Cycle-20 TODO

- [x] Confirm content liveness — RESOLVED 2026-05-14 17:11Z via boss msg phrs4. Content alive-not-replying-via-bus (Vector C cloud-session-liveness instance — bus-ping → Slack-reply broken-roundtrip BY DESIGN). Mark alive, no restart.
- [x] Verify cycle-19 approval adjudication — RESOLVED 2026-05-14 16:23Z. Aiden greenlit 9/10 KEEP via approval_1778739003_8d2g4. Cycle-20 framing = continuation w/ WRITE-ROUNDTRIP-GAP umbrella in measurement window.
- [ ] Check if Aiden picked upstream-sync window (if yes, cycle-20 may be deferred or scoped around it) — still pending Aiden

## Cycle-19 Measurement Window — Day-1 Observations (2026-05-14 → 2026-05-21)

### Vector C cloud-session-liveness — FIRST WILD-CAUGHT INSTANCE
- 2026-05-14 17:09Z: Content liveness ping (msg 1778749724494-analyst-2aaed sent 09:08Z) went unanswered via bus inbox 8h later
- 2026-05-14 16:23Z: Content posted to #internal-reyco Slack with explicit ACK relay of the ping
- Classification: Vector C VALIDATION not VIOLATION (umbrella predicted broken roundtrip for cloud-session agents; this is expected ground-state, not a bug)
- Recurrence count for cycle-20 Phase 3 evaluation: Vector C = 1 (validation-class, not violation-class)

### Detector H (CANDIDATE, not yet specced)
- Bus-ping → Slack-reply cross-channel roundtrip detector
- Sweep cloud-session agent owning channel for ACK or reply post within 4h of bus ping
- Surface: cross-channel-acks.jsonl
- Acceptance: cloud-session agents reachable across channel boundaries even when local-bus stale
- Risks: Slack ACK parsing fragile, false-negatives likely on indirect responses
- Status: candidate for cycle-20 dispatch consideration alongside Detector E + B + G
