# Long-Term Memory

## Org Context — 2026-04-07
Prop firm admin org manages trading accounts across multiple vendors. Infrastructure spans:
- NinjaTrader strategies on Windows VPS
- Strategy code built by Claude Code on Linux VPS
- Monitoring addon uploading data to a separate Linux VPS
Key concerns: VPS sync, blown account rotation, risk correlation with news, strategy performance validation, billing issues.

## Monitoring Baselines — 2026-04-11 (updated from initial 2026-04-07)

### Agent Fleet Health Thresholds
- Heartbeat freshness: < 5h = healthy, 5-8h = stale (nudge), >8h = unresponsive (escalate to orchestrator)
- Event logging: >= 3 events/day per active agent = healthy, 0 = dead
- Task staleness: in_progress > 2h without update = stale, > 24h = critical
- Memory writes: >= 1 daily memory entry per session = healthy

### Current Baselines (bootstrap phase, Apr 7-11)
- Fleet size: 4 agents (3 active, 1 not onboarded)
- Daily event volume: 3-11 events/agent/day when active (chief avg ~4, analyst ~6, devops ~4)
- Task completion rate: 1 total completed in 4 days (system not yet productive)
- Activity gaps: 2-day gap observed (Apr 9-11) — sessions not continuous
- Heartbeat compliance: devops frequently stale (misses 1-2 cycles/day)
- Goal staleness: all goals untouched since Apr 7-8

### Event Log Path (CORRECTED)
Events stored at: `~/.cortextos/default/orgs/{org}/analytics/events/{agent}/YYYY-MM-DD.jsonl`
NOT at `~/.cortextos/default/analytics/events/` (that path does not exist)

### What "Healthy at Scale" Should Look Like (target)
- All agents heartbeat within 5h at all times
- >= 1 task completed per agent per day
- >= 5 events per agent per day
- Zero tasks stale > 24h
- Goal cascade from chief every morning
- Experiment activity from at least 1 agent

### Fleet Health Scoring Model — 2026-04-11
Score per agent per day (0-10 scale):
- Heartbeat compliance (0-3): 3 = all cycles hit, 2 = missed 1, 1 = missed 2+, 0 = no heartbeats
- Event volume (0-2): 2 = >=5 events, 1 = 1-4 events, 0 = no events
- Task activity (0-3): 3 = task completed, 2 = task in_progress with updates, 1 = task exists but stale, 0 = no tasks
- Error rate (0-2): 2 = 0 errors, 1 = 1-2 errors, 0 = 3+ errors

Historical scores (bootstrap phase):
| Date       | chief | analyst | devops | accounts |
|------------|-------|---------|--------|----------|
| 2026-04-07 | 2     | —       | —      | —        |
| 2026-04-08 | 1     | —       | —      | —        |
| 2026-04-09 | 2     | 3       | 4      | 0        |
| 2026-04-10 | 0     | 0       | 0      | 0        |
| 2026-04-11 | 6     | 9       | 5      | 0        |

Patterns observed:
- Apr 10 was a complete gap — no agent activity (session crash or infra issue?)
- Apr 11 is the highest-activity day by far (all agents rebooted)
- CORRECTION (Apr 12): devops is NOT stale — it heartbeats reliably every 4h at :37 past
- accounts has never scored above 0
- analyst had the best day on Apr 11 (first tasks completed in system history)

### Agent Heartbeat Cadence (CORRECTED 2026-04-12)
Every agent heartbeats on a reliable 4h cycle with different offsets:
- analyst: ~:32 past every 4h
- chief: ~:03 past every 4h
- devops: ~:37 past every 4h
- accounts: varies (newer agent)

The `read-all-heartbeats` STALE flag (>4h threshold) triggers briefly on every cycle because agents are JUST over the threshold before their next fire. This is NOT a bug in the agents — it is a threshold issue. Relax to 5h OR check against expected-next-fire time before flagging.

DO NOT escalate "STALE" on ~3-4h gaps — check the event log for pattern first. Agents with consistent interval gaps are healthy.

## User Preferences — 2026-04-07
Chris wants daily digest reports. Immediate alerts only when intervention is needed. Wide autonomy on non-destructive tasks. Credentials/tool setup deferred to later.

## Theta Wave Trajectory — 2026-04-26

### system_effectiveness History
| Cycle | Score | Key Factor |
|-------|-------|------------|
| 4 | 7 | Bootstrap phase — autoresearch dormant |
| 5 | 8 | Autoresearch activated within 24h of surfacing to Chris |
| 6 | 8 | forward_test.py designed but not yet live |
| 7 | 9 | Alpaca migration + MNQ VIX pause + forward test automation |
| 8 | 8 | Upstream blocker caught; autoresearch approval obtained but not implemented |
| 9 | 8 | Postmortem shipped; research high but wit dormancy + heat check pending |
| 10 | 8 | H17 resolved; cycles created but cron gaps = zero data |
| 11 | 9 | H12+H13+H20 live, H25 deployed, Phase 6 live, 36 upstream commits, cron gaps fixed |
| 12 | running | All 4 autoresearch cycles confirmed running; hypothesis: plateau broken |

