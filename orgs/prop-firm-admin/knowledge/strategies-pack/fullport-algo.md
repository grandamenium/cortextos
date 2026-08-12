# FullPort Algo

**Pack version:** 1.0.0 | **Status tier:** SPECIAL-DESIGN
**Last updated:** 2026-07-30 | **Gate stamp:** pending fable-reviewer

---

## What it is

A single-shot, all-in strategy on MNQ that makes one large bet per session. Designed as pass-or-fail — not a streamed strategy with many small trades. Individual trade outcomes are large by design: a losing attempt = a large loss; a winning attempt = a large gain.

## Entry logic

- One entry per session, large size
- Instrument: MNQ (Micro Nasdaq)
- Time: Market open (8:30 AM CT / 9:30 AM ET)
- Design intent: max-position single attempt

## Exit logic

- TP or SL on the single trade
- Large individual P&L swings are expected and intentional

## Instruments and accounts

- **Instrument:** MNQ
- **Accounts:** 20 accounts have run FullPort Algo; rotates across eval accounts. Check strategy_states for current Active.

## Gate status (SPECIAL-DESIGN)

- Running per Chris directive (KEEP RUNNING, 2026-06-04 via chief)
- Do NOT escalate FullPort Algo losses as standard monitoring alarms
- Track separately from streamed strategies like Excalibur or H137

## Performance

| Metric | Value | Notes |
|--------|-------|-------|
| All-time trades | 48 | |
| All-time P&L | -$21,850.00 | Large individual losses are by design |
| Trades last 30d | 13 | |

**Language tier:** SPECIAL-DESIGN. Do not apply standard WR/Sharpe analysis — the pass-or-fail design makes per-trade metrics misleading. Monitor total P&L trend only.

## Monitoring notes

- **Do NOT alert on individual large losses** — by design
- Chris directive: KEEP RUNNING, do not frame losses as alarms
- Monitor: overall trend, not individual trades
- Compare to MarketOpenFlip for pass-or-fail framing — same class of strategy
