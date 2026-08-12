# Excalibur

**Pack version:** 1.0.0 | **Status tier:** RETIRE-PENDING
**Last updated:** 2026-07-30 | **Gate stamp:** pending fable-reviewer

---

## What it is

An MNQ (Micro Nasdaq) intraday strategy that trades multiple times per session. Has been running since early 2026. Retirement decision sent to Chris 2026-07-25 pending callback.

## Entry logic

- Intraday MNQ entries, multiple per day
- Not orb-status gated (orb-status controls MOV, not Excalibur)
- To pause Excalibur, Chris must disable it directly in NT8 — no server-side kill switch

## Instruments and accounts

- **Instrument:** MNQ (Micro Nasdaq, $2/tick, $0.50/pt)
- **Accounts:** 22 accounts have run Excalibur historically; check strategy_states for current Active
- **Last trade:** 2026-07-10

## Gate status (RETIRE-PENDING)

Retire decision sent to Chris 2026-07-25:
- 15 days dark (no trades as of Jul 25)
- All-time P&L: -$19,766 / 221 trades
- Average P&L/trade: -$82/trade

**Corrected baseline (2026-06-13):** Prior figure of -$21,564/248T was overstated due to MonkeyAttackMonitor reconnect double-inserting trade pairs. 27 phantom rows deleted via ON CONFLICT DO NOTHING + UNIQUE INDEX. Use -$19,766/221T as canonical.

Awaiting Chris callback on retire decision.

## Performance

| Metric | Value | Notes |
|--------|-------|-------|
| All-time trades | 241 | |
| All-time P&L | -$19,766.00 | Canonical (phantom rows removed) |
| Avg P&L/trade | -$82.00 | |
| Last trade | 2026-07-10 | 20+ days dark |

**Language tier:** RETIRE-PENDING. Do not monitor for performance recovery. Do not flag losses — do not escalate individual Excalibur losses to Chris (per prior directive). Monitor status only (active vs retired).

## Monitoring notes

- No alerts on Excalibur losses — Chris directive (keep running / don't flag)
- Staleness after Jul 10: strategy appears dark; may be intentional ahead of retire
- When retire confirmed: close all strategy_states rows, archive accounts
- Do NOT use orb-status to pause — not connected to orb-status gate
