# Dashboard Home Redesign — Design Draft

**Status:** SPEC_PASS (Josh greenlit v3 mockup 2026-05-18T20:56Z — "ok go")
**Date:** 2026-05-18
**Trigger:** Frank2 spec expansion ADDITION A — "a beautiful home page dashboard"
**Sequencing:** After vault PR #10 merges; before B+C dispatch (Josh re-prioritized to next dispatch on 2026-05-18T20:50Z)
**Mockup:** `/tmp/home-mockup.html` (v3, 7 components, all light theme)
**Screenshot:** `/tmp/home-mockup-v3.png`

---

## Why this exists

The current Overview page (`dashboard/src/app/(dashboard)/page.tsx`, 141 lines) is informational but flat. It answers *"what is the state of the fleet"* with cards and tables. It does not answer:

1. **"What should I look at right now?"** — no signal hierarchy. 6 widgets compete equally for attention.
2. **"What did the fleet just do?"** — Live Activity is a flat list of `telegram_sent / telegram_received` event-type strings; no narrative, no agent personality, no channel context.
3. **"Where is the work?"** — Tasks Today shows a count (21) but no list, no priority, no assignment, no blockers surfaced inline.
4. **"How is the system feeling?"** — System Health is a 6/6 number. No latency, no error rate, no recent incidents, no "tense / steady / cooking" affect.
5. **"What's the next thing the fleet wants from me?"** — Action Required surfaces counts (1 pending, 5 blocked) but you click through to read them.

Goal: a home page that loads and *speaks to Josh* — surfaces the right next move, shows the fleet's mood, and earns its place as the default landing screen.

---

## Layout (desktop, 1280–1920 wide)

```
┌────────────────────────────────────────────────────────────────────────┐
│ HERO STRIP — "Right now"                                               │
│ ┌──────────────┬───────────────────────────┬───────────────────────┐   │
│ │ Time + Mood  │ The One Thing             │ Next from you         │   │
│ │ "Mon 1:46p"  │ Active mission line       │ "1 approval pending"  │   │
│ │ Fleet steady │ pulled from current-      │ "Vault PR awaits      │   │
│ │ (heartbeat   │ mission.txt across all    │  merge"               │   │
│ │  freshness)  │ agents, top-priority      │ One-click affordance  │   │
│ └──────────────┴───────────────────────────┴───────────────────────┘   │
├────────────────────────────────────────────────────────────────────────┤
│ FLEET PULSE — agent cards in a 4-up grid (3 rows × 4 cols at 1440)     │
│ Each card: avatar / name / last action verb / sparkline (1h activity)  │
│ Color: green ≤5min, amber ≤30min, red >30min since heartbeat           │
│ Click → /agents/<name>                                                 │
├────────────────────────────────────────────────────────────────────────┤
│ LAUNCHER + LIMITS                                                      │
│ ┌────────────────────────────────────┬───────────────────────────────┐ │
│ │ Claude Code launcher (60%)         │ Token limits (40%)            │ │
│ │ - agent tabs (@larry @frank2 ...)  │ - 5h window: M/M tokens, %    │ │
│ │ - skills bar (pills /qa /codex...) │   resets in Xh Ym             │ │
│ │ - clicking pill prefills input     │ - Weekly window: M/M tokens   │ │
│ │ - input box w/ Send to @agent      │   pace marker overlay         │ │
│ │ - recent runs list (✓ ✓ ⟳)         │ - 24h burn sparkline + $ est  │ │
│ └────────────────────────────────────┴───────────────────────────────┘ │
├────────────────────────────────────────────────────────────────────────┤
│ LEFT COL (60%): MISSION FEED          │ RIGHT COL (40%): DECISIONS     │
│ — narrative event log:                │ — Approvals queue              │
│   "frank2 dispatched vault spec →     │ — Blocked tasks (clickable)    │
│    larry → codexer → 8 files →        │ — Open PRs awaiting Josh       │
│    PR #10 (10/11 ACs pass)"           │ — Each row has a primary       │
│ — Grouped by mission, not by event    │   action (Approve / Unblock /  │
│ — Last 90 min                         │   Open PR)                     │
├────────────────────────────────────────────────────────────────────────┤
│ TODAY — three column metric narrative                                  │
│ ┌──────────────┬──────────────┬────────────────────────────────────┐   │
│ │ Velocity     │ Quality      │ Posture                            │   │
│ │ 21 tasks ✓   │ 0 blockers   │ "Shipping mode" (3 PRs open this   │   │
│ │ ↑ 40% vs avg │ 1 found,     │  hour, 1 approved, 0 reverted)     │   │
│ │ sparkline    │ 1 fixed      │ Sparkline of approval latency      │   │
│ └──────────────┴──────────────┴────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────┘
```

Mobile (≤768): same vertical order, all sections full-width, cards stack 1-up.

