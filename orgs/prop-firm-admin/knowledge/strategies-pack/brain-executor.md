# BrainExecutor

**Pack version:** 1.0.0 | **Status tier:** PENDING-DEPLOY
**Last updated:** 2026-07-30 | **Gate stamp:** pending fable-reviewer

---

## What it is

An ORB (Opening Range Breakout) accumulation strategy on MNQ that builds a position across multiple breakout signals in the morning session. Phase 2 implements an accumulation mechanic — rather than one entry at the breakout, it adds contracts as the breakout confirms across multiple sub-signals.

## Entry logic

- Opening range is measured at session open
- Phase 2: accumulation entries triggered by sub-signals within the ORB window
- Direction: breakout direction (long above range, short below)
- Instrument: MNQ (Micro Nasdaq)

## Build status

**Phase 2 status:** Built and stamped 2026-07-29.
- P1: Pre-open detection fix + date reset ✓
- P2: VIX signal omit ✓
- Awaiting: Chris NT8 recompile + SIM verify with populated-fields log

**fable-reviewer gate:** Re-verify pending after recompile.

**Note:** `_detect_setup` IS implemented in the code — STUB comments in the source are stale and incorrect. The method exists.

## Instruments and accounts

- **Instrument:** MNQ (Micro Nasdaq)
- **Accounts:** 4 accounts in strategy_states (Active state); no live trades until SIM verify complete

## Performance

| Metric | Value | Notes |
|--------|-------|-------|
| Live trades | 2 | Early test trades only |
| Live P&L | -$9.00 | Not meaningful |
| SIM trades | 0 | Pending recompile |

**Language tier:** PENDING-DEPLOY. No validated trades. Do not cite any numbers as performance. Do not call any aspect "working" until SIM verify with populated-fields log is confirmed.

## Monitoring notes

- No monitoring action until Chris recompiles and SIM loads
- When SIM loads: confirm _detect_setup is populating the fields log (required for fable-reviewer re-verify)
- Recompile needed for both BrainExecutor Ph2 AND H137 SKIP_DAYS fix — Chris can batch both
- Risk layer (M5) is next build phase after SIM verify
