# H137 BilateralBreakout

**Pack version:** 1.0.5 | **Status tier:** VALIDATED
**Last updated:** 2026-07-31 | **Gate stamp:** pending fable-reviewer re-stamp

---

## What it is

A post-open bilateral breakout strategy on MES (Micro E-mini S&P 500). After the open, it measures a price range; when price breaks cleanly above or below that range, it enters in the breakout direction. One trade per day maximum.

## Signal window vs entry window

These are two separate gates — getting this wrong causes incorrect monitoring.

**Signal window (9:30–10:30 ET):** This is a go/no-go gate only. The strategy uses this window to decide whether it will trade today. It does NOT determine when entry fires.

**Entry signal:** A separate, later signal fires when a clean breakout is detected. Entry has been observed as late as 3:05 PM ET. The strategy can enter any time after the signal window confirms a go day.

## Entry logic

- Direction: Long if price breaks above range high; Short if price breaks below range low
- Instrument: MES 09-26 (rolls quarterly; always use front month)
- Trigger: 5-minute bar close exceeds the range boundary

## Exit logic

Three exit types, in priority order:
1. **TP (take profit):** Unnamed in exit_signal — strategy exits when price reaches the profit target
2. **SL (stop loss):** Unnamed in exit_signal — strategy exits when price hits the stop
3. **EOD exit (H137_Long_EOD / H137_Short_EOD):** Fires on the bar closing after 3:45 PM ET. In practice this is the 3:45–3:50 PM ET bar, exit recorded at ~3:50 PM ET = ~2:50 PM CT. This is DESIGNED behavior — exits before close volatility. IsExitOnSessionCloseStrategy (~4:00 ET) is a backstop only.
4. **MaxHold (H137_Long_TimeExit):** Force-close after 480 minutes. Safety net for runaway holds.

**Reading exit signals:** A bare "Close" in exit_signal = manual flatten by Chris (not a strategy signal). Named signals (H137_Long_EOD, H137_Long_TimeExit) are strategy-generated.

## Instruments and accounts

- **Instrument:** MES only (Micro E-mini S&P). No NQ, no MCL.
- **Contract size:** 1ct = $12.50/tick ($5.00/pt)

**Active accounts (as of 2026-07-30):**

| Account | Firm | Contracts | Notes |
|---------|------|-----------|-------|
| PAAPEX4333770000017 | Apex | 1 | **Pilot account** — pessimistic fill bias (dispatched last) |
| PAAPEX4333770000002 | Apex | ~10 | Connected fleet |
| APEX4333770000091 | Apex | ~10 | Connected fleet |
| PPNTCASHPPX50024895000003 | Tradeify | ~5 | Connected fleet |
| PPNTETL25024895000005 | Tradeify | TBD | Connected fleet |
| MFFUSFFLX450774019 | MFF | ~3 | Connected fleet |
| TAKEPROFITPRO392542906 | Vincere | blind | Blind — no state feed; monitor via trades DB only |

**Dispatch order:** Pilot (PAAPEX...017) is dispatched LAST to give other accounts pessimistic fill reference.

## Gate status and series (VALIDATED)

**Skip Fridays:** `SKIP_FRIDAYS = True` (backtest variable name, `pd.dayofweek == 4`) — strategy does not trade Friday sessions. Fix committed 374f375 (orbfutures master, Jul 31 16:00 UTC) — also adds VIX<22 gate (backtest: `VIX_MAX = 22.0`) and corrects range window to include 10:30 bar. Prior live code had SkipMondays (wrong) + no VIX gate + range excluded 10:30 bar. **Requires NT8 recompile before Mon Aug 4.** Prior stamped SkipMondays artifact (stamp 826dc4d3) voided by fable-reviewer 2026-07-31, superseded by 374f375.

**Official series (post-exclusion-ruling 2026-07-29):**
- Valid days: query trades DB — `SELECT COUNT(*) FROM trades t LEFT JOIN h137_trade_exclusions e ON t.id=e.trade_id WHERE t.strategy_name='H137_BilateralBreakout' AND t.account_name='PAAPEX4333770000017' AND e.trade_id IS NULL` (do not hardcode count — use DB as source of truth; returns 5 as of 2026-07-31)
- **Exclusion rule:** bare-Close exit_signal = flag for review; strategy-named exit (H137_Long_EOD, H137_Long_TimeExit) = valid. Do not filter on exit_signal to compute the series count.
- **Friday config-conformance ruling (Chris, 2026-07-31):** COUNT ALL. "Win/loss is still just as valid — we are validating profitability, not strict backtest conformance." Friday trades (Jul 24, Jul 31) count toward the series regardless of config divergence active at time of trade.
- **Language-tier consequence (binding, per gate):** because conformance is not required, the 30-day series outcome validates **live profitability of the as-run config** — it must never be described as "backtest-validated." Pre-374f375 days ran a hybrid config no backtest covers; describe the series result as live-validated profitability only.
- Target: 30 valid days
- Record as of 2026-07-31: 5W / 0L
- Pilot P&L as of 2026-07-31: +$256.25
- Days 9+10 excluded: all-manual exits by Chris (fleet made +$90 / +$1,500 under manual management, tracked separately)

**Payout thresholds (minimum win filters do NOT apply — these are payout minimums):**
- MFF: $150 minimum per payout
- Apex: $50 minimum per payout

**Why 5/30 and not higher:** Strategy launched post-MaxHold fix (480min, was 120min). Clean series started after that recompile.

## Performance

| Metric | Value | Notes |
|--------|-------|-------|
| All-time trades | 25 | All MES 09-26 |
| All-time P&L | +$3,375 | Pilot + connected fleet combined |
| Series WR | 100% (4W/0L) | Small sample — not statistically significant |
| Backtest Sharpe | 2.02 (baseline) | Pre-MaxHold-removal backtest |

**Language tier:** VALIDATED — this strategy has a live real-money series with named exits. Do not call it "backtest-candidate" or reference backtest numbers as performance.

## Monitoring checklist

- Flag any trade immediately to chief (day 4+ = progressing toward payout)
- Pilot flat = series progressing normally; check exit_signal to distinguish TP vs EOD vs manual
- Check PAAPEX...017 exit_time IS NULL to detect open positions (not strategy_states.state — Active = loaded, not positioned)
- TAKEPROFITPRO: monitor via trades DB only; state feed not available from Vincere
- Weekends: strategy monitors normally (signal window fires Mon-Fri only)
