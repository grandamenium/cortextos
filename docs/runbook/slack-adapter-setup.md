# Slack Adapter Setup

cortextOS agents can send and receive messages over Slack, in addition to
Telegram. Outbound (`chat.postMessage`) and inbound (Socket Mode) are both
supported. This guide covers creating the Slack app, configuring an agent,
and verifying the setup.

## 1. Create a Slack app

1. Go to <https://api.slack.com/apps> and click **Create New App** → **From
   scratch**.
2. Name the app and pick the workspace it should install to.
3. Under **Socket Mode**, enable Socket Mode. This generates an app-level
   token (`xapp-...`) — save it, you'll need it as `SLACK_APP_TOKEN`.
4. Under **OAuth & Permissions** → **Scopes** → **Bot Token Scopes**, add:
   - `chat:write` — post messages (`chat.postMessage`, used by `slack send`
     / `slack test-send`)
   - `chat:write.customize` — post under a per-agent display name/icon
     (`username`/`icon_emoji`/`icon_url` overrides in `slack.json`)
   - `channels:history` — receive `message`/`app_mention` events from
     public channels the bot is in (Socket Mode inbound)
   - `channels:read` — list channels (`conversations.list`, used by
     `slack discover-channels`)
   - `users:read` — resolve a Slack user id to a display name for the
     injected message header (`users.info`)
   - If the agent needs to read/post in private channels, also add
     `groups:history` and `groups:read`.
5. Under **Event Subscriptions**, enable events and subscribe to bot events:
   `message.channels` (and `message.groups` if using private channels),
   `app_mention`.
6. Install the app to the workspace. This generates a bot token
   (`xoxb-...`) — save it as `SLACK_BOT_TOKEN`.
7. Invite the bot to each channel it needs to read from or post to
   (`/invite @your-bot-name` in Slack).

## 2. Configure environment variables

The daemon process needs both tokens in its environment:

```bash
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
```

`SLACK_BOT_TOKEN` is required for any outbound send (`slack send`,
`slack test-send`, `slack discover-channels`). Both `SLACK_BOT_TOKEN` and
`SLACK_APP_TOKEN` are required for inbound Socket Mode — the daemon's
orchestrator agent starts one shared Socket Mode connection per org at
startup only when both are present; if either is missing, Slack inbound is
simply inactive and nothing else is affected (agent startup, Telegram, etc.
all continue normally).

Socket Mode requires Node's native `WebSocket` global, which is stable
starting in Node 22 — make sure the daemon runs on Node >=22.

## 3. Configure an agent for Slack (`slack.json`)

Per-agent Slack config lives at `agents/<name>/slack.json` (or the
namespaced equivalent for `<org>/<agent>` layouts). Schema
(`SlackConfig`, see `src/slack/identity.ts`):

```json
{
  "display_name": "My Agent",
  "icon_emoji": ":robot_face:",
  "channels": {
    "recap": "C0123456789",
    "ops": "C0987654321"
  },
  "allowed_channels": ["C0123456789", "C0987654321"],
  "allowed_users": ["T01234567:U01234567"]
}
```

- `display_name` — the `username` used when posting (requires
  `chat:write.customize`).
- `icon_emoji` **or** `icon_url` — optional visual identity override; if
  both are set, `icon_emoji` wins.
- `channels` — a purpose → channel-id map for the agent's own reference
  (e.g. which channel to post recaps to). Not enforced by the adapter
  itself.
- `allowed_channels` — channel ids (`Cxxx`) this agent will accept inbound
  messages from. Required for inbound delivery — a channel not in this
  list is never routed to the agent.
- `allowed_users` — **required, fail-closed** allowlist of Slack identities
  permitted to message this agent, as `"<team_id>:<user_id>"` composite
  keys (not just `user_id` — Slack user ids are workspace-scoped, not
  globally unique). An empty or missing list means the agent accepts
  messages from **no one**, mirroring Telegram's `ALLOWED_USER` behavior
  when unset. Find `team_id` and `user_id` from a message inspected via the
  Slack API, or from `discover-channels` output plus Slack's own admin UI.

A missing `slack.json` means the agent is Slack-disabled — this is a
normal, supported state, not an error.

## 4. Verify

With `SLACK_BOT_TOKEN` set in your shell:

```bash
# List channels the bot is a member of, with ids
cortextos slack discover-channels

# Post a test message
cortextos slack test-send C0123456789 "hello from cortextos" --org myorg

# Post under a specific agent's identity (reads that agent's slack.json)
cortextos slack test-send C0123456789 "hello" --as my-agent --org myorg
```

`cortextos slack send` is the same command shape as `test-send` — it's the
stable command name used internally for replies (the "Reply using: ..."
line injected into an agent's session when a Slack message arrives).

To verify inbound delivery end-to-end: start the daemon with
`SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` set, confirm the orchestrator log
shows `Slack Socket Mode connected`, then post a message in a channel
listed in an agent's `allowed_channels` from a user listed in that agent's
`allowed_users`. The message should appear in the agent's session as:

```
=== SLACK from [USER: <name>] (channel:<id>) ===
<text>
Reply using: cortextos slack send <channel> '<your reply>' --as <agent>
```