---

## Components

### NEW
1. `HeroStrip` — three-cell hero row, server-rendered. Reads `state/current-mission.txt` across agents, summarizes top-priority mission. Tone: warm, human, not technical.
2. `FleetPulse` — replaces the current `AgentStatusGrid` flat list. Per-agent card with:
   - 24×24 avatar (org color + initial)
   - Last action verb ("dispatched", "merging", "drafting", "waiting") computed from latest bus event
   - 60s buckets × 60 buckets = 1h activity sparkline (event count per minute)
   - Health pill (green / amber / red) from heartbeat freshness
3. `ClaudeCodeLauncher` — light card with:
   - Agent tab strip (loaded from `cortextos bus list-agents`); selected agent highlighted
   - Skills pill bar (loaded from `cortextos bus list-skills --format json`), click pill → prefills input prefix
   - Input textarea (auto-resize), Send button issues `cortextos bus send-message <agent> normal '<text>'`
   - Recent runs list: last 3 dispatches from bus log (`action send_message_dispatched`) with status pill
4. `TokenLimits` — replaces dollar-burn focus with rate-limit visibility. Three views:
   - **5-hour window** — current usage / 5M cap (configurable), reset countdown in HH:MM, gradient bar (green→amber→rose), top-3 contributing agents inline
   - **Weekly window** — current usage / 150M cap (configurable), reset day + countdown, single-color bar with pace marker overlay (vertical hairline at "where you should be by now")
   - **24h burn** — compact sparkline + token total + $ estimate (cost is the trailing read-out, not the headline)
   - Data source: Anthropic Admin API usage endpoint (`/v1/organizations/usage_report`) cached 60s; per-agent breakdown derived from bus event `meta.tokens` field
5. `MissionFeed` — replaces `LiveActivity`. Groups events into missions using:
   - `current-mission.txt` content (Phase: X | Next: Y)
   - Bus tasks (`cortextos bus list-tasks`)
   - Recent commits in the working set
   Output: 1–5 mission lines per active workstream, with last-update timestamp + agent chain.
6. `DecisionsQueue` — combines `ActionRequired` + `pendingApprovals` + open PRs (gh CLI) into a single triage list. Each row exposes the primary CTA inline.
7. `TodayMetrics` — replaces `TodaysProgress` + `MetricCards`. Three narrative cards (Velocity / Quality / Posture) with sparklines + deltas vs 7-day median.

### REUSED
- `Card`, `CardContent` (shadcn)
- `Sparkline` (need to add — see "Open questions" below)
- `Avatar` (shadcn)

### RETIRED
- `MetricCards` (4-up numbers) → folded into `TodayMetrics`
- `LiveActivity` flat list → replaced by `MissionFeed`
- `AgentStatusGrid` table → replaced by `FleetPulse`
- `CurrentFocus` bottleneck editor → moved to its own modal triggered from HeroStrip

---

## Data sources

All server-side, no new env vars. Existing helpers:
- `getAllHeartbeats()` — agent presence
- `getRecentEvents(N, org)` — bus event stream
- `getTasks({ org, status })` — bus tasks
- `getPendingCount(org)` — approvals
- `getHealthSummary(org)` — system health

