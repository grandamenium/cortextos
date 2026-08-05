# MarketOpenFlip (MOF / FLIP)

**Pack version:** 1.0.0 | **Status tier:** VALIDATED
**Last updated:** 2026-07-30 | **Gate stamp:** pending fable-reviewer

---

## What it is

A market-open reversal strategy on NQ (E-mini Nasdaq-100). At the open, it identifies the initial directional move and bets on a reversal — taking the opposite side once the move exhausts. One trade per day, fires at or near 8:30 AM CT (9:30 AM ET open).

## Entry logic

- Direction: Opposite to the opening directional move
- Instrument: NQ 09-26 (front month; rolls quarterly)
- Time: Market open (8:30 AM CT / 9:30 AM ET)
- Design: Pass-or-fail style at market open — one large entry, result known quickly

## Exit logic

- Strategy exits at TP or SL or EOD
- See trades DB exit_signal for specific exits
- Large individual losses and wins are by design

## Instruments and accounts

- **Instrument:** NQ (E-mini Nasdaq-100, not micro). Full-size contract: $20/tick, $5,000/pt risk profile.
- **Historical instruments:** M2K (Micro Russell), MCL (Micro Crude), MNQ in early runs — now consolidated to NQ only

**Active accounts (representative, as of 2026-07-29):**
Multiple eval and funded accounts across Apex, MFF, Tradeify. Rotates as accounts pass/fail evals. Not pinned to specific accounts — check strategy_states for current loaded accounts.

## Gate status (VALIDATED)

- **All-time trades:** 49
- **All-time P&L:** +$15,276.80
- **Timeframe:** 2026-04-20 through 2026-07-29
- **Recent performance:** 10 trades in last 30 days

**Language tier:** VALIDATED — live real-money series with consistent execution over 3+ months. Reference live P&L numbers only.

## Performance

| Metric | Value |
|--------|-------|
| All-time trades | 49 |
| All-time P&L | +$15,276.80 |
| Avg P&L/trade | +$311.77 |
| Trades last 30d | 10 |

## Monitoring notes

- This is a high-volatility strategy — individual trade swings are large by design
- NQ full contract = 10x the notional of MNQ; a single losing trade can be -$2,000+
- Do NOT flag individual large losses as anomalies — check the all-time trend
- Monitor for: strategy going dark >3 days during active trading periods
