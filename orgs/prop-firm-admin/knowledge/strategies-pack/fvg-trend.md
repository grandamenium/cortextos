# FvgTrend

**Pack version:** 1.0.0 | **Status tier:** LIVE-ACCUMULATING + SIM-ACCUMULATING
**Last updated:** 2026-07-30 | **Gate stamp:** pending fable-reviewer

---

## What it is

A Fair Value Gap (FVG) trend-following strategy on MES. Identifies imbalance zones (fair value gaps) in price action and enters in the direction of the prevailing trend when price returns to fill the gap. Deployed on both a live real-money account and a SIM account accumulating toward a gate.

## Entry logic

- Identifies FVG (fair value gap) imbalance zones on intraday bars
- Enters on trend continuation after price revisits the gap zone
- Direction: trend-following (not mean-reverting)
- Instrument: MES 09-26

## Exit logic

- TP and SL based on gap structure
- EOD exit for any open positions at session end
- Check trades DB exit_signal for specific exits

## Instruments and accounts

| Account | Type | Instrument | Trades | P&L | Notes |
|---------|------|------------|--------|-----|-------|
| TDFYG50201122518 | Live (real money) | MES 09-26 | 2 | -$132.50 | SIM-style account on specific firm; intentional per Chris |
| SimSim2 | SIM | MES 09-26 | 7 | -$196.25 | Forward-test accumulation toward T≥40 gate |

**Total:** 9 trades, -$328.75 combined

## Gate status

**TDFYG50201122518 (live):** Strategy is running on a real account. The -$132.50 loss is intentional per Chris (SIM-style deployment for live tick-data exposure). Staleness of strategy_states for this account is expected behavior — it is a SIM-only firm account type; staleness is not a monitoring failure.

**SimSim2 (SIM):** Forward-test accumulating toward T≥40 gate. Current: 7/40 trades. Gate: at T=15 if still negative, flag to chief. At T=40, review WR and Sharpe against gate thresholds before any live capital consideration.

**Live deploy gate:** FvgTrend was deployed live without a formal fable-reviewer gate. This is a noted gap — no gate stamp on record for the live deploy.

## Performance

| Account | Trades | P&L | Tier |
|---------|--------|-----|------|
| TDFYG50201122518 (live) | 2 | -$132.50 | LIVE-ACCUMULATING |
| SimSim2 (SIM) | 7 | -$196.25 | SIM-ACCUMULATING |

**Language tier:** LIVE-ACCUMULATING (live account) / SIM-ACCUMULATING (SimSim2). Not validated. Do not cite performance as evidence of edge — sample is too small and both accounts are negative.

## Monitoring notes

- Flag to chief at SimSim2 T=15 if still negative
- TDFYG staleness: expected — do not alert
- Live deploy gate gap: noted; not blocking current monitoring
- SIM gate target: T≥40 with WR and Sharpe review before live expansion
