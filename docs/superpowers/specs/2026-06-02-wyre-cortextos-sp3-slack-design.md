# WYRE cortextOS — SP3: Slack adapter (replaces Telegram for team)

- **Status:** Draft for review
- **Date:** 2026-06-02
- **Author:** Aaron Sachs (with Claude)
- **Initiative:** Team-wide WYRE cortextOS — third sub-project

## Context

SP1 (namespaces) and SP2 (central host, tunnel, Entra Access, dashboard) are
shipped and live at `https://wyre-agents.wyre.ai`. The agents themselves
currently talk to the world via **Telegram** — `src/telegram/` (~1,400 lines
across `api.ts`, `media.ts`, `transcribe.ts`, `poller.ts`, `logging.ts`,
`index.ts`) plus 5 bash scripts in `bus/` and 4 Claude-interactive hooks in
`src/hooks/`. Each agent owns a Telegram bot (`BOT_TOKEN` + `CHAT_ID` +
`ALLOWED_USER` in its `.env`).

That model is great for a single operator on a phone — and it stays in place
for personal/mobile use. But for **team-facing comms** the team isn't going to
live in Telegram. SP3 builds a parallel Slack adapter so team-visible flows
(recaps, approvals, crash alerts, experiments) land in the WYRE Slack
workspace where the team already works.

Decisions locked during brainstorming:

- **Identity:** one WYRE Slack app, **Socket Mode** inbound (outbound WS from
  the VM — preserves the SP2c-2 zero-public-ingress posture), per-agent
  outbound identity via `chat.postMessage` with `username`/`icon_url` overrides
  (`chat:write.customize` scope).
- **Routing:** channel-first — topical `#agents-*` channels (recap, ops,
  approvals, experiments). Threads for back-and-forth.
- **Authorization:** Slack channel ACL. Bot listens to channels it's invited
  to; each agent has an allowlist of channels in its config; messages from
  non-allowlisted channels are dropped silently.
- **Coexistence with Telegram:** Slack is **parallel**, not a replacement
  refactor. `src/telegram/` is untouched. Agents can be wired to one or both
  channels independently.
- **Workspace:** WYRE Tech already has a Slack workspace; Aaron is admin (or
  can authorize the install).

## Goal

After SP3, **the team uses Slack as the primary control plane for shared
agents.** A morning recap from `boss` lands in `#agents-recap`, a crash alert
hits `#agents-ops`, an approval request appears in `#agents-approvals` with
Block Kit Approve/Deny buttons, and any team member can reply in a thread or
@-mention the agent in those channels. Personal-namespace agents
(`engineers/<name>/agents/*`) stay Telegram-routed.

## Decisions this spec makes (locked)

1. **One Slack app for the whole installation.** Registered manually in
   Slack's developer console once; bot token and app-level Socket Mode token
   stored in Key Vault (`slack-bot-token`, `slack-app-token`). The cortextOS
   daemon fetches both at startup via the VM's managed identity.

2. **Socket Mode for inbound.** `src/slack/socket-mode.ts` opens a websocket
   to Slack's `apps.connections.open` endpoint and dispatches `event_callback`
   payloads to the bus. Reconnect/backoff strategy mirrors `src/telegram/
   poller.ts` (exponential up to 5 min). No public HTTP endpoint required.

3. **Per-agent visual identity via `chat:write.customize`.** Each
   `chat.postMessage` sets `username` and `icon_emoji` (or `icon_url`) so
   messages appear as `boss`, `analyst`, etc., even though one bot identity
   sends them. If Slack ever removes this override, the graceful fallback is
   prefixing messages with `*[agent]*` — implemented as a config flag from
   day one so the migration is a single config change.

4. **Channel ACL per agent.** `agents/<name>/slack.json`:

   ```json
   {
     "display_name": "boss",
     "icon_emoji": ":robot_face:",
     "channels": {
       "recap":      "C01XXXX01",
       "ops":        "C01XXXX02",
       "approvals":  "C01XXXX03"
     },
     "allowed_channels": ["C01XXXX01","C01XXXX02","C01XXXX03"]
   }
   ```

   - `channels.<purpose>` maps event types to channel IDs (where the agent
     posts).
   - `allowed_channels` is what the agent reads from (incoming messages from
     channels not in this list are dropped). Personal agents would have a DM
     channel ID here; shared agents have public/private channel IDs.

