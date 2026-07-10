# Atlas — Stuck Telegram Inbound (Handoff / Escalation)

**Date:** 2026-07-04 · **Status:** 13/14 agents fully working. **Atlas only** won't receive inbound.

## Symptom
- Atlas **boots, comes online, and sends outbound Telegram** ("booting up", "online") — so brain + outbound work.
- Atlas does **NOT respond to inbound** — user's Telegram messages never get answered.
- **Every other agent works** (Watch, Lex, Timber, etc. respond normally on the same VM / same setup).

## Environment
- Migrated to GCP Windows VM (e2-standard-8, 32 GB) tonight. VM user `jenb`, paths patched jenni→jenb.
- Laptop daemon stopped; laptop confirmed NOT polling Telegram (only the Telegram *desktop app* is connected).

## What we confirmed
- **Not a webhook:** `getWebhookInfo` → `url` empty. But `pending_update_count: 17` — Atlas's messages ARE queued at Telegram, just never consumed by getUpdates.
- **Not rate limit:** Atlas stdout filtered for limit/429/paused/overloaded → blank.
- **Not the laptop:** no laptop process holds a Telegram connection (checked `Get-NetTCPConnection` to 149.154.* / 91.108.*).
- **Daemon healthy:** online, 0 restarts on 32 GB, injecting to agents (`[atlas] Injected` seen), crons firing.
- **Telegram reachable from VM:** getWebhookInfo returned instantly; outbound sendMessage works (boot messages arrive).

## Fixes ATTEMPTED that did NOT resolve it
1. `pm2 restart cortextos-daemon` (multiple times)
2. `cortextos restart atlas` / `start atlas` → hit persistent "deduped — already in registry" race
3. Full fleet reset: `pm2 stop` + `Get-Process claude | Stop-Process -Force` + `pm2 start`
4. Deleted Atlas's `.telegram-offset` (`state\atlas\.telegram-offset`) then respawned → still stuck
5. (In progress) bus route test: `cortextos bus send-message atlas ...` — result not yet confirmed

## Leading hypothesis
Atlas-specific stuck **getUpdates** — likely a 409/poller-lock conflict on Atlas's bot that isn't resolving,
OR Atlas's Claude session boots but doesn't process injected input (wedged session). Note Atlas is the
**orchestrator** and runs **Opus** (others Sonnet) — only real config difference. Worth checking whether the
daemon's PRIMARY poller and Atlas's per-agent poller are both polling Atlas's bot (self-conflict; logs earlier
showed "Telegram poller for <agent> exited (conflict-self-die)").

## Recommended next steps (fresh session)
1. Confirm the bus-route test: does Atlas reply to `cortextos bus send-message atlas high "..."`?
   - If YES → inbound-poll only; use dashboard Comms as the channel; fix poller separately.
   - If NO → Atlas session itself is wedged → force a fully fresh session (not --continue) / rebuild Atlas
     from the laptop's known-good copy of `orgs/atlasos/agents/atlas/`.
2. With daemon STOPPED, manually `getUpdates` on Atlas's bot token — a 409 there = external conflict to hunt;
   messages returned = daemon poller/offset bug.
3. If unresolved, escalate to CortextOS devs (grandamenium) with this doc — looks framework-level.

## Everything else is GOOD
Migration succeeded, 13/14 agents working, dashboard serving (HTTP 200). Open follow-ups also pending:
backup bucket (GCS create perms), ngrok tunnel SSL, static IP, laptop zombie cleanup (reboot laptop).