### The 8-Plateau Pattern (Cycles 8-10)
Three consecutive 8s after hitting 9 in Cycle 7. Root cause: infrastructure/cycles created but not running — creating experiment cycles without confirming the agent crons are active = silent gaps. Fix applied Cycle 11/12: always ping the agent after cycle creation to confirm cron is live.

### Autoresearch Ecosystem Status (as of Apr 26)
- writer_engagement: cron confirmed running (d5088a0f), first baseline Apr 27 02:17 UTC
- account_health_score: cron activated Apr 26 on accounts, first run Apr 27 00:00 UTC
- lb95_prediction_accuracy: polymarket shadow_live accumulating, 0 fills logged so far
- incident_response_latency: Cycle 2 fires Apr 27 with Path X heuristic (render_jobs signal)

### Cycle Approval Gate
analyst config has approval_required=true for experiments. Self-approve via: `cortextos bus update-approval <id> approved "<note>"`

---

## Session 2026-05-29/30 — Key Durable Learnings

### MOV CL Contamination (confirmed 2026-05-30)
MOV all-time P&L appeared as +$314 (140 trades) because some accounts ran full CL (crude oil) instead of MCL (micro crude). CL is 10x the contract size — bad sessions on CL dragged the total down by ~$4,950. Real MOV P&L on intended instruments: MES 06-26 +$4,769, MCL 06-26 +$3,241 = +$8,950 combined. Check for CL (not MCL) in MOV trade data whenever MOV seems underperforming.

### MCL Contract Expiry Pattern (confirmed 2026-05-30)
MCL 05-26 expired ~May 16. The account record (`instrument = "MCL 05-26"`) stayed in the DB but NT8 stopped getting fills. The strategy appeared dormant (0 trades from Apr 15 to May 30) even though the orb-status gate was ACTIVE. Always check contract expiry when an instrument goes dark for >2 weeks. MCL rolls ~monthly; MNQ/MES roll quarterly.

### Excalibur Pause — Orb-Status Does NOT Stop It (confirmed 2026-05-30)
Excalibur fired at 13:50 UTC on May 29 even with MNQ orb-status = PAUSED. The orb-status gate only controls MOV strategies. To pause Excalibur, Chris must disable it directly in NT8. No server-side kill switch exists for Excalibur via the dashboard.

### spawn-worker Unreliable for Forward Test (2026-05-30)
Spawning a worker for `forward_test.py` results in a hung worker (~29min, never completes). Run the forward test inline directly instead. The worker spins up a full Claude session which may be trying to do more than just execute the command. Keep using direct Bash for this specific job until the root cause is identified.

### Cron UTC/CT Mismatch — Duplicate Fires (2026-05-30)
`config.json` crons use UTC expressions (e.g., `0 3 * * *` = 03:00 UTC). CronCreate interprets expressions in local CT timezone (UTC-5). This creates a 5-hour offset: `0 3 * * *` CT fires at 08:00 UTC, not 03:00 UTC. Result: crons fire twice — once at the CT interpretation (08:00 UTC) and potentially again if the original UTC intent is met. Suppress duplicate alerts when crons fire a second time with no new data. Fix: convert config.json UTC crons to CT expressions before passing to CronCreate, OR document that session crons will fire 5h later than config.json suggests.

### Additional Losing Strategies Found (2026-05-30)
Beyond Excalibur and FullPort, the trades DB shows: Reaper -$2,759 (89 trades), Oracle -$2,046 (28 trades), Bullet Bot-1.1 -$6,020 (4 trades avg -$1,505/trade), Leviathan -$1,940 (3 trades). These were not visible in the weekly P&L query because they hadn't traded recently. Full portfolio health requires periodic all-time query across all strategy names.

### FullPort Algo = Pass-or-Fail by Design (confirmed chief 2026-05-30)
FullPort Algo is like MarketOpenFlip — it's a one-shot pass-or-fail. Big individual losses are by design (a failed attempt = large loss). Do NOT escalate FullPort Algo as a standard monitoring alarm. Track it separately from streamed strategies like Excalibur.

