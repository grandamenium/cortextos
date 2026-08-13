# Buzz (Nostr/NIP-29) Adapter — Setup

This guide covers standing up an agent that can be messaged over a Buzz relay
(NIP-29 group chat over Nostr), alongside its existing Telegram connection.

## 1. Prerequisites

- A running Buzz relay you control or have admin access to (see the relay's
  own docs for standing one up — this guide assumes one already exists at
  some `wss://relay.example.com`).
- `buzz-admin`, the relay's operator CLI, available to whoever is
  provisioning agent identities and channel membership.

## 2. Mint the agent's Nostr identity

Buzz identity minting is a deliberate, out-of-band operator step — `cortextos
add-agent --buzz-channel` never auto-generates or prints a private key for
you. Generate one yourself:

```bash
buzz-admin generate-key
# prints a hex secret key + the corresponding hex pubkey
```

Keep the secret key somewhere safe; you'll put it in the agent's `.env` in
step 4, never in `buzz.json`.

## 3. Register the agent as a relay member

The relay only accepts events from pubkeys it knows about (if
`BUZZ_REQUIRE_RELAY_MEMBERSHIP` is enabled on the relay) or from pubkeys
listed on the `pubkey_allowlist` (if `BUZZ_PUBKEY_ALLOWLIST` is enabled).
Ask whoever administers the relay to add the agent's pubkey:

```bash
buzz-admin add-member <agent-hex-pubkey>
# or, for an allowlist-only relay:
# INSERT INTO pubkey_allowlist (pubkey) VALUES (decode('<agent-hex-pubkey>', 'hex'));
```

You'll also need the channel UUID(s) the agent should listen on — ask the
channel owner, or use `cortextos buzz discover-channels` (step 6) once
credentials are in place.

## 4. Scaffold the agent

```bash
cortextos add-agent <name> --org <org> --buzz-channel <channel-uuid>
```

This writes `orgs/<org>/agents/<name>/buzz.json` with the channel
pre-filled and `pubkey` / `allowed_pubkeys` left blank/empty
(fail-closed — an agent with an empty `allowed_pubkeys` accepts messages
from **no one** until you explicitly grant access).

Fill in `buzz.json`:

```json
{
  "pubkey": "<agent-hex-pubkey-from-step-2>",
  "display_name": "My Agent",
  "channels": ["<channel-uuid>"],
  "allowed_pubkeys": ["<trusted-sender-hex-pubkey>", "..."],
  "relay_url": "wss://relay.example.com"
}
```

`relay_url` is optional per-agent — if every agent in an org uses the same
relay, set `BUZZ_RELAY_URL` once in the daemon's environment instead and
omit it here.

Then add the secret key to the agent's `.env` (never committed to
`buzz.json`):

```bash
echo 'BUZZ_PRIVATE_KEY=<hex-secret-key-from-step-2>' >> orgs/<org>/agents/<name>/.env
```

## 5. Understand the connection model

Buzz relays are workspace-scoped like Slack, not per-agent like Telegram: one
WebSocket connection is shared per org, opened by the org's orchestrator
agent at boot. Every other agent in the org still needs its own `buzz.json`
(with its own `allowed_pubkeys`), but does not open a second connection —
messages route through the shared connection based on channel + pubkey
matching.

A missing or misconfigured Buzz setup never blocks agent or orchestrator
startup — connection failures are logged and retried with backoff, not
fatal.

## 6. Verify

Before starting the agent, confirm credentials and connectivity:

```bash
cortextos buzz test-send --channel <channel-uuid> --text "hello from cortextOS"
```

This connects, completes the NIP-42 AUTH handshake, publishes a test event,
and waits for the relay's OK — confirming both the private key and relay
reachability are correct before the daemon ever starts.

```bash
cortextos buzz discover-channels --agent <name>
```

Lists the pubkey and channel UUIDs configured in that agent's `buzz.json`.

Then start the agent normally:

```bash
cortextos start <name>
```

## 7. Sending and receiving

Once running, channel messages the agent is subscribed to and the sender is
allowlisted for arrive automatically via the daemon (same delivery path as
Telegram — see the agent's `CLAUDE.md` for the exact injected format). To
send a message manually or from a script:

```bash
cortextos buzz send --channel <channel-uuid> --text "message text" [--reply-to <event-id>]
# or, from the bus shell scripts:
bus/send-buzz.sh <channel-uuid> "message text"
```

## Scope of this adapter

Text messages in, text messages out — mirrors the initial Telegram/Slack
MVP scope. Not yet implemented: reactions, deletions, threading beyond a
single reply-to tag, presence/typing indicators, media uploads, or dynamic
channel discovery via relay-signed group-state events (channels are
statically configured in `buzz.json` today).
