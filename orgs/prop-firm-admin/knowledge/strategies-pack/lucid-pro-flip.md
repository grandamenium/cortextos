# LucidProFlip

**Pack version:** 1.0.0 | **Status tier:** LIVE-ACCUMULATING
**Last updated:** 2026-07-30 | **Gate stamp:** pending fable-reviewer

---

## What it is

A market-open flip strategy deployed on Lucid Pro accounts. Similar open-reversal mechanics to MarketOpenFlip but calibrated for Lucid Pro firm rules (DLL $1,200, no consistency rule in funded phase).

## Entry logic

- Direction: Reversal at market open
- Time: 8:30 AM CT (9:30 AM ET)
- Instruments: NQ 09-26 (primary), MES 09-26 (some accounts)

## Instruments and accounts

| Account | Firm | Instrument | Trades | P&L |
|---------|------|------------|--------|-----|
| TDFYG50201122518 | Tradeify/Lucid | NQ 09-26 | 3 | +$60.00 |
| LTE05059758350007 | Lucid | NQ 09-26 | 2 | -$2,120.00 |
| LTE05059758350007 | Lucid | MES 09-26 | 2 | +$940.00 |

**Total:** 7 trades, -$1,120.00 all-time

## Gate status

**Status tier: LIVE-ACCUMULATING**

Strategy is live on real accounts but sample is insufficient for validated status. 7 trades across 30 days — too early to confirm edge. Monitor trajectory; do not call validated.

**7-day reversal flag (2026-07-30):** All-time P&L is only +$40 on some accounts; recent 7-day move shows -$275 reversal. Flagged to chief for awareness — not a threshold breach at current sample size.

## Performance

| Metric | Value | Notes |
|--------|-------|-------|
| All-time trades | 7 | |
| All-time P&L | -$1,120.00 | Small sample |
| Status | LIVE-ACCUMULATING | Not validated |

**Language tier:** LIVE-ACCUMULATING — do not call this "validated." Sample size too small for any performance claims. Report raw numbers and flag trajectory.

## Monitoring notes

- Flag to chief if 7-day P&L continues negative at 15T
- Do not escalate individual losses — 7 trades is too small for pattern detection
- NQ contract risk: full-size, single losing trade can be -$2,000+