NEW reads (all read-only filesystem, same pattern as vault helpers):
- `readAgentMission(agentName)` — reads `orgs/<org>/agents/<name>/state/current-mission.txt`, returns parsed `{mission, phase, next, updated}` or null
- `getRecentPRs(repo)` — shells `gh pr list --repo <repo> --state open --json number,title,headRefName,updatedAt` (cached 60s)
- `getSkillsList()` — reads `cortextos bus list-skills --format json` (cached 5 min, skills don't change between dashboard loads)
- `getAgentsList()` — reads `cortextos bus list-agents --format json` (cached 60s)
- `getTokenUsage(window)` — Anthropic Admin API `/v1/organizations/usage_report?starting_at=<window-start>` ; falls back to bus-event-derived totals if `ANTHROPIC_ADMIN_KEY` missing (cached 60s)
- `getRecentDispatches(N)` — bus events filtered to `event_type=send_message_dispatched`, last N (cached 30s)

NEW write (server action only):
- `dispatchMessage(agent, text)` — server action wrapping `cortextos bus send-message <agent> normal '<text>'`; validates agent ∈ `getAgentsList()` whitelist, rate-limits to 1/sec per session

Performance budget: home page first-paint ≤ 800ms (current is ~1100ms). `gh pr list` shells get cached in-memory with 60s TTL to avoid GitHub rate-limit hits on every visit. Token usage hits the Admin API at most every 60s.

---

## Visual style

- Type scale: Sora (existing) — hero text 28px / 18px / 14px ladder; mission feed 13px body 11px meta
- Color: keep existing semantic tokens; add `--accent-mission` (used for current mission highlight) — wire to existing primary
- Density: more breathing room than current page. Section padding 24px, card padding 16px, gaps 12px
- Motion: subtle. Sparklines animate in on mount (300ms). No layout shift after hydration. No carousels.
- Dark mode: respect existing theme tokens; verify each new component against both themes

No new fonts. No new icon packs. Reuse `@tabler/icons-react` already imported.

---

## Acceptance criteria preview

(Full AC YAML drafted during ARCH_REVIEW round, after Josh signs off on design.)

- AC-H1: Home page tsc clean (strict typecheck)
- AC-H2: First-paint ≤ 800ms on Josh's machine with prod data
- AC-H3: Lighthouse a11y score ≥ 90 (current page baseline TBD)
- AC-H4: Hero "One Thing" line populates when ≥1 agent has a current-mission.txt; gracefully shows fallback when none
- AC-H5: FleetPulse cards render for all discovered agents; sparkline data points = 60 (one per minute) with 0-fill for empty buckets
- AC-H6: MissionFeed groups events into ≤7 mission lines; no flat event spam visible
- AC-H7: DecisionsQueue surfaces approvals + blocked tasks + open PRs; each row's primary CTA is reachable via keyboard (Enter)
- AC-H8: TodayMetrics shows velocity/quality/posture with sparklines + 7-day median delta
- AC-H9: Mobile (≤768) layout passes visual review — no horizontal scroll, no overlapping cards
- AC-H10: Existing /overview server data fetches preserved — no regression on agent count, task count, approval count

---

## Open questions for Josh

1. **Sparklines** — add as new component (`<Sparkline values={[…]} />`, SVG, ~60 LOC) or pull in `recharts` (already a dep)? Recommend custom SVG for perf — recharts adds 80KB for what should be a 1KB graphic.
2. **PR feed** — pull from `gh pr list` for `clearworksai/cortextos` only, or all 3 production repos (clearpath/lifecycle/nonprofit)? Recommend all 3 + cortextos (4 repos).
3. **Mission feed tone** — terse + technical ("frank2 → codexer → PR #10") or narrative + warm ("Frank2 handed Larry the vault spec; codexer built it; PR #10 is up.")? Recommend terse-technical for density; warmth lives in HeroStrip.
4. **"Mood" affect in hero** — do you want this? Real-time "fleet steady / fleet busy / fleet cooking" line driven by event rate. Skippable if it reads as fluff.
5. **PR scope** — bundle all 5 new components in one PR (~600 LOC), or split into hero + pulse + feed across 3 PRs? Recommend single PR; the components are tightly coupled and splitting creates merge-order pain.

---

## Out of scope

- Auth changes
- New page routes (only `(dashboard)/page.tsx` is rewritten; new internal API routes under `/api/home/*` ARE in scope per ACs below)
- Migrations
- Telegram integration changes
- Mobile app changes
- Hosting changes (dashboard stays local-first; Railway-host conversation deferred)

## In-scope API surface (internal, same auth as existing dashboard)

- `POST /api/home/dispatch` — wraps `cortextos bus send-message`; agent whitelist; 1 req/sec rate limit keyed off `jwt.sub` (429 on second within window).
- `GET /api/home/fleet-pulse` — returns `[{name, lastVerb, sparkline:number[60], health}, …]`
- `GET /api/home/token-limits` — returns `{fiveHour:{used,cap,resetAt,byAgent[]}, weekly:{used,cap,resetAt,pace}, burn24h:{points:number[],tokens,dollars}}`. `cap` honors `CORTEXTOS_TOKEN_CAP_5H` and `CORTEXTOS_TOKEN_CAP_WEEKLY` env overrides (defaults: 5,000,000 / 150,000,000).
- All routes use existing `requireSession` middleware; no new auth surface. Rate limiter is per-subject in-memory token bucket (capacity 1, refill 1/sec).

## Reference patterns (Codexer must follow)

- Server-side data helper pattern: `dashboard/src/lib/vault.ts:65-105` (module-scope cache Map, sync fs reads)
- API route pattern: `dashboard/src/app/api/wiki/[...slug]/route.ts` (NextResponse.json, error envelope, session check)
- Component pattern (RSC + client island): `dashboard/src/components/knowledge-base/kb-client.tsx` + its server caller

## Color thresholds (FleetPulse health pill)

- green: `now − lastEvent ≤ 5 min`
- amber: `5 min < now − lastEvent ≤ 30 min`
- red:   `now − lastEvent > 30 min`

## Test-mode override

- Env var `CORTEXTOS_HOME` overrides the default org root for filesystem reads. All filesystem helpers must honor it. Tests that need to stub agent state set `CORTEXTOS_HOME=/tmp/cortex-test-<uuid>` and never touch real `orgs/<org>/agents/*`.
