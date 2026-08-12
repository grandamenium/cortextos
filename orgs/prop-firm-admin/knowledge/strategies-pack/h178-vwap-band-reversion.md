# VwapBandReversion (H178)

**Pack version:** 1.0.0 | **Status tier:** SIM-ACCUMULATING
**Last updated:** 2026-07-30 | **Gate stamp:** pending fable-reviewer

---

## What it is

A VWAP-band mean-reversion strategy on MNQ (Micro E-mini Nasdaq-100). Enters when price reaches an extreme deviation from VWAP (the bands), betting on reversion to the mean. Bilateral: trades both long (price too far below VWAP) and short (price too far above VWAP).

## Entry logic

- Trigger: Price reaches ±N standard deviation bands around VWAP on 5-minute bars
- Direction: Mean-reverting — Long when price is at lower band, Short at upper band
- Instrument: MNQ (Micro Nasdaq), 5-minute chart

## Exit logic

- TP: Price returns to VWAP or a target band
- SL: Price continues beyond the entry band by a defined amount
- EOD: Time exit at end of session

## Instruments and accounts

- **Instrument:** MNQ (Micro Nasdaq, $2/tick, $0.50/pt). Sim3 account.
- **Current deployment:** SIM-only on MNQ Sim3

| Account | Instrument | Trades | P&L | Status |
|---------|------------|--------|-----|--------|
| Sim3 (VwapBandReversion) | MNQ | 1 | -$224.50 | SIM-ACCUMULATING |

## Gate status (SIM-ACCUMULATING)

- **Fable-reviewer verdict:** BUY — gate pass locked
- **SIM target:** T≥40 fills before live capital consideration
- **Current:** 1/40 trades in SIM
- **Backtest Sharpe:** Strong (H178 was the basis for H186/H187 filter research)
- **Live deploy path:** 3-5ct on MNQ after SIM gate, pending Chris GO on SIM load

**Note:** H184 VwapBandStrategy is a related but distinct strategy — same VWAP theme, different mechanics and gate status. Do not conflate.

## Performance

| Metric | Value | Notes |
|--------|-------|-------|
| SIM trades | 1 | Way too early |
| SIM P&L | -$224.50 | Meaningless at T=1 |
| Backtest basis | H178 IS/OOS gate pass | See PLAN.md |

**Language tier:** SIM-ACCUMULATING. No live trades. Do not cite backtest numbers as "performance" — they are gate evidence only. Do not call validated.

## Monitoring notes

- Report SIM fill count on every nightly cycle
- No capital action until T≥40 gate reached
- Chris GO on SIM load still pending — confirm load before expecting fills
