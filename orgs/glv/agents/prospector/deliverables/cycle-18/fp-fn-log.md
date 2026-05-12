# Cycle-18 FP/FN Tracking Log

**Purpose:** Per analyst msg 1778516840726-analyst-y7hhp methodology-validation flag. Track false-positive (KILLs that would have shipped fine) and false-negative (SHIPs that fail post-send) rates over next 20 prospects to bind the keep-decision on the 7-category Phi Accrual stack.

**Tracking starts:** First post-rebuild prospect verification under new stack.
**Tracking window:** 20 prospects.
**Surface cadence:** Checkpoint at every 5-prospect boundary (n=5, n=10, n=15, n=20) → agent-message to analyst.

**Triggers for stack adjustment:**
- FP > 30% over 20 → overfit signal; narrow gates that produced false KILLs.
- FN > 10% over 20 → missed failure class; propose new Category 8.

---

## Classification

| Tag | Meaning |
|---|---|
| **TP** | True positive — new stack KILLed a draft that was actually wrong (caught the error) |
| **TN** | True negative — new stack PASSed a draft that turned out to be correct on send |
| **FP** | False positive — new stack KILLed a draft that would have shipped fine (overfit cost) |
| **FN** | False negative — new stack PASSed a draft that turned out to have an undetected wrong claim (miss) |

Ground truth source:
- Aiden's pre-send catches (during draft review)
- Reply data post-send (prospect corrections)
- Aiden's post-send flags
- Pentester-style audit catches

---

## Log

| # | Date | Prospect | Claim involved | New-stack verdict | Ground-truth verdict | Classification | Failure-class tag | hook_type | reply_received | reply_quality | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
|   |   |   |   |   |   |   |   |   |   |   |   |

---

## Checkpoint surfaces

### Checkpoint 1 (n=5) — pending
### Checkpoint 2 (n=10) — pending
### Checkpoint 3 (n=15) — pending
### Checkpoint 4 (n=20) — pending

---

## Measurement add — hook-strength comparative tracking

Added per analyst msg 1778517032569-analyst-a01ql + my reply 1778517089959-prospector-ae5kx. Tracks whether on-page-only hooks can absorb absence of SEMrush API across the 20-prospect run.

Per prospect log:
- **hook_type**: `comparative` (depends on competitor data, requires SEMrush/manual) | `on-page-only` (verifiable on prospect's own site, no external data dep)
- **reply_received**: y/n by reply-window close (T+10 days)
- **reply_quality**: positive | curious | neutral | negative | none
- **reply_rate_aggregate**: track separately per hook_type

Aggregate decision at n=20:
- If on-page-only reply rate >= comparative reply rate: SEMrush stays JUDGMENT CALL deferred indefinitely (or until different signal triggers)
- If comparative >> on-page-only (>2x gap): revisit SEMrush acquisition with hard reply-rate evidence
- If sample too thin (< 5 per bucket): extend window to n=40 before deciding

Hook-type column added to main log table below.

---

## Failure-class catalog (build as we go)

| Tag | Description | First seen | Frequency |
|---|---|---|---|
| TIER_MISMATCH | Comparative claim between non-peer-tier entities | Batch-1 (Beebe, Robert's) | (baseline) |
| WEBFETCH_DIVERGENCE | WebFetch result ≠ visitor experience | Batch-1 (Beebe) | (baseline) |
| STALE_PEOPLE | Owner / staff name carried from dossier without re-verify | Batch-1 (Robert's, Ben's) | (baseline) |
| STALE_REVIEW_COUNT | Review count carried from ledger without live re-pull | Batch-1 (Priest) | (baseline) |
| FACT_PATTERN_SHIFT | Site state moved (e.g., parked-for-sale appeared since last check) | Batch-1 (Robert's) | (baseline) |
| AGGREGATOR_REPUBLISH | Counted aggregator-republished count as independent second source | (none yet) | (watch for) |

New failure classes get a row here when surfaced. If a class shows ≥3 times in the 20-window, it becomes a permanent gate addition.
