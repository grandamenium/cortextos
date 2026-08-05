# H184 VwapBandStrategy

**Pack version:** 1.0.0 | **Status tier:** GATE-PASSED
**Last updated:** 2026-07-30 | **Gate stamp:** pending fable-reviewer

---

## What it is

A VWAP ±2σ band strategy on MNQ. Enters when price reaches the 2-standard-deviation VWAP band and reverts. Different from H178 VwapBandReversion in its band width and entry/exit mechanics. Low trade frequency (~7 trades/year) — a high-conviction setup.

## Entry logic

- Trigger: Price reaches ±2σ VWAP deviation
- Direction: Mean-reverting
- Instrument: MNQ (Micro Nasdaq)
- Frequency: ~7 trades/year in backtest

## Gate status (GATE-PASSED)

**Backtest result (3-year MNQ IS):**
| Metric | Value | Gate |
|--------|-------|------|
| Trades | 27 | ≥20 ✓ |
| WR | 66.7% | ≥55% ✓ |
| Sharpe | 1.85 | ≥1.5 ✓ |
| Max DD | acceptable | ✓ |

**Sharpe correction note:** Prior figure of 9.97 was a methodological error (sqrt(252) applied at trade level instead of annualizing returns). Corrected figure is 1.85 — confirmed 2026-07-25. Use 1.85.

**Deploy path:**
1. SIM on 3 eval accounts in parallel (pending Chris GO)
2. Forward-test gate: T≥40 SIM fills, WR/Sharpe review
3. Live at 3–5ct after gate

**Current status:** SIM load GO pending Chris. No SIM trades in DB yet.

## Performance

| Metric | Value | Notes |
|--------|-------|-------|
| Live trades | 0 | Not yet deployed |
| SIM trades | 0 | Pending Chris GO on load |
| Backtest Sharpe | 1.85 | IS gate evidence only |

**Language tier:** GATE-PASSED. No live or SIM trades. Do not cite backtest Sharpe as "performance" — it is gate evidence. Do not call validated.

## Monitoring notes

- No monitoring action until SIM is loaded
- When SIM loads: report fill count on nightly cycle
- ~7 trades/year = expect long quiet stretches in SIM; do not flag as dead