5. **Parallel — not a refactor.** `src/slack/` is created from scratch
   mirroring `src/telegram/`. The shared abstraction layer is "the bus" — both
   adapters push events to and read commands from the same `bus/*.sh` /
   `src/bus/*.ts` surface. Agents opt in to either or both channels via
   presence of a `.env` BOT_TOKEN (Telegram) and `slack.json` (Slack).

6. **Hook UX:**
   - `hook-ask-slack`: post a question to the agent's primary channel; agent
     waits for a threaded reply.
   - `hook-permission-slack`: Block Kit message with two buttons (Approve /
     Deny) in `#agents-approvals` (or the agent's approvals channel). Button
     click → Socket Mode event → bus → agent continues.
   - `hook-planmode-slack`: similar to permission but with collapsible plan
     content.
   - `hook-crash-alert-slack`: terse post to `#agents-ops` with `@here`
     mention.
   - `hook-compact-slack`: silent (no Slack notification); just log. The
     Telegram equivalent is also silent.

7. **Code organization:** parallel `src/slack/` directory. Bus and hook
   scripts follow the same `*-telegram.sh` → `*-slack.sh` naming. Per-agent
   `slack.json` lives alongside the existing `.env`.

## Architecture

```
                          WYRE Slack workspace
                                    │
                                    │  Socket Mode WS (outbound from VM)
                                    ▼  zero public ingress
┌── Azure VM (NSG deny-all-in unchanged) ─────────────────────────────┐
│  cortextos daemon                                                   │
│    ├─ src/slack/socket-mode.ts     persistent WS + reconnect        │
│    ├─ src/slack/api.ts             chat.postMessage, files.upload   │
│    ├─ src/slack/identity.ts        username/icon per agent          │
│    ├─ src/slack/acl.ts             channel allowlist enforcement    │
│    ├─ src/slack/media.ts           uploads/downloads                │
│    ├─ src/slack/logging.ts         retry + structured logs          │
│    └─ src/slack/index.ts                                            │
│                                                                     │
│  bus/                                                               │
│    ├─ _slack-curl.sh               web API helper (token redact)    │
│    ├─ send-slack.sh                                                 │
│    ├─ hook-ask-slack.sh                                             │
│    ├─ hook-permission-slack.sh                                      │
│    ├─ hook-planmode-slack.sh                                        │
│    └─ hook-crash-alert-slack.sh                                     │
│                                                                     │
│  src/hooks/hook-*-slack.ts         TypeScript bindings              │
│                                                                     │
│  /etc/cortextos.env (or KV pulled at boot):                         │
│    SLACK_BOT_TOKEN, SLACK_APP_TOKEN                                 │
└─────────────────────────────────────────────────────────────────────┘
                                    │ outbound
                                    ▼
                  Slack web API (chat.postMessage, files.upload, …)
```

## What ships across the SP3 series

| | Sub-project | Ships | Plan-able as |
|---|---|---|---|
| **SP3a** | **App registration + outbound send.** Slack app created in dashboard (manual one-time); bot token + app token written to Key Vault; `src/slack/api.ts` + `identity.ts`; `bus/_slack-curl.sh` + `bus/send-slack.sh`; per-agent `slack.json` schema + `add-agent` template extension; runbook section. **At end of SP3a: agents can post to channels with per-agent identity.** | Own spec → plan → 5–6 tasks |
| **SP3b** | **Socket Mode inbound + ACL + routing.** `src/slack/socket-mode.ts` + `acl.ts`; daemon wires the WS connection at startup; bus dispatcher routes incoming messages to the right agent; channel ACL enforcement. **At end of SP3b: agents can be talked to in channels they're invited to.** | Own spec → plan → 6–8 tasks |
| **SP3c** | **Interactive Claude hooks.** `src/hooks/hook-*-slack.ts` and `bus/hook-*-slack.sh`; Block Kit Approve/Deny in `#agents-approvals`; thread-reply for ask; channel-routed crash alerts. **At end of SP3c: the full Telegram-hook UX is mirrored on Slack.** | Own spec → plan → 5–7 tasks |

After SP3c, the team-facing flow is fully Slack-native. SP4 (team
onboarding & docs) wraps the initiative.

## Definition of done — SP3 as a whole

- A shared agent (`boss`) is configured for both Telegram (existing) and
  Slack (new), and both work simultaneously:
  - `boss` posts the morning recap to `#agents-recap` AND its existing
    Telegram chat. (Optional: per-event-type routing config to send each
    event to only one channel.)
  - A team member @-mentions `boss` in `#agents-recap`; the agent receives,
    processes, and replies in-thread.
  - An approval request from `dev` posts to `#agents-approvals` with two
    buttons; clicking Approve continues the workflow, Deny stops it.
  - A simulated agent crash hits `#agents-ops` with `@here`.
- A non-allowlisted user posting in a non-allowlisted channel produces no
  side effects (bot silently ignores).
- Per-agent identity overrides render correctly (messages appear under
  `boss` / `analyst` / etc.).
- Socket Mode reconnects after a forced disconnect (e.g. `cloudflared`
  restart on the VM).
- Personal-namespace agents continue working on Telegram unaffected.
- CHANGELOG updated; tag cut (`v0.5.0` if convention holds).

## Risks & open questions

- **Socket Mode reliability.** Slack's Socket Mode has historically been less
  reliable than HTTP webhook events. Mitigation: aggressive reconnect with
  exponential backoff (mirror `src/telegram/poller.ts`), and surface
  `socket_disconnected` events to a health metric.
- **`chat:write.customize` future.** Slack may eventually remove the
  username/icon override (they've been hinting at deprecation). Mitigation:
  graceful fallback to prefixed messages (`*[boss]* ...`) via a config flag.
- **Channel ID discovery.** The team has to assemble the `channels.<purpose>`
  map for each agent. Runbook documents a helper script:
  `cortextos slack discover-channels` (writes to stdout) that lists every
  channel the bot is in plus its ID.
- **DMs vs channels for personal-namespace agents.** Personal agents
  (`engineers/aaron/agents/dev`) probably still want a DM with their owning
  engineer for private back-and-forth, even though their primary channel may
  be public. Spec'd above as just another channel ID in `allowed_channels`
  (Slack DM channel IDs start with `D...`).
- **Rate limits.** Slack's web API rate limits are friendlier than Telegram's
  but still real (Tier 2/3/4). `src/slack/logging.ts` handles 429s with
  Retry-After honoring.
- **Token rotation.** Bot token + app-level token both rotate via Slack
  dashboard. Runbook documents: update KV → restart daemon. No code changes.

## Non-goals (deferred)

- **Replacing Telegram entirely.** Stays as the personal/mobile path.
- **Slack Workflow Builder / slash commands.** SP3 is purely conversational
  + Block Kit interactive messages.
- **External-user DMs.** Bot only converses with WYRE workspace members.
- **Voice / Slack Huddles integration.**
- **Slack-app admin automation.** Install is one-time manual; rotation is
  runbook-driven.
- **Shared abstraction layer over Telegram+Slack.** A future project might
  refactor both into a `Channel` interface, but SP3 explicitly does **not**
  refactor `src/telegram/`.

## Spec self-review

- Placeholder scan: none — every section has concrete content. The
  `channels.<purpose>` map's specific channel IDs (`C01XXXX01` etc.) are
  intentional placeholders representing real Slack channel IDs the operator
  fills in during SP3a's runbook section.
- Internal consistency: identity model (one app, per-agent username override),
  routing (channel-first), and ACL (allowlist in agent config) cohere across
  Architecture, Decisions, DoD, and Decomposition.
- Scope: SP3 is decomposed into three sub-projects each of which produces
  working software on its own. Each sub-project gets its own spec → plan →
  implementation cycle.
- Type/name consistency: `slack.json` schema, `src/slack/*` filenames, and
  `bus/*-slack.sh` naming are used consistently across sections.
