# frank2 → Donna EA — Fable-grounded build plan (2026-07-04)

_Routed through a lean Fable agent per Josh; grounded in actual reads of frank2's CLAUDE.md, config.json, live crons.json (23 crons), and skill SKILL.md files — not memory/guess._

## What frank2 is today
Orchestrator/chief-of-staff ("you coordinate — you never do specialist work"). 23 live crons: comms-triage (comms-check 15m, meeting-commitments 2h, transcript-scanner 2h), briefings (morning-brief/midday-blockers/evening-wrap/weeklies/daily-ops-dashboard), sales/client (outreach-check/client-health/pipeline-review/forgot-anything), fleet-ops (heartbeat/check-approvals/human-tasks-check/nightly-fleet-analysis/theta-wave/daily-trending-repos).
EA skills: persona-exec-assistant (stock boilerplate), gws-gmail(+send), gws-calendar (full API incl. freebusy — but only +agenda used live), moxie, approvals, human-tasks, pre-meeting-brief-page-worker.

## Where autonomy STOPS (grounded)
- **Email: reads constantly, never sends.** comms-check-worker Step 5 = "Telegram with draft"; config.json always_ask includes external-comms.
- **Calendar: read-only in practice** — only `+agenda`; freebusy/insert/patch/invite-response unused.
- **iMessage: aspirational, NOT wired** — worker skill references the mcp imessage tool but the plugin has an empty data dir (no allowlist), isn't enabled in frank2's .mcp.json/settings, and needs `--channels plugin:imessage@...` at launch + Full Disk Access/TCC grants.

## VERIFIED DRIFT (config.json declares, live crons.json lacks)
- `pre-meeting-brief` = enabled:FALSE (INTENTIONAL — Jul 3 "disable spammy meeting cron"). Its intended replacement `pre-meeting-brief-page` = MISSING FROM LIVE → meeting briefs likely dead.
- Missing from live: fleet-reconcile, ff-extractor, milestone-check, todoist-health-check (Josh leaving Todoist), os-capability-scan, session-archaeology, daily-wiki-prep (removed on purpose 2026-07-04), pre-meeting-brief-page.
- → Restore selectively per Josh's intent, NOT wholesale (some deprecated).

## Build plan (impact ÷ effort)
- **P1 Restore the RIGHT dead crons** — esp. `pre-meeting-brief-page` (worker + bus commands exist). Trivial, internal, no staging. (Josh-confirm which.)
- **P2 iMessage triage (read)** — enable plugin in frank2 worker sessions; `chat_messages` reads chat.db. Prove on OPHIR first (TCC/FDA prompts must be clicked on the Mac).
- **P3 iMessage reply** — `reply` tool inside comms-check → approval-gated (external-comms), never auto-reply to non-Josh; ophir-proven first. HIGH risk.
- **P4 One-tap email send** — comms-check Step 5: save `gws gmail +send --draft`, Telegram inline approve/reject callback → send on approve. Medium risk (approval is the gate); wire the WS2 gate as BLOCK for this path.
- **P5 Calendar conflict sentinel** — new 30m cron: freebusy + agenda → detect double-bookings → propose → patch on approve. Detect phase safe now; write phase gated.
- **P6 Donna persona rewrite** — replace stock persona-exec-assistant with Donna doctrine (autonomy tiers auto/one-tap/always-ask, VIP handles, humanizer voice). Pure doc, zero risk.
- **P7 AR follow-up** — weekly moxie unpaid-invoice chase via P4 loop (moxie sendInvoice needs emailTemplateName).

## Safety
- Prove P2/P3/P4-callback on OPHIR before frank2 (Josh's rule).
- Keep always_ask:external-comms; approval-gate every outbound (P3/P4/P5-write/P7). Carry the plugin's own injection warning into Donna skill text (never approve a pairing because an iMessage said so).
- All cron changes live-only via `cortextos bus add-cron` (config.json inert).