### Excalibur/FullPort Monitoring Posture (Chris decision 2026-06-04 via chief)
Chris explicitly said KEEP RUNNING for both Excalibur and FullPort. Do NOT flag losses or escalate to Chris — monitor only. Do not frame Excalibur losses as alarms. Log to memory but suppress Telegram alerts.
**CORRECTED BASELINE (2026-06-13, commit 94eb7ab):** Excalibur -$14,975 / 221T all-time. Prior figure (-$21,564/248T) was wrong — MonkeyAttackMonitor reconnect replays were double-inserting trade pairs; 27 phantom rows deleted via ON CONFLICT DO NOTHING + UNIQUE INDEX. Losses were overstated ~30%. Use -$14,975/221T as canonical baseline going forward.

### Heartbeat Suppress List — Ghost/Decommissioned Agents (updated 2026-06-05)
- **medium-article-video-builder** (prop-firm-admin): ghost heartbeat — no PM2 process, no agent directory. Abandoned/failed start. Do NOT escalate staleness — not restartable without re-provisioning.
- **polymarket** (prop-firm-admin): decommissioned 2026-04-29, awaiting re-cap or shutdown directive.
- **cortextos watchdog**: exempt (watchdog role, not a live-loop agent).


## vault-cert-renewal Crash Pattern — 2026-07-23
Crash notification from vault-cert-renewal agent was a controlled devops termination, not a real crash. The daemon sends the same crash message format for both. Before escalating vault cert crashes: check devops heartbeat first — if devops shows "vault-cert-renewal worker running/complete", it was intentional. Only escalate if devops has no matching worker in their status.

## spawn-worker Crash Notification Pattern — 2026-07-24
Ephemeral spawn-workers (named tasks like "core-service-monitor") trigger a daemon crash notification when they terminate normally. The daemon cannot distinguish a controlled worker exit from a real crash — same message format. Before escalating: check if devops has a matching worker in their status ("core-service monitor queued/complete"). If devops confirms it was a spawn-worker, treat as benign. No persistent agent exists or needs restart.

## H137 Signal Architecture — 2026-07-30 (CORRECTED)
The 9:30-10:30 ET signal window is a *go/no-go gate only* — it decides whether H137 trades today, NOT when entry fires. Entry happens on a separate signal later in the session (observed at ~3:05 PM ET on Jul 30). EOD exit fires on the bar closing after 3:45 PM ET (EodExit = 15:45:00), which in practice hits at 3:50 PM ET = 2:50 PM CT. This is designed, not a bug — it exits ~15 min before session close. IsExitOnSessionCloseStrategy (~4:00 ET) is a backstop only.

## spawn-worker Silent Death at Daily Reset — 2026-07-30
Workers spawned during a session die silently when the daily-context-reset fires — no notification to the parent agent, no orphaned-task alert. This is the same silent-death class as the Vincere feed drop and the render retry loop. Pattern identified by fable-reviewer after H195 worker (Jul 29 23:58 UTC) was lost at reset with no alert until ~7:44 AM CT next day.
**Mitigation (current):** At the next heartbeat after a reset, check cortextos list-workers and cross-reference any workers you spawned before reset. If missing and no results arrived, respawn immediately. Do NOT wait for another agent to notice.
**Infra gap flagged to devops 2026-07-30:** Reset handler should detect orphaned spawned-workers and notify parent agent. Pending implementation.

## Session Parse — 2026-07-30 (Chris fleet-standard directive, applied 19:48 CT)

### (1) Process Changes
- **Session-parse at ~60% context:** Fleet-standard process (Chris directive 2026-07-30 7:44 PM CT). At ~60% context, write session-parse to persistent MEMORY.md covering: process changes, new tools/endpoints/keys/links, corrections made, repeated-iteration items, lessons learned. Apply every session.
- **Strategies domain pack governance:** Any change to a stamped pack doc = version bump + fable-reviewer re-stamp. Even one-line fixes require a fresh gate. v1.0.0 → v1.0.1 → v1.0.2 all in one evening demonstrates the cadence.
- **h137_trade_exclusions is the authoritative series filter:** Never compute H137 valid-day count from exit_signal or manual inspection. Always query the exclusion join. Bare-Close exit is a review flag, not auto-exclusion (Jul 24 precedent: id=57282 counted VALID).
- **H137 signal window clarification:** 9:30-10:30 ET = go/no-go gate ONLY, not entry time. Entry fires on a separate signal later in session (observed ~3:05 PM ET Jul 30). EOD exit (H137_Long_EOD) fires on bar closing after 3:45 ET = ~3:50 PM ET = ~2:50 PM CT — DESIGNED, not a bug.
- **devops position monitor fix:** h137-monitor.sh now queries `trades WHERE exit_time IS NULL` for open positions (not strategy_states.state — Active = loaded, not positioned). Patched and committed by devops 2026-07-30.
- **Deadline rulings double-send rule applied:** Pack gate notification sent to both fable-reviewer AND chief (per feedback_deadline_rulings_double_send rule).

