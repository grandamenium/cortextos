# Communications Connectors — Architecture & Implementer's Guide

**Status:** Implemented (Telegram + Null). Multi-connector extensions (Discord, Mattermost, RocketChat) covered in §12.
**Last updated:** 2026-05-14

---

## 1. What this is

The `MessageConnector` interface is the abstraction between a cortextOS
agent's daemon-side machinery (the FastChecker, the AgentProcess, the
bus's approval poster, the CLI `bus send` command) and any user-facing
messaging transport (Telegram today; Discord, Mattermost, RocketChat,
Slack, Matrix in follow-up PRs).

Before this layer the daemon talked to `TelegramAPI` and `TelegramPoller`
directly. That worked when Telegram was the only transport, but every
new transport would have meant another conditional branch at every call
site — sending, receiving, validating credentials, registering slash
commands, acknowledging button clicks, editing messages, downloading
media. The connector layer collapses all of that into one interface
with a runtime allowlist, a per-kind factory, and a typed normalization
shape.

The design mirrors the existing **PTY-adapter** idiom at
`src/daemon/agent-process.ts` (interface + dispatch-allowlist + ternary
dispatch on a config field) — same shape, but for user-facing
messaging transports instead of agent runtimes.

```
   ┌──────────────────────┐
   │ Provider transport    │  Telegram bot API, Discord gateway,
   │ (REST/WS/long-poll)   │  Mattermost REST, RocketChat REST/WS, …
   └──────────┬───────────┘
              │
              ▼
   ┌──────────────────────┐
   │ Connector            │  src/connectors/<kind>/
   │ (provider-specific)  │  implements MessageConnector
   └──────────┬───────────┘  emits NormalizedMessage / NormalizedReaction
              │              consumes SendOptions / sendMedia / editMessage
              │              capabilities flags advertise what works
              ▼
   ┌──────────────────────┐
   │ Daemon + Bus + CLI    │  src/daemon/agent-manager.ts wires it
   │ (provider-agnostic)   │  src/daemon/fast-checker.ts uses it
   └──────────────────────┘  src/bus/approval.ts uses it
                             src/cli/bus.ts uses it
```

Everything north of the interface is generic: agents, FastChecker, the
bus, the CLI, the hooks. Everything south of the interface is the
provider-specific code that translates that provider's wire format into
`NormalizedMessage`. Adding a new transport is purely a south-of-line
exercise.

---

## 2. The interface contract

Defined in `src/connectors/connector.ts`. Three required methods + one
required pair (start/stop polling) + four optional methods that are
gated by capability flags.

```ts
interface MessageConnector {
  readonly kind: ConnectorKind;             // 'telegram' | 'none' | …
  readonly capabilities: ConnectorCapabilities;

  // Always required
  validateCredentials(): Promise<ValidateResult>;
  sendMessage(text: string, opts?: SendOptions): Promise<SendResult>;
  sendMedia(media: MediaPayload): Promise<SendResult>;
  startInbound(handlers: PollingHandlers, opts?: { stateDir?: string }): Promise<void>;
  stopInbound(): Promise<void>;

  // Optional surfaces — gated by capabilities
  setTypingIndicator?(on: boolean): Promise<void>;
  registerCommands?(commands: Array<{ name; description }>): Promise<void>;
  acknowledgeCallback?(callbackId: string, text?: string): Promise<void>;
  editMessage?(messageId, text, opts?): Promise<void>;
  sendReaction?(messageId, emoji, opts?): Promise<void>;
}
```

**Rule of thumb for optional methods:** callers MUST gate the call
through `capabilities.<flag>`. The connector's contract for absent
methods is "method is omitted *and* its capability flag is `false`".
Callers must never feature-detect by `typeof connector.foo === 'function'`
— always read the flag.

### Required-method semantics

| Method | Throws? | Notes |
|---|---|---|
| `validateCredentials()` | NO. Must catch all errors and return a `ValidateResult`. | Used during enable + cold start. Must not page on transient network errors. |
| `sendMessage(text, opts)` | YES, on network failure. Caller is responsible for try/catch. | Returns `{ id, ts }` so callers can pin a message id for follow-up edits. |
| `sendMedia({ localPath, caption?, kind })` | YES, on network failure. | Caller supplies an absolute local path. Connector reads the file. |
| `startPolling(handlers, opts?)` | NO under normal error. Resolves AFTER the loop is **scheduled** (not after it completes). | Loop's own errors are reported via the connector's stderr, never thrown out of `startPolling`. See §6. |
| `stopPolling()` | NO. Must always succeed or no-op. | Called from daemon shutdown + restart paths. |

### Capability-gated method semantics

| Method | Capability flag | Failure behavior |
|---|---|---|
| `setTypingIndicator(on)` | `typingIndicator` | Non-fatal. Caller does NOT wrap in try/catch — the connector is expected to swallow errors internally if any. |
| `registerCommands(cmds)` | (none — implicit on all connectors that support slash commands) | Non-fatal. Used at startup. |
| `acknowledgeCallback(id, text?)` | `interactiveCallbacks` | **Non-fatal.** Callers WRAP in try/catch — failures here must not abort the interactive flow (the user already clicked the button; missing the ack only loses the toast). |
| `editMessage(id, text, opts?)` | `messageEdits` | **Non-fatal.** Callers WRAP in try/catch — same reason. |

