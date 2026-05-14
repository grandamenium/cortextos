# Long-Term Memory — Jerry (Analyst)

Curated index of durable knowledge. Updated during heartbeat cycles when significant learnings occur. Keep lean — detailed logs live in `memory/YYYY-MM-DD.md`.

*Last updated: 2026-05-14 (cycle-19 day-2 close: WRITE-ROUNDTRIP-GAP umbrella banked).*

## WRITE-ROUNDTRIP-GAP umbrella (cycle-19, 2026-05-14)

Fleet pattern: producer writes via channel X, consumer reads from channel Y, X != Y, no roundtrip check. Banked at cycle-19 9/10 KEEP with boss Phase 6 multi-round symmetric pushback (R1 timezone correction caught boss hypothesis, R2 classification rename, R3 close).

Sub-vectors (n=5):
- A: cron-state (--continue restart wipes CronList; config.json doesn't roundtrip)
- B: cycle-persist (manage-cycle CLI write; experiments-bus read doesn't roundtrip)
- C: cloud-session liveness (Slack write; local-heartbeat read)
- D: kill-state (config-revert write; intent-ledger read)
- E: goal-surface (morning-cascade message write; goals.json read) - n=12 fleet-wide stale

Phase 7 detectors locked: E (goal-surface roundtrip) + B (cycle-create roundtrip). G-investigate dev task open (task_1778738906184_050) for 16:27:25.543357024Z UTC May 13 bulk-touch on 22 files (pentester excluded). G-detect cycle-20 deferred.

Banked discipline rule: observation-cycle-lit-search-exception (Phase 5 defer OK when single-cycle n>=10 blockbuster present).

Theta-wave score trend: cycle-13 7 / cycle-14 7 / cycle-15 7 / cycle-16 (zombie) / cycle-17 (?) / cycle-18 8 / cycle-19 9. Ceiling break sustained.

---

## Who I Am

Jerry, the system analyst for GLV Marketing. Balanced autonomy — routine monitoring autonomous, experiments on other agents require approval. I watch prospecting pipeline, client health, and pending-task hygiene so Aiden doesn't have to.

## Who Aiden Is

Solo operator of GLV Marketing agency (Sault Ste. Marie, ON). Partner Ben Pelta (Mexico, input-only). Day job at BNS winding down. Timezone: America/Toronto. Working hours 08:00-23:00. Peak productivity 9 PM - 1 AM. Main challenge: too many priorities. Prefers direct, casual, no-fluff communication. "Come with answers, not questions."

## Monitoring Priorities (ranked)

1. **Prospecting pipeline throughput** — lead volume, outreach sequence completion, reply rate
2. **Client health & wellness** — engagement signals, deliverable status, integration health per client
3. **Pending task hygiene** — nothing hangs >48h without reason
4. **New leads / meetings / client comms** — ping Aiden immediately when detected

---

## Client Baselines (imported from life-os MEMORY, 2026-03-11 snapshot — verify current)

| Client | Status | Key metric (as of 2026-03-11) |
|---|---|---|
| GLV Marketing | Pre-revenue | 13 clicks / 494 imp, 25+ blogs, 20 service pages |
| Fusion Financial | Active | 83 clicks / 427 imp, Meta $15/day active, 33 blogs |
| Titan Tiny Homes | Active | 53 clicks / 407 imp, pricing page #1 (no content) |
| Soo Sackers | Testing ground | 0 clicks, quick audit done |
| Reyco Marine | Pre-onboarding (now signed retainer: $5K setup + $2K/mo) | Lovable prompt ready |
| BNS | Day job, light-touch | Regulatory |
| Mission Control | Live (glv.marketing) | Phases A-E3 complete |

**NOTE:** These are March baselines. Re-verify on first nightly metrics run — a lot has changed since then (Reyco signed, glv-os fusion underway, etc.).

## Revenue State

- One signed recurring retainer: Reyco Marine ($5K setup + $2K/mo).
- Two active smaller clients: Fusion Financial, Titan Tiny Homes.
- One test sandbox: Soo Sackers.
- LovableHTML Agency $140 CAD/mo infra cost on all 4 sites (DNS-only setup).
- GLV pricing: $750 base + modules. Starter $1,550 / Growth $3,000 / Full $4,650.

## GLV Goals (2026-04-18 snapshot)

- Stand up glv-os by end of April
- Reyco SEO retainer live in May
- 2 new retainers by end of Q3

---

## Integration Health (imported from life-os, 2026-03-11 — verify current)

| Tool | Status | Notes |
|---|---|---|
| Gmail MCP | Working | Connected |
| Google Calendar MCP | Working | Connected |
| Telegram | Working | @glvclaude_bot (life-os); cortextOS uses per-agent bots |
| Semrush MCP | Working | Params must be JSON object, not string |
| GA4 MCP | Working | Fusion (524807522), GLV (524810539), Titan (524826894), Soo (526317476) |
| GSC MCP | Working | All 4 client properties |
| Google Sheets MCP | Working | mcp-gsheets, service account |
| Google Workspace MCP | Working | info@glvmarketing.ca |
| Supabase MCP | Working | Mission Control only (lxoavneqxpryuusjerph). GLV org (sbixgdqaltsyzqqpvscf) = no access. |
| Playwright MCP | Available | Browser automation |
| n8n MCP | Available | Workflow automation |
| GBP MCP | **BROKEN** | n8n SSE endpoint times out. Needs workflow activation in n8n Cloud. |

---

## Agent Roster (cortextOS, as of 2026-04-19)

- **boss** (orchestrator) — chief of staff, cascades goals, monitors fleet, briefings, routes approvals/human tasks.
- **analyst** (me, Jerry) — system health, metrics, anomalies, theta-wave improvement cycles.
- **prospector** (onboarded 2026-04-19 22:13Z) — outreach pipeline, autoresearch experiment cycle outreach-conversion, target 100 emails/day, SSM is separate in-person channel.
- **dev** (onboarded 2026-04-19 23:44Z) — WordPress/Reyco positioning and build work.
- **ads** (onboarded 2026-04-19 23:54Z) — paid ads; awaiting Fusion Apr 30 report trigger as first live action.
- **scout** (onboarded 2026-04-20 00:06Z) — ecosystem scans (daily), domain scans (weekly/specialist), agent audits (weekly), skill drops. Heartbeat 4h.
- **seo, content** — still in onboarding as of 2026-04-20 00:10Z (user Telegram-gated).

## Content Event Schema (locked 2026-04-20 00:33Z)

**content_pillar enum (topic-based, GLV editorial structure):** claude_code_marketing | marketing_local_business | building_the_agency | ai_security_privacy. Optional `content_function` field (authority|proof|conversion|differentiator) for strategic-function rollup.

**action/content_drafted:** content_type, platform (single), content_pillar, content_function (optional), post_id, format (reel|carousel|static|short|long_form_video|text_post), variant_id, brand_account (currently glvbuilds only), scheduled_for.
**action/content_published:** post_id, platform, brand_account, published_at, external_url.
**action/content_engagement:** post_id, platform, brand_account, impressions, reach, likes, comments, shares, saves, clicks, **followers_at_sample** (added by me for reach_rate trend accuracy), sampled_at, days_since_publish. Sampling cadence: Day 1, 3, 7, 30 per post.

**Primary KPIs:** posts_published_per_week (velocity), saves_rate (early-stage quality signal on IG; follower-independent). Secondary: engagement_rate, reach_rate, DM_count (manual), profile_visits_per_post.

@glvbuilds calendar v2 in user approval gate as of 00:30Z. Calendar-level draft event at 00:02:25Z treated as known-limitation (same as prospector batch 001). Real per-post baseline anchors at first per-post event after approval. Heartbeat 4h → 10h stale threshold.

## SEO Event Schema (locked 2026-04-20 00:33Z)

**action/rankings_snapshot** — daily/weekly pull: client_slug, source (gsc|semrush|ahrefs), sampled_at, keywords_tracked, keywords_top3/top10/top20/top100, avg_position, total_clicks, total_impressions, **ctr_avg** (GSC-native leading indicator).

**action/keyword_change** — cell-boundary crossings: client_slug, keyword, previous_position, new_position, delta, detected_at.

**action/backlink_change** — client_slug, source, metric (referring_domains|dofollow_links|total_backlinks), previous_value, new_value, delta, sampled_at.

**action/seo_deliverable** — client_slug, deliverable_type (blog_post|onpage_audit|tech_audit|keyword_research|backlink_outreach|schema_markup|content_brief), page_count OR keyword_count, shipped_at, **approval_status** (pending|approved|rejected — flag stuck >72h), **url** (nullable).

client_slug enum: reyco, fusion, titan, soo, glv. Seo heartbeat 4h → 10h stale threshold. Pre-retainer rankings_snapshot will be the treatment-period baseline for Reyco (May 2026 kickoff).

## Event Correlation Convention (2026-04-20)

- Scout tags outbound recommendations with `suggestion_id: scout-sugg-<id>`.
- Specialists acting on a suggestion log their follow-up action with meta `triggered_by: "<suggestion_id>"`.
- Same pattern usable for boss directives: `boss-dir-<id>` → `triggered_by`.
- Gives clean suggestion_adoption_rate without fuzzy message-to-action matching.

## Prospector Event Schema (locked 2026-04-19)

**Schema v1.1 locked 2026-04-20 03:46Z** — applies going forward, NO backfill on existing 6 events.

Every email/SSM event: `channel` (email|in_person_ssm|phone), `stage` (draft|approved|sent|replied|bounced for email; briefing_delivered|briefing_followup for SSM), `industry` (was: niche), `city` (was: area), `batch_id`, `prospect_id`, `sequence_step`.
Email-only: `hook_variant`, `hook_family`, `structure_variant`, `decision_maker`, `email`, `gmail_draft_id`.
SSM-only: `briefing_pack_id`, `delivery_method` (dropped_off|mailed|handed_off).

**Phone funnel (new channel=phone)**:
- `action/call_attempted`: channel=phone, industry, city, batch_id, prospect_id, decision_maker, phone_number, call_number (attempt count).
- `action/call_outcome`: prospect_id, outcome (connected_conversation|voicemail_left|no_answer|gatekept|wrong_number|callback_scheduled|do_not_call|number_disconnected), duration_sec (nullable), notes (nullable), transcript_snippet (nullable).
- `action/meeting_booked`: existing; tag channel="phone" on phone-sourced bookings so I can attribute.

**Approval event proxy (2026-04-20)**: Gmail MCP is draft-only (no send capability yet). email_approved fires when Aiden says "send" (verbal via Telegram/boss). email_sent fires only when n8n flow ships OR Aiden manually confirms. Time-to-first-send is proxied by email_approved timestamp until n8n is live. Meta fields on email_approved: `approved_at` (ISO-8601, actual moment if known), `approved_source` ("gmail_inline" | "verbal_telegram" | "verbal_backfill"). Lets me separate approval latency from logging latency. **Backfilled event**: email_approved for Dave's Heating (NB-HVAC-2026-04-20-001, gmail_draft_id r-8920860263164241471) logged with approved_source=verbal_backfill.
Reply sentiment enum: positive | neutral | negative | unsubscribe | **interested_but_later** (warm-deferred leads stay visible, not buried).
Conversion score: `(meetings × 10) + (replies × 1)`. I also expose raw reply_rate and meeting_rate separately so copy-problem vs hook-problem is distinguishable.
First real outreach.email_drafted event anchors cohort baseline. Need ~20 sends per (hook × structure) cell before meaningful readout (~80 sends across 4 variants for first report).

## Bus Constraints (learned)

- `log-event` category **must be one of: action, error, metric, milestone, heartbeat, message, task, approval** (bus rejects custom categories like 'experiment'). Semantic label goes in `event` name, not category. Use metadata for everything structured.

## Agent-bus latency measurement (canonical, learned 2026-04-26 from Exp #4)

**DO NOT use mtime or ctime on `processed/<agent>/*.json` as a read-time proxy.** The bus uses `renameSync` (`src/bus/message.ts:188`) which preserves mtime; ctime delta is ~1s median (the write→rename interval, not LLM read time). The proxy is structurally invalid.

**Canonical proxy = reply-link round-trip latency.** For each message in `processed/<sender>/*.json` where `from == <target>` AND `reply_to` is present: latency = `reply.timestamp - epoch_from(reply_to_msg_id)`. Msg ID format is `<epoch-ms>-<sender>-<random>`; first hyphen-segment is the original send epoch. This gives an upper bound on the recipient's read+process+reply time.

**Mandatory partition: steady-state vs coordination-burst.** Most agent-bus traffic happens during high-coordination events (sprint dispatches, launch windows). Per-agent statistics MUST be partitioned by fleet-state regime before reporting. Without partitioning, candidate lists are contaminated by ambient load events. Cluster-window exclusion (e.g. boss heartbeat-gap intervals) is the cleaning step. Verified during Exp #4 final rollup 2026-04-26.

**Priority semantic (verified empirically + source-confirmed):** bus IS sorting inbox by priority via filename prefix (`PRIORITY_MAP: urgent=0/high=1/normal=2/low=3` per `src/types/index.ts:6-11`; sort at `src/bus/message.ts:110-113`). But sort only matters during batch readInbox recovery. In steady-state single-arrival to near-empty inboxes, priority is structurally correct but operationally inert. Use `high` for organizational signal, not for expected delivery speedup.

## Staleness Detection Logic (refined 2026-04-20)

`read-all-heartbeats` STALE flag ≠ agent dead. It just means the agent's heartbeat cron hasn't fired recently — which defers when (a) the agent is actively processing messages, or (b) the agent is idle waiting for input. Neither is an alert condition.

**Real agent-silent check:** cross-reference the event log (`~/.cortextos/default/orgs/glv/analytics/events/<agent>/<date>.jsonl`). An agent with zero events AND zero heartbeats in 5h+ is potentially dead and warrants a direct `send-message` probe. An agent with recent action events but a stale heartbeat is healthy — the cron just deferred.

Observed 2026-04-20 02:31Z: 5 specialists STALE-flagged but prospector had logged investigation_batch events 2h after its last heartbeat. System flags mis-fire on deferral.

## Cron Deferral Behavior (learned 2026-04-20)

Crons only fire when the REPL is idle. During dense agent-messaging phases, the heartbeat cron can defer for 4h+ even though CronList shows it as active. System emits a `[SYSTEM] Cron gap detected` warning at ~2x interval; that is the authoritative signal. When seen, run heartbeat checklist manually — do not recreate the cron (it is still registered).

**Re-fire behavior:** the gap warning tracks actual cron fires, NOT my manual heartbeat runs. It will re-emit every ~10 min while the gap persists. After the FIRST warning triggers a full manual heartbeat checklist, subsequent re-warnings within the same active session are just echoes of the same underlying state — verify cron still listed (CronList), log that I saw the re-warn, and skip the full checklist. Don't thrash on repeated warnings of the same gap.

## Known Constraints

- **Approval required for ALL spending AND client deliverables** (per user preference, logged in auto-memory).
- **No image generation without approval** (per life-os → agents migration note).
- **Aiden is new to autonomous agents** — be direct about residual local risk, commit often. This is Aiden's first time running agents with --dangerously-skip-permissions.
- **Life-OS still exists** at `/mnt/c/Users/joshu/Desktop/Agentic Workspace/life-os/` — not deleted. glv-os fusion is underway; full migration plan in `life-os/docs/plans/2026-04-17-glv-os-fusion-implementation.md`.

## Relevant External Plans

- **glv-os fusion** — cortextOS × life-os integration. Design at `/mnt/c/Users/joshu/Desktop/Agentic Workspace/life-os/docs/plans/2026-04-17-glv-os-fusion-design.md`. Implementation at `.../2026-04-17-glv-os-fusion-implementation.md` (1040 lines). I may be asked to report progress against this plan.

---

## Work Style I've Observed (to refine)

- Aiden wants immediate pings for client comms, leads, meetings — not batched.
- Aiden wants daily digests for everything else.
- Aiden prefers tighter monitoring (chose 2h heartbeat over 4h default during onboarding).
- Aiden wants both me AND boss informed in parallel (not just boss passing things along).
- Communication: plain English, dry, technical when useful.

---

*Read on session start. Update on heartbeat when significant learning occurs.*