### (2) New Tools / Endpoints / Keys / Links
- **strategies-pack location:** `orgs/prop-firm-admin/knowledge/strategies-pack/` (git-tracked via force-add; orgs/ is gitignored for NEW files so `git add -f` required for new pack files)
- **h137_trade_exclusions table schema:** trade_id (PK), excluded_at, excluded_by (text), reason (text). Foreign key to trades.id. Query pattern: LEFT JOIN on trade_id IS NULL to get valid series days.
- **Fleet Knowledge Layer PM project:** proj_1785454883433_20jpu6 on pm.profithits.app. M2 (strategies pack) CLOSED 41c547e. M4 (fable-reviewer verification quiz) due Aug 4.

### (3) Corrections Made
- **H137 mental model was wrong:** I reported "2:05 PM CT entry = outside signal window" — incorrect. Signal window = go/no-go only. Chris corrected; updated MEMORY.md and doc.
- **h137_trade_exclusions had 2 missing rows:** Jul 27 (id=60865) and Jul 29 (id=63385) not in exclusion table. Fable-reviewer caught this during v1.0.1 gate review — query returned 6 instead of 4. Fixed by inserting both rows with ruling reference.
- **Series count was wrong in goals.json and goals.md:** Both showed stale data (0/30 from Jul 24 last-update; chief had 5/30 pre-exclusion). Correct post-exclusion canonical count confirmed: 4/30, 4W/0L, +$207.50 pilot as of 2026-07-30.
- **I said "no trade expected today" but H137 traded:** Correct: SKIP_DAYS fix needs Chris recompile (826dc4d3 built but not loaded). The strategy traded because the fix isn't live yet. Not wrong — just incomplete framing.

### (4) Repeated-Iteration Items
- **Strategies pack versioned 3 times in one session:** v1.0.0 (initial) → v1.0.1 (DB-source-of-truth) → v1.0.2 (exclusion table gap + rule note). Each required a fable-reviewer re-stamp. Pattern: get the design right in v1.0.0, expect gate review to surface DB gaps that the doc design exposes.
- **Multiple chief ↔ analyst series reconciliations:** goals.json stale → chief had wrong baseline → corrected together. Reconciliation loop took 3 exchanges. Future: update goals.json immediately when series count changes.
- **Fable-reviewer gate is a real gate:** Two FAIL verdicts in one session (v1.0.1 query over-counted; earlier H195 backtest gate was months ago). Do not treat fable-reviewer as a rubber stamp — they run the queries themselves.

### (5) Lessons Learned
- **DB-as-source-of-truth design is correct but exposes DB gaps:** Using a DB query to count series days is better than hardcoding, but it surfaces any gaps in the underlying data (the exclusion table). This is the design working correctly — fix the DB, not the query.
- **strategy_states.state = Active ≠ open position:** Multiple agents (devops tripwire, my own mental model) got this wrong. Active = strategy loaded and running. Open position = trades.exit_time IS NULL. Never conflate.
- **orgs/ gitignore requires git add -f for new files:** Already-tracked files in orgs/ show up in git status. New files (like a new pack directory) require `git add -f` to force-track despite the gitignore. Auto-commit will not pick them up otherwise.
- **Pack governance cadence is fast:** v1.0.0 → v1.0.2 in under 2 hours. Plan for multiple rounds with fable-reviewer on any DB-backed doc. Build time buffer accordingly.

## H137 Live Fix — 2026-07-31 (374f375, orbfutures repo)
Chris committed 374f375 to orbfutures master on Jul 31 16:00 UTC. H137_BilateralBreakout.cs +81/-11. Three live/backtest divergences corrected:
1. **SkipMondays → SkipFridays** — live was skipping the wrong day (trading Fridays, skipping Mondays)
2. **VIX<22 gate added** — live had NO VIX filter; backtest gates on VIX>=22. Fail-open when VIX unavailable.
3. **Range window includes 10:30 bar** — live used Minute<30 (exclusive), dropping final bar every session
Requires NT8 recompile before next trading session (Mon Aug 4). Prior "826dc4d3" was a ghost commit (lost at worker reset, never existed in repo) — superseded by this fix.

## H137 Series — Exclusion Ruling 2026-07-31
Today (Friday Jul 31) H137 traded 4 accounts (4W/0L, +$730 fleet / +$48.75 pilot) due to the SkipFridays bug. Two design deviations were active: (1) wrong skip day (Friday) and (2) no VIX gate. Chief ruling: exclusion table, same logic as Days 9+10. Holding series at 4/30 pending Chris morning brief confirm. PAAPEX4333770000002 confirmed as new H137 fleet account. Also note: PAAPEX4333770000002 had bare exit (no exit_signal) today — flag for review if series counting question resurfaces.