---

## 3. Capability flags

Today's set, defined in `src/connectors/types.ts`:

| Flag | Meaning |
|---|---|
| `inlineButtons` | Provider supports inline-keyboard buttons (Telegram `inline_keyboard`, Slack blocks, Discord components, RocketChat attachment actions). When `true`, `SendOptions.buttons` is honored. |
| `media` | Provider supports media upload (photo / document). When `true`, `sendMedia()` works. |
| `voiceTranscription` | Connector's inbound pipeline transcribes voice/audio to text. Determines whether `NormalizedMedia.transcription` is populated. |
| `formattedText` | Provider supports formatted text (HTML / Markdown / blocks). Callers may pass `SendOptions.parseMode`. |
| `inbound` | Tri-state: `'poll'` / `'push'` / `'none'`. `'poll'` runs an internal long-poll loop (Telegram getUpdates). `'push'` subscribes to a provider push channel (Discord gateway WS, Mattermost webhook, RocketChat DDP). `'none'` is the explicit opt-out; daemon skips `startInbound`. The daemon treats `'poll'` and `'push'` identically at the wiring site — both go through `startInbound(handlers, opts)`. PR4 c11 replaced the previous `longPolling: boolean` flag. |
| `typingIndicator` | Connector supports a "typing…" hint before replies. |
| `reactions` | Connector emits reaction-add / change / remove updates via `PollingHandlers.onReaction`. **Inbound only.** Outbound reactions (agent reacts to a message) are tracked under `outboundReactions` — see §12. |
| `interactiveCallbacks` | Connector can acknowledge an inline-button callback. When `true`, `acknowledgeCallback()` is present. |
| `messageEdits` | Connector can edit a previously-sent message. When `true`, `editMessage()` is present. |

### Future flags (proposed; see §12 for which providers force which)

| Flag | Purpose | Forced by |
|---|---|---|
| `outboundReactions` | Agent can send a reaction emoji ON a user message. Enables emoji-ack UX (§11). | All four — Telegram (Bot API 7+), Discord, Mattermost, RocketChat |
| `threads` | Provider has first-class threads (parent message + child replies in a thread tree, distinct from inline reply_to). | Discord, Mattermost, RocketChat, Slack |
| `richBlocks` | Provider supports structured rich content (embeds, cards, blocks) beyond inline-keyboard buttons. | Discord embeds, Slack blocks, Mattermost attachments |
| `webhookInbound` | Provider prefers webhook delivery to long-polling. Mutually compatible with `longPolling`; agents may run either or both per provider conventions. | Discord (gateway/webhook), Mattermost (outgoing webhook), RocketChat (outgoing webhook) |
| `presence` | Provider exposes online/offline/typing presence updates beyond the message stream. | Discord, Matrix |
| `fileSizeLimitBytes` | Numeric (not boolean): max bytes for `sendMedia`. Callers can chunk or refuse. | All four — Telegram 50MB, Discord 25MB (Nitro 500MB), Mattermost configurable, RocketChat configurable |

These are NOT in `ConnectorCapabilities` today. The next PR (PR5 of the
pluggable-connectors stack) will land at least `outboundReactions` and
`threads` because the UX work in §11 needs the former and the Discord/
Mattermost/RocketChat work in §12 needs the latter.

---

## 4. Normalization rules

The connector's inbound pipeline converts the provider's wire shape
into the generic `NormalizedMessage` / `CallbackPayload` /
`NormalizedReactionPayload`. The rules below pin what every connector
implementation must do.

### `NormalizedMessage`

| Field | Required | Rule |
|---|---|---|
| `id` | yes | Connector-specific message id, **stringified** (Telegram numeric, Slack ts, RocketChat opaque). |
| `ts` | yes | Unix **milliseconds**. Telegram's `date` is seconds; multiply by 1000. |
| `from.id` | yes | Stringified provider user id. Empty string means "no sender info". |
| `from.username` | optional | Provider's @handle if available. |
| `from.name` | optional | Display name (first name on Telegram). |
| `text` | yes | Text body. For media, **carries the caption**. Empty string when neither text nor caption is present. |
| `chat_id` | optional | Inbound message's own chat id, stringified. Connectors MUST populate this when the provider supplies one — the daemon falls back to the agent's bound chatId when absent, matching the historical `msg.chat?.id ?? chatId ?? ''` resolution. |
| `media` | optional | `NormalizedMedia` shape (see below). Present iff the message carried media AND the connector was configured with a `downloadDir`. |
| `reply_to.id` | optional | Stringified id of the replied-to message. |
| `reply_to.text` | optional | Human-readable rendering of the replied-to message. Connector populates from the replied-to message's text/caption, or a label like `[photo]` / `[voice message]` / `[document: filename.pdf]` if the replied-to message was media. The daemon must not read provider-specific media flags off `raw` to render reply context — that work belongs in the connector. |
| `raw` | yes | Original provider payload. **Debug only.** MUST NEVER be serialized to the bus or to any other agent. |

### `NormalizedMedia`

