# MarketOpenVolatility (MOV)

**Pack version:** 1.0.0 | **Status tier:** LIVE-ACCUMULATING (partially active)
**Last updated:** 2026-07-30 | **Gate stamp:** pending fable-reviewer

---

## What it is

A market-open volatility strategy that capitalizes on directional volatility at the open. Multiple variants and instruments have run over time; current focus is on MES (Micro E-mini S&P). The MES arm is under active rebuild.

## Entry logic

- Enters at or near market open (8:30 AM CT / 9:30 AM ET)
- Directional: takes a position based on early volatility signal
- Instruments: MES (current), previously MCL, MNQ

## Instrument history

| Instrument | Period | Notes |
|------------|--------|-------|
| MCL (Micro Crude) | 2026-04 to 2026-07-03 | Retired; last trade Jul 3 |
| MNQ (Micro Nasdaq) | 2026-06 only | Small run |
| MES (Micro S&P) | 2026-05 to 2026-07-28 | **Current focus** |

**Contract expiry watch:** MCL rolls monthly. MES/MNQ roll quarterly. When an instrument goes dark >2 weeks, check contract expiry before assuming strategy failure.

## Current status

**MES arm rebuild:** Chris GO on rebuild 2026-07-27. Rebuild scope under discussion; MES on SimSim2 as of 2026-07-28 (2T, -$51.25). Strategy_states shows Active on SimSim2.

**OVX gate:** MOV (MCL/MNQ variants) is gated behind OVX. When OVX >50 = HARD-CAUTION, MCL/MNQ variants are paused. Current OVX: 67.6 (HARD-CAUTION) — MCL/MNQ variants should not be trading.

## All-time performance

| Metric | Value | Notes |
|--------|-------|-------|
| All-time trades | 148 | All instruments combined |
| All-time P&L | -$3,171.75 | Mixed period including CL contamination |

**CL contamination note (2026-05-30):** Some accounts ran full CL (crude oil, 10x contract size) instead of MCL in early periods. Bad CL sessions dragged all-time P&L down significantly. Intended instrument was always MCL. All-time P&L should not be cited without this caveat.

**MCL contract expiry pattern:** MCL 05-26 expired ~May 16. Strategy appeared dormant (0 trades Apr 15 to May 30) even though orb-status was ACTIVE. Always check contract expiry when an instrument goes dark >2 weeks.

## Accounts

Multiple accounts across Apex, MFF, Tradeify have run MOV variants at different times. Check strategy_states for current Active accounts. HolyGrail fleet has 1 MOV slot (per Chris 2026-07-24).

**Orb-status gate:** orb-status controls MOV variants only. Excalibur is NOT controlled by orb-status — separate mechanism.

## Language tier

LIVE-ACCUMULATING (partially active). MCL/MNQ variants effectively paused (OVX HARD-CAUTION). MES arm rebuilding. Do not call validated — all-time P&L is negative and instrument contamination complicates the history.

## Monitoring notes

- MES arm: monitor SimSim2 fills; no alerts on small losses during rebuild
- MCL/MNQ: expect no trades while OVX >50 (HARD-CAUTION)
- OVX <40 = resume-signal; 40-50 = elevated-caution; >50 = hard-caution
- HolyGrail slot: 1 MOV instance confirmed in fleet (zombie rows from earlier were cleaned up)
