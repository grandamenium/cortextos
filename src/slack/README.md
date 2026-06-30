# Slack Multi-Agent Inbound

Connect a cortextOS agent to Slack so trusted humans can drive it from a channel,
the same way Telegram already works. Inbound Slack messages are gated by an
identity + trust layer and written to the agent's bus inbox; the agent replies
with `cortextos bus send-slack`.

## Modules

| File | Responsibility |
|------|----------------|
| `api.ts` | Slack Web API client (`conversations.history`, `users.info`, `chat.postMessage`). |
| `slack-identity.ts` | Resolve a user ID → handle/display name (cached), evaluate trust, format the originator string. |
| `slack-redact.ts` | Redact `xoxb-`/`xapp-` tokens from log lines. |
| `slack-socket.ts` | Socket Mode WSS client + event parsing. |
| `../daemon/slack-socket-listener.ts` | Adapts the socket client onto the bus inbox sink. |
| `../daemon/slack-inbound-mode.ts` | Decides Socket Mode vs polling fallback. |

The polling fallback lives in `FastChecker.checkSlackWatch()`; Socket Mode runs
via the listener wired in `AgentManager`.

## How it works

- **Two inbound transports, auto-selected.** When an app-level token (`xapp-…`)
  is present and the Node runtime supports native WebSockets (Node 22+), the
  daemon uses **Socket Mode** for real-time inbound. Otherwise it falls back to a
  **60s polling** path. There is never a silent no-inbound gap — if Socket Mode
  can't run, the poll stays live.
- **Self-echo guard.** Messages the agent posts via its own bot token (which
  arrive carrying `bot_id`) are filtered out so the agent never wakes itself in a
  loop. The read cursor advances past filtered messages so they are not re-fetched
  every poll.
- **Identity + trust gate.** Each inbound message's Slack user is resolved to a
  handle (cached) and checked against `trusted_slack_users`. When an allowlist is
  configured, untrusted and unidentifiable (userless) messages are dropped
  fail-closed. When no allowlist is set, the agent runs "loudly open" and logs a
  one-time warning.

## Secrets (.env)

Slack tokens are secrets and live in the agent's `.env`, never in `config.json`:

```
SLACK_BOT_TOKEN=xoxb-...   # required — inbound reads and outbound sends
SLACK_APP_TOKEN=xapp-...   # optional — enables real-time Socket Mode
```

## Config schema (config.json)

```json
{
  "slack_watch": {
    "channel": "C0123456789",
    "interval_ms": 60000
  },
  "trusted_slack_users": ["jordan.lee", "alex.rivera"],
  "slack_channels": {
    "ops": "C0123456789",
    "alerts": "C0987654321"
  },
  "team_members": [
    {
      "name": "Jordan Lee",
      "role": "Operations Manager",
      "slack_handle": "jordan.lee",
      "trust_level": "owner"
    },
    {
      "name": "Alex Rivera",
      "role": "Support Lead",
      "slack_handle": "alex.rivera",
      "trust_level": "member"
    }
  ]
}
```

| Field | Type | Notes |
|-------|------|-------|
| `slack_watch.channel` | string | Slack channel ID (e.g. `C0123456789`). Setting this wires the listener. |
| `slack_watch.interval_ms` | number | Poll interval for the fallback path. Default `60000`. |
| `trusted_slack_users` | string[] | Slack handles (without `@`) allowed to drive the agent. Omit/empty = loudly open. |
| `slack_channels` | object | Optional friendly-name → channel-ID map. |
| `team_members` | `TeamMember[]` | Roster used to resolve handles → display name + trust level. May also live on `OrgContext.team_members`. |

`TeamMember.trust_level` is one of `owner`, `manager`, `member`.

## Replying

The inbound message injected into the agent includes a ready-to-use reply hint:

```
=== SLACK from Jordan Lee (@jordan.lee) (channel:C0123456789 ts:1700000000.0001) ===
<message text>
Reply using: cortextos bus send-slack C0123456789 "<reply>"
```
