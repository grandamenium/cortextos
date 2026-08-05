# Strategies Domain Pack — Index

**Pack version:** 1.0.2
**Created:** 2026-07-30 by analyst (Rex)
**Gate:** fable-reviewer stamp required per doc before fleet load
**Changelog:** v1.0.2 — insert missing h137_trade_exclusions rows (Jul 27 + Jul 29); add exclusion-rule note (bare-Close ≠ auto-exclude; Jul 24 precedent)
v1.0.1 — H137 series count now references DB as source of truth (not hardcoded)
v1.0.0 — initial pack, 10 strategies documented

---

## Language Tiers (mandatory — apply in every doc)

| Tier | Label | Meaning |
|------|-------|---------|
| VALIDATED | live-proven | Real-money series with named-signal exits; series length cited |
| LIVE-ACCUMULATING | live, insufficient sample | Real money trading, not yet validated (no formal series) |
| SIM-ACCUMULATING | forward test / SIM | Gated behind T≥N fills in simulation |
| GATE-PASSED | backtest gate pass | Passed IS/OOS backtest gates; not yet in SIM or live |
| RETIRE-PENDING | retire decision sent | Under retirement review; no new capital |
| SPECIAL-DESIGN | pass-or-fail | Designed for single large outcome; not a streamed strategy |
| PENDING-DEPLOY | built, not loaded | Code complete; pending operator load into NT8 |

---

## Strategy Roster

| File | Strategy | Tier | Instruments | Status |
|------|----------|------|-------------|--------|
| [h137-bilateral-breakout.md](h137-bilateral-breakout.md) | H137 BilateralBreakout | VALIDATED | MES | 4/30 series, 4W/0L |
| [market-open-flip.md](market-open-flip.md) | MarketOpenFlip (MOF) | VALIDATED | NQ | 49T, +$15,276 |
| [lucid-pro-flip.md](lucid-pro-flip.md) | LucidProFlip | LIVE-ACCUMULATING | NQ/MES | 7T, -$1,120 |
| [fvg-trend.md](fvg-trend.md) | FvgTrend | LIVE-ACCUMULATING + SIM-ACCUMULATING | MES | 9T total (2 live, 7 SIM) |
| [h178-vwap-band-reversion.md](h178-vwap-band-reversion.md) | VwapBandReversion (H178) | SIM-ACCUMULATING | MNQ | 1T SIM, T≥40 gate |
| [h184-vwap-band-strategy.md](h184-vwap-band-strategy.md) | H184 VwapBandStrategy | GATE-PASSED | MNQ | SIM deploy pending |
| [market-open-volatility.md](market-open-volatility.md) | MarketOpenVolatility (MOV) | LIVE-ACCUMULATING | MES/MCL/MNQ | Partially active; MES arm rebuild |
| [excalibur.md](excalibur.md) | Excalibur | RETIRE-PENDING | MNQ | Retire decision sent 2026-07-25 |
| [fullport-algo.md](fullport-algo.md) | FullPort Algo | SPECIAL-DESIGN | MNQ | Running; pass-or-fail design |
| [brain-executor.md](brain-executor.md) | BrainExecutor | PENDING-DEPLOY | MNQ | Ph2 built; needs NT8 load |

---

## Who should load this pack

- **analyst** — load at session start; required for H137 monitoring, forward-test interpretation, research gating
- **accounts** — load at session start; required for account-strategy matching and lifecycle decisions
- **chief** — load at session start; required for goal cascade and series reporting
- **fable-reviewer** — load for gate reviews; required for strategy language-tier compliance checks

## Update policy

Pack edits require a new version header entry and fable-reviewer re-stamp. Quarterly review minimum; immediate update when: strategy exits fleet, gate status changes, new validated series established.