| Field | Required | Rule |
|---|---|---|
| `kind` | yes | One of `photo \| voice \| document \| video \| audio \| video_note`. New providers map to the closest existing kind; do NOT extend the union in your connector — propose it in a separate PR if a genuinely new media class arrives. |
| `localPath` | yes | **Absolute path** on the connector's local disk. The daemon makes paths relative to the agent's launch cwd at the call site (BUG-046 + BUG-049). |
| `mime` | optional | MIME type when the provider exposed one. |
| `fileName` | optional | Original filename (documents + named uploads). |
| `duration` | optional | Seconds (voice / audio / video / video_note). |
| `transcription` | optional | Transcribed text from voice/audio, when the connector has a transcription pipeline and it produced a result. |

### `NormalizedReactionPayload`

| Field | Required | Rule |
|---|---|---|
| `id` | yes | Synthesized id when the provider has none. Telegram uses `${message_id}-${date}`. |
| `ts` | yes | Unix **milliseconds**. |
| `from.{id,username,name}` | as above | Same rules as `NormalizedMessage.from`. |
| `chat_id` | optional | Same rule as `NormalizedMessage.chat_id`. |
| `message_id` | yes | **Number, not stringified** — matches `FastChecker.formatTelegramReaction(messageId: number)`. Pragma carried over from Telegram; future connectors stringify by mapping their own id to a numeric or revisiting this field. |
| `old_reaction`, `new_reaction` | yes | `TelegramReactionType[]` arrays. Empty array means "no reaction"; the diff is `(new) \ (old)`. This carries a **Telegram-specific tagged union** today because `FastChecker.formatTelegramReaction` consumes that exact shape (and preserves custom-emoji info via the `{type:'custom_emoji',custom_emoji_id}` variant). A follow-up PR will generalize it to `ConnectorReaction`. Out of scope for the initial multi-connector landing. |
| `raw` | yes | Provider payload. Same constraints as `NormalizedMessage.raw`. |

### `CallbackPayload`

Generated when the user clicks an inline button. Today's shape:

```ts
{
  id: string;            // Connector-specific callback query id
  from: { id: string };
  data: string;          // The opaque callback_data the agent passed
  message_id: string;    // id of the message the button was on
  raw: unknown;          // @internal @deprecated — see §15
}
```

`raw` is documented as transitional. PR5 of the pluggable-connectors
stack designs the proper interactive-callback abstraction and drops
this field.

### Field-naming convention

* **snake_case** for fields that mirror a provider source shape:
  `message_id`, `chat_id`, `old_reaction`, `new_reaction`, `reply_to`.
* **camelCase** for connector-derived fields: `localPath`, `fileName`,
  `inlineButtons` (capability flag), `parseMode`.

Same rule the rest of the codebase uses for bus messages. New
connectors MUST follow this convention so payloads are visually
consistent across providers.

---

## 5. Wire-points: where the connector plugs in

Six call sites. A new connector kind is added by editing two files and
adding one implementation directory; nothing else changes.

### a. Type union (`src/types/index.ts:199`)

```ts
connector?: 'telegram' | 'none';
```

Add your kind to the union. This is the single place the daemon types
the field that agents declare in `config.json`.

### b. Runtime allowlist (`src/connectors/index.ts:16`)

```ts
export const CONNECTOR_ALLOWLIST: ConnectorKind[] = ['telegram', 'none'];
```

Add your kind here too. The two MUST agree — TypeScript would catch a
divergence at the `switch` in `getConnector`.

### c. Factory dispatch (`src/connectors/index.ts:36`)

```ts
switch (kind) {
  case 'telegram': /* construct TelegramConnector */
  case 'none':     /* construct NullConnector */
  // add your kind here
}
```

The factory unpacks the right env keys for your connector (Telegram
needs `BOT_TOKEN`/`CHAT_ID`/`ALLOWED_USER`; your connector defines its
own env shape via a `<Kind>ConnectorEnv` interface in `types.ts`).

### d. Operator-level connector (`src/connectors/index.ts:68`)

If your provider can also serve as the **daemon-level** notification
channel (crash alerts, ops messages), extend `getOperatorConnector()`
with the `CTX_OPERATOR_<KIND>_*` env translation. The operator
connector is **send-only** — it must never be passed to `startPolling()`.

### e. Implementation directory (`src/connectors/<kind>/`)

Mirror `src/connectors/telegram/` structure:

```
src/connectors/<kind>/
  api.ts              # provider HTTP / WS / gateway client
  <kind>-connector.ts # implements MessageConnector
  poller.ts           # inbound loop (if longPolling = true)
  media.ts            # media download + transcription (if media = true)
  logging.ts          # JSONL logger for inbound (if any provider-specific logging)
```

Re-export from `src/connectors/index.ts`:

```ts
export { DiscordConnector } from './discord/discord-connector.js';
```

### f. Conformance test (`tests/unit/connectors/conformance.test.ts`)

Add cases pinning your connector's `kind` literal and the boolean-ness
of every capability flag. Cheap and prevents silent regressions when
the interface grows.

---

## 6. Lifecycle

```
construct → validateCredentials → startPolling → … → stopPolling
```

### `validateCredentials()`

Called by the CLI `enable-agent` preflight and the daemon's cold-start
log line. Must be **cheap and idempotent**. Telegram's implementation
hits `getMe` + `getChat`; a Discord connector would hit the gateway
identify; a Mattermost connector would hit `GET /api/v4/users/me`.

Returns one of two shapes:

```ts
{ ok: true, identity: string }
// or
{ ok: false, reason: 'bad_credentials' | 'unreachable_recipient'
                   | 'network_error' | 'rate_limited' | 'config_error',
              detail: string }
```

The reasons are deliberately generic. Provider-specific causes
(Telegram's `bot_recipient`, Mattermost's `team_not_found`, etc.) are
mapped at the connector to one of these five buckets. The `detail`
string is free text for operator log lines.

### `startPolling(handlers, opts?)`

Resolves AFTER the loop is **scheduled**, not after it completes. The
loop's own errors are logged to stderr and recovered from inside the
connector — they do not propagate out of `startPolling`. This is
critical: the daemon's `startAgent` calls `startPolling().catch(…)` and
must not hang.

`opts.stateDir` is the directory where the connector persists its
inbound polling state (Telegram's `.telegram-offset` file; a Discord
gateway connector's last-sequence file; etc.). The daemon passes
`<ctxRoot>/state/<name>/` explicitly. Standalone tests can omit it; the
connector falls back to an implementation default.

`PollingHandlers` are **synchronous**:

```ts
onMessage:  (m: NormalizedMessage)         => void
onCallback: (c: CallbackPayload)           => void   // optional
onReaction: (r: NormalizedReactionPayload) => void   // optional
```

Sync semantics matter for offset/ACK advance: the connector advances
its inbound offset AFTER the handler returns (matches Telegram poller
behavior at `src/connectors/telegram/poller.ts`). A thrown handler
aborts the batch. Any async work the handler initiates (media download,
transcription, queueing a PTY injection) must be **fire-and-forget**
exactly as today.

### `stopPolling()`

Idempotent. May be called when no poll loop is running. Connectors
clear their poller reference inside the method.

---

## 7. State directory contract

Every connector that polls or persists inbound state writes to
`<stateDir>/<provider-namespace-prefix>.<state-kind>`:

| Connector | Path | Purpose |
|---|---|---|
| Telegram (primary) | `<stateDir>/.telegram-offset` | Last Telegram getUpdates offset |
| Telegram (activity-channel) | `<stateDir>/.telegram-offset-activity` | Same, for second TelegramConnector instance |
| (proposed) Discord | `<stateDir>/.discord-sequence` | Gateway resume sequence |
| (proposed) Mattermost | `<stateDir>/.mattermost-cursor` | Last polled message cursor |
| (proposed) RocketChat | `<stateDir>/.rocketchat-since` | Last polled `ts` |

The `pollerNamespace` constructor option on `TelegramConnector` lets
multiple instances share a stateDir without clobbering each other
(used for the orchestrator's activity-channel second-bot pattern). New
connectors with the same multi-instance pattern should accept a
similar option.

---

## 8. Multi-connector instances per agent

A single agent may construct multiple connector instances. Today's only
case: an org's orchestrator runs a **primary** connector (for user
chat) AND an **activity-channel** connector (for org-wide audit posts).
Both are TelegramConnector instances; they have separate
`BOT_TOKEN`/`CHAT_ID` pairs and share a stateDir via the
`pollerNamespace` option.

When you add a new connector kind, decide:

* Can it host multiple instances per agent? (Telegram yes, via separate
  bot tokens. A gateway-style provider like Discord may have different
  constraints.)
* If yes, does it need a namespace option to avoid stateDir
  collisions?
* Should its activity-channel sibling go through the same connector
  kind as the agent's primary, or can they mix (e.g. agent's primary
  is Discord, but the org's activity-channel is Telegram)? The design
  today allows mixing — `AgentManager.maybeStartActivityChannelPoller`
  constructs the activity connector independently of the agent's
  primary `config.connector`. Future PRs may add a per-org
  `activity_channel_connector` config field to make this explicit.

---

## 9. Operator-level connector

`getOperatorConnector()` (in `src/connectors/index.ts`) builds a
daemon-wide send-only connector from `CTX_OPERATOR_*` env vars. This is
the channel that fires:

* Crash-loop alerts when an agent exceeds the crash limit
* (Future) Daemon health / system messages

Rules:

* **Send-only.** Never pass it to `startPolling()`.
* Returns `null` when `CTX_OPERATOR_CONNECTOR === 'none'` OR when the
  operator's provider credentials are absent.
* The empty `agentDir` argument is safe under the send-only constraint
  — `TelegramConnector` reads `agentDir` only for the poller's
  stateDir; send/validate paths do not touch it.

---

## 10. Field naming, error semantics, and the security contract

### Allowed-user gate

The daemon enforces an allowed-user gate at the `onMessage` and
`onReaction` boundaries:

```ts
if (allowedUserId) {
  if (!m.from.id || m.from.id !== allowedUserId) {
    log('Ignoring message from unauthorized user (allowed_user gate)');
    return;
  }
}
```

This is **string-equality** on the stringified `from.id`. Connectors
must populate `from.id` as the provider's authoritative user id, never
a username (which is typically mutable).

When the agent's config requires an allowed user but the connector
provides no user id (`from.id === ''`), the gate denies. The connector
must NOT silently allow.

### Credential handling

Connectors receive credentials through the typed `<Kind>ConnectorEnv`
shape unpacked by the factory from `process.env`. Rules:

* **Never** log credentials. Telegram's daemon log emits
  `chat_id: ****1234` (last 4 chars) for the chat id and never the bot
  token.
* **Never** serialize credentials to the bus, JSONL logs, or
  cross-agent messages.
* `validateCredentials()` errors expose `detail` strings for operator
  log lines; those strings MUST NOT contain the token. The Telegram
  implementation strips tokens by virtue of `TelegramAPI`'s internal
  error handling — new connectors must do the same.

### Content sanitization

Inbound `text`, `from.name`, `from.username`, and `reply_to.text` are
passed through `stripControlChars` at the daemon boundary (not at the
connector). The connector's job is to faithfully normalize what the
provider sent; the daemon's job is to clean control characters and
zero-width spaces before injection into the PTY.

The connector MUST NOT trust `raw` for anything beyond debug
inspection. Two concerns:

1. **Provider drift** — a Telegram update field rename would silently
   change `raw` shape, and any consumer reading `raw` is unprotected by
   the normalization layer.
2. **Bus serialization** — `raw` carries the original payload, which
   on many providers includes session-like fields (Slack `team`,
   Discord `guild_id`) that may be sensitive. The interface forbids
   serializing `raw` to anywhere durable.

---

## 11. UX: emoji reactions as acknowledgement

**The asymmetry today.** The connector EMITS reaction updates inbound
(`PollingHandlers.onReaction`) so the agent can observe users
reacting to its messages — but the connector cannot SEND a reaction.
When an agent wants to acknowledge a user message ("seen", "done",
"working on it"), its only option is a text reply, which (a) is heavy
for a binary ack, (b) clutters the conversation, and (c) often pushes
older context off the user's screen.

**The proposal: outbound reactions as a first-class ack channel.**

### Capability flag

Add to `ConnectorCapabilities`:

```ts
outboundReactions: boolean;
```

When `true`, the connector implements:

```ts
sendReaction(messageId: string, emoji: string, opts?: { remove?: boolean }): Promise<void>
```

When `remove: true`, the connector removes the agent's reaction; when
`false` or absent, it adds it. Both should be **non-fatal** to the
caller — same rule as `acknowledgeCallback` and `editMessage`.

### Provider support

| Provider | Outbound reaction API | Multi-emoji limit | Custom emoji? |
|---|---|---|---|
| **Telegram** | `setMessageReaction` (Bot API 7.0+, Feb 2024) | 1 per bot per message in groups, up to chat-config limit in 1:1 | Premium-only `custom_emoji_id`; bots can use the standard set |
| **Discord** | `PUT /channels/{channel.id}/messages/{message.id}/reactions/{emoji}/@me` | Unlimited distinct emoji per message | Yes (custom emoji require permission in guild) |
| **Mattermost** | `POST /api/v4/reactions` | Unlimited | Yes (server-configured custom emoji) |
| **RocketChat** | `POST /api/v1/chat.react` | Unlimited | Yes |
| **Slack** (future) | `reactions.add` | Unlimited | Yes |

All four target providers support outbound reactions. Telegram has the
tightest constraints (1 reaction per bot in groups, restricted to the
standard emoji set unless Premium), so we design the interface against
Telegram's limits and let other providers be permissive.

### Agent UX: which messages get react-ack vs text-ack?

This is the new design surface. Three patterns to support, all of
them connector-agnostic — the choice lives in the agent prompt /
FastChecker policy, not in the connector:

**A. Skill-tool ack (the high-value case).**

Today: an agent invokes a tool (Read, Bash, ApprovalRequest, …), the
hook runs, the daemon's permission gate fires, the connector posts a
button-card to the user, the user clicks, the daemon edits the
button-card to "Approved" / "Denied". For tools that are *fast and
safe* but whose hook still prompts (read-only commands, low-risk
shell), the user often just wants to say "yes, continue" without
clicking a button.

With outbound reactions: the agent reacts 👀 ("I saw your message and
am working") immediately on receipt, then ✅ ("done") or ❌ ("error")
on completion. The user sees a single, compact ack on their own
message instead of three new messages.

**B. Progress-stage ack.**

Long-running agent task. Today: the agent text-replies at each phase
("starting", "step 2 of 4", "done"). With reactions: the agent reacts
🛠 on the user's original instruction, swaps it for ✅ on completion
(or ❌ on failure). One reaction emoji per stage, in-place, no
conversation pollution.

**C. Acknowledgement-only inputs.**

User says "thanks", "ok", "noted". Today: agent must either reply or
stay silent. With reactions: 👍 is sufficient and culturally
appropriate, AND the agent doesn't burn tokens generating a "you're
welcome" reply.

### Default emoji vocabulary

To keep agent prompts portable across connectors (and within
Telegram's bot-allowed emoji set), the recommended starter vocabulary
is:

| Emoji | Semantic |
|---|---|
| 👀 | "seen, processing" |
| ✅ | "done, success" |
| ❌ | "failed, refused, or denied" |
| 👍 | "acknowledged, no action needed" |
| 🛠 | "working on it (long task)" |
| ⏸ | "paused, awaiting input" |
| 🤔 | "ambiguous request, more info needed" |

All seven are in the Telegram bot-allowed set. Agents in their CLAUDE.md
or system prompt should map their internal states to these emoji and
prefer reactions over text for ack-only payloads.

### Wiring point

The daemon's `FastChecker.queueTelegramMessage` flow stays
text-centric — agents naturally express acks through their normal tool
flow (an `ackReaction(emoji)` bus command, dispatched by the CLI
through the active connector). PR5 will add:

* `cortextos bus react <message_id> <emoji>` CLI command
* `bus react` agent-template hook for tools that should auto-ack
* `connector.sendReaction()` method gated by `capabilities.outboundReactions`

### Failure mode

The `setMessageReaction` API on Telegram silently no-ops if the bot
tries an emoji outside the per-chat allowed set. To avoid silent
failures, `TelegramConnector.sendReaction` will (a) hit `getChat` once
per chat to cache the allowed list, (b) fall back to a configured
text-ack template if the emoji is rejected.

Other connectors have no such restriction.

---

## 12. Capability gap analysis: Discord, Mattermost, RocketChat

Auditing the current 9 capability flags + 6 proposed (§3) against each
target provider.

### Discord

| Flag | Supported? | Notes |
|---|---|---|
| `inlineButtons` | yes | Discord Components (buttons, select menus) |
| `media` | yes | Up to 25 MB (500 MB on Nitro) |
| `voiceTranscription` | no (provider does not transcribe; connector could integrate Whisper) | Same situation as Telegram |
| `formattedText` | yes | Markdown |
| `longPolling` | no — gateway WS only | Forces `webhookInbound` or a gateway implementation |
| `typingIndicator` | yes | `POST /channels/{id}/typing` |
| `reactions` (inbound) | yes | Gateway event `MESSAGE_REACTION_ADD` |
| `interactiveCallbacks` | yes | Component interaction tokens (15-min expiry; tighter than Telegram callback queries) |
| `messageEdits` | yes | `PATCH /channels/{id}/messages/{id}` |
| `outboundReactions` (proposed) | yes | `PUT /channels/{id}/messages/{id}/reactions/{emoji}/@me` |
| `threads` (proposed) | yes | First-class: `THREAD_CREATE` event + `POST /channels/{id}/threads` |
| `richBlocks` (proposed) | yes | Embeds (richer than blocks; up to 10 per message) |
| `webhookInbound` (proposed) | yes (interactions webhook) or gateway WS |
| `presence` (proposed) | yes | Gateway `PRESENCE_UPDATE` |

**Discord forces:** `webhookInbound` or a fundamental rework of the
polling abstraction (gateway WS is push, not poll). Recommended path:
implement Discord against gateway WS, set `longPolling: false`,
`webhookInbound: true`, and rename the interface method from
`startPolling` to `startInbound` (the WS connector starts a long-lived
WS connection; the long-poll connector starts a poll loop; both
implement the same lifecycle from the daemon's POV).

### Mattermost

| Flag | Supported? | Notes |
|---|---|---|
| `inlineButtons` | yes | Slash command response with attachment actions |
| `media` | yes | Configurable upload size (default 50 MB) |
| `voiceTranscription` | no | |
| `formattedText` | yes | Markdown |
| `longPolling` | yes | `GET /api/v4/users/me/channels/{id}/posts` with `since` param |
| `typingIndicator` | yes | WebSocket event `typing` |
| `reactions` (inbound) | yes | WS event `reaction_added` / `reaction_removed` |
| `interactiveCallbacks` | yes | Action ack via webhook callback URL |
| `messageEdits` | yes | `PUT /api/v4/posts/{id}` |
| `outboundReactions` (proposed) | yes | `POST /api/v4/reactions` |
| `threads` (proposed) | yes | `root_id` on Post |
| `richBlocks` (proposed) | yes | Attachments (Slack-style) |
| `webhookInbound` (proposed) | yes | Outgoing webhooks |
| `presence` (proposed) | yes | WS event `presence_change` |

**Mattermost is the cleanest fit.** Either long-poll or WS, full
capability coverage, native threads, native reactions. Recommended as
the second connector to land after Telegram.

### RocketChat

| Flag | Supported? | Notes |
|---|---|---|
| `inlineButtons` | yes | Attachment actions |
| `media` | yes | Configurable |
| `voiceTranscription` | no | |
| `formattedText` | yes | Markdown |
| `longPolling` | partial | REST has no native long-poll; emulated via `POST /api/v1/chat.getMessages` with `since`. Native path is realtime WS (DDP/Meteor protocol). |
| `typingIndicator` | yes | DDP method `stream-notify-room`/`typing` |
| `reactions` (inbound) | yes | DDP stream event `reactionAdded`/`reactionRemoved` |
| `interactiveCallbacks` | yes | `triggerId` reply |
| `messageEdits` | yes | `POST /api/v1/chat.update` |
| `outboundReactions` (proposed) | yes | `POST /api/v1/chat.react` |
| `threads` (proposed) | yes | `tmid` on Message (Thread Message ID) |
| `richBlocks` (proposed) | yes | Attachments + UIKit blocks |
| `webhookInbound` (proposed) | yes | Outgoing webhooks |
| `presence` (proposed) | yes | DDP user-status stream |

**RocketChat needs DDP.** The REST API is enough for outbound but the
real-time inbound path is the Meteor DDP WebSocket protocol. A
RocketChat connector that polls REST is workable but lossy; the proper
path is a DDP client. Recommended to defer until after Discord+
Mattermost validate the gateway/WS pattern.

### Summary: minimum viable interface extension

To support all three providers as first-class:

1. Rename `startPolling` → `startInbound` (covers poll + push); update
   the `longPolling` flag to `inbound: 'poll' | 'push' | 'none'`
   tri-state OR keep `longPolling` and add `pushInbound` as a parallel
   flag. Tri-state is cleaner.
2. Add `outboundReactions` flag + `sendReaction` method.
3. Add `threads` flag + `thread_id` field on `NormalizedMessage` and on
   `SendOptions`.
4. Generalize `NormalizedReactionPayload.{old,new}_reaction` from
   `TelegramReactionType[]` to a connector-agnostic `ConnectorReaction[]`
   shape (or keep it as-is and have non-Telegram connectors translate
   their native reaction shape into the Telegram tagged union for
   compatibility — uglier but no caller churn).
5. Add `richBlocks` capability + a `SendOptions.blocks` payload typed
   as `unknown` until we design a cross-provider block schema.
6. (Optional) Add `presence` capability + `PollingHandlers.onPresence`.

---

## 13. Adding a new connector — checklist

For a contributor adding e.g. `MattermostConnector`:

1. **Pick a kind name.** Lowercase, dash-free. `mattermost`, not
   `Mattermost` or `mm`.
2. **Add the kind to the type union** at `src/types/index.ts`:
   ```ts
   connector?: 'telegram' | 'none' | 'mattermost';
   ```
3. **Add the kind to the allowlist** at `src/connectors/index.ts:16`:
   ```ts
   export const CONNECTOR_ALLOWLIST: ConnectorKind[] =
     ['telegram', 'none', 'mattermost'];
   ```
4. **Define the env shape** in `src/connectors/types.ts`:
   ```ts
   export interface MattermostConnectorEnv {
     MM_URL: string;          // https://mattermost.example.com
     MM_TOKEN: string;        // bot personal access token
     MM_CHANNEL_ID: string;
     MM_ALLOWED_USER_ID?: string;
   }
   ```
5. **Create `src/connectors/mattermost/`:**
   * `api.ts` — Mattermost REST wrapper (or WS client)
   * `mattermost-connector.ts` — class `MattermostConnector implements MessageConnector`
   * `poller.ts` — inbound loop (or WS subscriber)
6. **Implement the interface.** Required methods first; optional
   methods only when the capability flag is `true`. Set capability
   flags to match §12.
7. **Extend the factory** at `src/connectors/index.ts:36`:
   ```ts
   case 'mattermost': {
     const env: MattermostConnectorEnv = {
       MM_URL: processEnv.MM_URL ?? '',
       MM_TOKEN: processEnv.MM_TOKEN ?? '',
       MM_CHANNEL_ID: processEnv.MM_CHANNEL_ID ?? '',
       MM_ALLOWED_USER_ID: processEnv.MM_ALLOWED_USER_ID ?? '',
     };
     return new MattermostConnector(agentDir, env);
   }
   ```
8. **Extend `getOperatorConnector`** if your connector is suitable as
   a daemon-level notification channel. Translate `CTX_OPERATOR_MM_*`
   into your `*ConnectorEnv` shape.
9. **Re-export** the class from `src/connectors/index.ts`:
   ```ts
   export { MattermostConnector } from './mattermost/mattermost-connector.js';
   ```
10. **Wire the CLI flags.** `src/cli/add-agent.ts`, `src/cli/setup.ts`,
    `src/cli/enable-agent.ts` all carry `--connector`. The setup
    wizard's interactive prompt also lives in `src/cli/setup.ts`.
    Extend the inline help and the preflight env-check copy.
11. **Add conformance tests** at
    `tests/unit/connectors/conformance.test.ts`. Pin `kind`, the
    boolean-ness of every capability flag, and the boolean values you
    advertise.
12. **Add a connector-specific test** at
    `tests/unit/connectors/mattermost-connector.test.ts` covering at
    least: `validateCredentials` happy/error paths, `sendMessage`
    happy path, the `startPolling → onMessage` round trip, ALLOWED_USER
    gate behavior.
13. **Add CHANGELOG entry** under
    `## [unreleased] — Pluggable Communications Connectors (PR<n> — mattermost)`.
14. **Update this doc.** Add a row to §12 if your audit revealed
    capability nuances, and update §7 with your stateDir convention.

Files touched (realistic count, from tracing what Mattermost would
need against the current code):

* `src/types/index.ts` — extend `AgentConfig.connector` union
* `src/connectors/index.ts` — `CONNECTOR_ALLOWLIST`, factory `switch`,
  re-export, and `getOperatorConnector` if applicable
* `src/connectors/types.ts` — `<Kind>ConnectorEnv` interface
* `src/connectors/<kind>/api.ts` — provider client
* `src/connectors/<kind>/<kind>-connector.ts` — implementation
* `src/connectors/<kind>/poller.ts` (or `gateway.ts` for push-inbound) —
  inbound loop
* `src/connectors/<kind>/media.ts` — only if `capabilities.media` is `true`
* `src/cli/add-agent.ts` — extend `--connector` choices + help
* `src/cli/setup.ts` — interactive wizard prompt + env-write path
* `src/cli/enable-agent.ts` — preflight env-check copy
* `src/bus/approval.ts` — extend the kind dispatch (PR4 c4 onward
  removed the Telegram-hardcoded cast at line 185, so this is just
  adding your kind to the switch)
* `src/daemon/agent-manager.ts` — extend the connector dispatch in
  `startAgent` if your kind needs construction args beyond what
  `getConnector` covers (most don't)
* `tests/unit/connectors/conformance.test.ts` — add cases for kind +
  capability flags
* `tests/unit/connectors/<kind>-connector.test.ts` — full unit suite
* `tests/unit/connectors/index-allowlist.test.ts` — extend allowlist
  expectation
* `CHANGELOG.md` — `## [unreleased] — Pluggable Communications
  Connectors (PR<n> — <kind>)` entry
* `docs/architecture/connectors.md` — append a row to §12 if the audit
  surfaced new capabilities, and §7 with your stateDir convention

That is **13–15 files**, not "6–8". Lines of new code: ~600–1200
depending on whether the provider needs a long-poll loop, a WS client,
or a gateway protocol (RocketChat's DDP path is the heaviest).

Existing tests that will need changes: at minimum
`tests/unit/connectors/index-allowlist.test.ts` (extend the expected
allowlist) and any test that imports the `ConnectorKind` literal type
in a way that needs widening. The conformance test gets an additive
case; legacy-compat-resolver and null-connector tests should not
change.

---

## 14. Testing requirements

A new connector PR is expected to ship with:

* **Conformance test** (compile-time + boolean-flag pinning).
* **Unit tests** for every required method, plus optional methods that
  the connector advertises as supported.
* **An inbound-pipeline test** that exercises `startPolling →
  onMessage / onCallback / onReaction` end-to-end with mocked HTTP.
* **An integration test under `tests/integration/`** that runs the
  connector against a mock server (Playwright is fine — see
  `tests/playwright/mock-telegram-server.ts` for the pattern).

CI gate: `npm run typecheck && npm test`. Both must pass clean.

---

## 15. Deprecated escape hatches

Three legacy seams remain in the codebase for one-release backwards
compatibility. New code MUST NOT use them; new connectors MUST NOT
introduce equivalents.

### `TelegramConnector.rawTelegramApi()`

Tagged `@internal @deprecated PR3+`. Three guarded callers:

1. `src/daemon/agent-process.ts` inside `setConnector(c)` — the
   `instanceof TelegramConnector` branch reads this to populate the
   legacy `telegramApi`/`telegramChatId` fields used by
   `CodexAppServerPTY`'s session-refresh path.
2. `src/daemon/agent-manager.ts` reads it once at construction so the
   shared `TelegramAPI` instance feeds the legacy `telegramApi`
   variable (rate-limit + warning-dedup parity).
3. The connector's own unit tests.

A CI grep guard at `tests/lint-no-stray-raw-api.test.ts` (when
present) enforces no new callers.

### `CallbackPayload.raw: unknown`

Tagged `@internal @deprecated PR3+`. Used by
`FastChecker.handleCallback` and the activity-channel callback path so
those paths can cast back to `TelegramCallbackQuery` for fields the
generic `CallbackPayload` doesn't carry. PR5 of the pluggable-
connectors stack will design the proper interactive-callback
abstraction and drop this field.

### `FastChecker` legacy constructor opts

`telegramApi` and `chatId` are accepted alongside `connector` for
one-release back-compat. New call sites pass `connector` and rely on
the connector for chatId routing. The legacy opts will be removed in
PR5.

### `bus/approval.ts` `'telegram'` cast

`src/bus/approval.ts:185` casts `resolvedKind` to `'telegram'` because
the `'none'` early-return above eliminates the only other current
kind. Adding a new connector kind requires extending this to a real
dispatch — TypeScript will catch it via the `'telegram' as const` cast
failing on the broader union.

---

## 16. Out-of-scope (today)

* **Webhook-only connectors** with no poll loop. The
  `longPolling: false` path exists for NullConnector but no
  push-inbound HTTP server is wired into the daemon yet. Discord +
  Slack will force this.
* **Cross-provider thread mapping.** Each provider's thread model is
  different (Discord first-class thread channels vs Mattermost
  `root_id` vs RocketChat `tmid`). The `threads` capability flag will
  be added in PR5; the cross-provider thread shape on
  `NormalizedMessage` will follow.
* **Rich block schema.** Every provider has its own (Discord embeds,
  Slack blocks, Mattermost attachments, RocketChat UIKit). A shared
  schema is out of scope until at least three of them are
  implemented; until then `SendOptions.blocks: unknown` is a typed
  escape hatch.
* **Generalizing `NormalizedReactionPayload`.** Today it carries
  `TelegramReactionType[]` because `FastChecker.formatTelegramReaction`
  consumes that shape. Generalization to `ConnectorReaction` is PR5+.

---

## 17. References

* Interface: `src/connectors/connector.ts`
* Types: `src/connectors/types.ts`
* Factory + allowlist: `src/connectors/index.ts`
* Telegram implementation: `src/connectors/telegram/`
* Null implementation: `src/connectors/none/null-connector.ts`
* Daemon wiring: `src/daemon/agent-manager.ts` (search for
  `connector.startPolling`)
* Bus wiring: `src/bus/approval.ts:188` (`getConnector(...)`)
* CLI wiring: `src/cli/bus.ts:1100`, `src/cli/setup.ts`,
  `src/cli/add-agent.ts`, `src/cli/enable-agent.ts`
* Conformance test: `tests/unit/connectors/conformance.test.ts`
* Telegram Bot API `setMessageReaction`:
  https://core.telegram.org/bots/api#setmessagereaction (Bot API 7.0+,
  Feb 2024)
