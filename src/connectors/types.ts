/**
 * Shared types for the pluggable communications connector layer.
 *
 * The connector abstraction lets cortextOS agents talk to user-facing
 * messaging transports (Telegram today; Matrix, RocketChat, Slack, etc.
 * in future PRs) through a single interface. See `MessageConnector` in
 * `./connector.ts` for the interface contract.
 *
 * Field-naming convention: snake_case for fields that pass through
 * provider source shape (`message_id`, `chat_id`, `old_reaction`,
 * `new_reaction`, `reply_to`). camelCase for connector-derived fields
 * (`localPath` on media, capability flags). Same rule the rest of the
 * codebase follows for bus messages.
 */

export type ConnectorKind = 'telegram' | 'none';

/**
 * Connector-agnostic reaction shape. PR4 c8 (Codex P1.F) lifted this
 * out of the Telegram-specific `TelegramReactionType` tagged union so
 * Discord, Mattermost, RocketChat, and Slack connectors can populate
 * `NormalizedReactionPayload.{old,new}_reaction` natively.
 *
 * `kind`:
 *   - `'unicode'` — `value` is the emoji character itself (Telegram
 *     emoji reactions, Discord unicode reactions, Mattermost emoji
 *     reactions referenced by their unicode codepoint, RocketChat
 *     emoji reactions, Slack `:thumbsup:` shortcodes resolved to
 *     unicode).
 *   - `'custom'` — `value` is the provider's opaque custom-emoji id
 *     (Telegram `custom_emoji_id`, Discord custom-emoji id,
 *     Mattermost emoji_name, RocketChat shortcode). Renderers that
 *     can't resolve the id fall back to a `[custom]` label.
 */
export interface ConnectorReaction {
  kind: 'unicode' | 'custom';
  value: string;
}

export interface ConnectorCapabilities {
  /** Connector supports inline-button rendering (Telegram inline_keyboard, Slack blocks, RocketChat attachment actions). */
  inlineButtons: boolean;
  /** Connector supports media attachments (photo / document upload). */
  media: boolean;
  /** Connector transcribes inbound voice/audio notes to text. */
  voiceTranscription: boolean;
  /** Connector supports formatted text (HTML/Markdown/blocks); caller may pass a parseMode hint. */
  formattedText: boolean;
  /**
   * Inbound delivery model. PR4 c11 (Codex P1.I) replaced the previous
   * `longPolling: boolean` flag with this tri-state so push-inbound
   * providers (Discord gateway WS, Mattermost outgoing webhooks,
   * RocketChat DDP) fit the model.
   *
   * - `'poll'` — connector runs a long-poll loop on its own clock
   *   (Telegram getUpdates today, Mattermost REST polling fallback).
   * - `'push'` — connector subscribes to a provider push channel
   *   (Discord gateway WebSocket, Mattermost outgoing webhook
   *   listener, RocketChat DDP subscription). The connector still
   *   exposes the same `startInbound` lifecycle method; the only
   *   visible difference is no internal poll-interval clock.
   * - `'none'` — no inbound (NullConnector; send-only operator
   *   connector).
   *
   * The daemon treats `'poll'` and `'push'` identically at the wiring
   * site — it calls `startInbound(handlers, opts)` and the connector
   * decides how to receive. `'none'` is the explicit opt-out: the
   * daemon does NOT call `startInbound` and skips inbound wiring.
   */
  inbound: 'poll' | 'push' | 'none';
  /** Connector supports a "typing..." indicator before replies. */
  typingIndicator: boolean;
  /** Connector emits reaction-add/change/remove updates (INBOUND). */
  reactions: boolean;
  /** Connector can SEND a reaction on a user's message — agents acknowledge
   *  with emoji instead of (or alongside) a text reply. Telegram backs this
   *  via `setMessageReaction` (Bot API 7.0+); Discord, Mattermost, RocketChat
   *  all support it natively. See docs/architecture/connectors.md §11 for
   *  the UX patterns (👀 seen / ✅ done / ❌ failed / 👍 ack / 🛠 working /
   *  ⏸ paused / 🤔 ambiguous) and connector method `sendReaction`. */
  outboundReactions: boolean;
  /** Connector can acknowledge an inline-button callback (Telegram answerCallbackQuery, Slack ack response, RocketChat triggerId reply). */
  interactiveCallbacks: boolean;
  /** Connector can edit a previously-sent message in its bound chat (Telegram editMessageText, Slack chat.update, RocketChat updateMessage). */
  messageEdits: boolean;
  /**
   * Provider has a first-class concept of threaded conversations —
   * subgroups of messages addressable as a unit, distinct from inline
   * `reply_to`. The provider-specific shape varies:
   *   - Discord: thread CHANNEL (a sub-channel under a parent channel).
   *   - Mattermost / RocketChat / Slack: thread ROOT MESSAGE
   *     (a message id; replies carry root_id / tmid / thread_ts).
   *   - Matrix: thread ROOT EVENT (m.thread relation).
   *   - Telegram forum supergroups: forum TOPIC
   *     (a message_thread_id on each message). PR4 c21 (round-4 H2.5)
   *     reconsidered whether Telegram should advertise `true` here —
   *     forum topics ARE message_thread_id-tagged and conceptually map
   *     to threads. For now Telegram advertises `false` because the
   *     existing TelegramConnector ignores `message_thread_id` and a
   *     proper forum-topic implementation is its own PR; flipping the
   *     flag without that wiring would silently drop messages outside
   *     the bot's default topic.
   *
   * When `true`:
   *   - `NormalizedMessage.thread_id` carries the opaque
   *     provider-specific thread target id on inbound.
   *   - `SendOptions.thread_id` round-trips that value to post into
   *     the same thread on outbound.
   *
   * Added in PR4 c20. The thread_id field's contract is "opaque
   * provider thread target id" — see the NormalizedMessage.thread_id
   * and SendOptions.thread_id docstrings for the per-provider mapping
   * each connector implements internally. Agents must not interpret
   * the value beyond round-tripping.
   */
  threads: boolean;
  /**
   * Provider supports structured rich content (embeds, cards, blocks)
   * beyond inline-keyboard buttons. Discord embeds, Slack blocks,
   * Mattermost attachments, Matrix HTML `formatted_body`. Telegram
   * has no first-class block schema (HTML inside sendMessage covers
   * basic formatting but not the card-style UX).
   *
   * When `true`:
   *   - `SendOptions.blocks` carries the provider-native payload
   *     (deliberately typed `unknown` — see the field's comment).
   *
   * Added in PR4 c20. A cross-provider block schema is out of scope
   * until at least three connectors with native block support land
   * and a useful intersection falls out of the union; until then
   * each connector documents its own expected shape.
   */
  richBlocks: boolean;
  /**
   * Provider exposes online/offline/typing presence updates as a
   * separate event stream from chat messages. Discord gateway
   * `PRESENCE_UPDATE` (guild-scoped) + `TYPING_START` (channel-scoped),
   * Matrix `m.presence` (global) + `m.typing` (room-scoped) ephemeral
   * events. Telegram has no presence concept for bots.
   *
   * When `true`:
   *   - `PollingHandlers.onPresence` is invoked for each presence
   *     update with a `NormalizedPresenceUpdate` carrying a
   *     discriminated `scope` ('global' / 'chat' / 'guild') so the
   *     daemon can route per-scope correctly.
   *
   * Added in PR4 c20; scope discriminator added in c21.
   */
  presence: boolean;
}

export type ValidateResult =
  | { ok: true; identity: string }
  | {
      ok: false;
      reason: 'bad_credentials' | 'unreachable_recipient' | 'network_error' | 'rate_limited' | 'config_error';
      detail: string;
    };

/**
 * Pre-processed media attachment. The connector downloads the file (and
 * transcribes voice/audio where supported) before emitting the
 * NormalizedMessage that carries this, so the daemon can dispatch by
 * `kind` without owning provider-specific media plumbing. PR4+ of the
 * pluggable-connectors stack lifted this from a transitional inline
 * type into a first-class shape so future connectors (Matrix,
 * RocketChat) populate the same fields.
 */
export interface NormalizedMedia {
  /** Discriminator the daemon uses to pick the right format function. */
  kind: 'photo' | 'voice' | 'document' | 'video' | 'audio' | 'video_note';
  /** Absolute path to the downloaded file on the connector's local disk. */
  localPath: string;
  /** MIME type when the provider exposed one. Optional — pre-PR4 Telegram
   *  callers never populated this and the daemon doesn't read it; reserved
   *  for future connectors that need MIME-based dispatch. */
  mime?: string;
  /** Original filename (document attachments + named audio uploads). */
  fileName?: string;
  /** Duration in seconds (voice/audio/video/video_note). */
  duration?: number;
  /** Transcribed text from voice/audio messages, when the connector's
   *  transcription pipeline is wired and produced a result. */
  transcription?: string;
}

export interface NormalizedMessage {
  /** Connector-specific message id, stringified. */
  id: string;
  /** Unix ms. */
  ts: number;
  /** Originating user. `id` is stringified for cross-connector consistency
   *  (Telegram numeric, Matrix MXID, RocketChat username). */
  from: { id: string; username?: string; name?: string };
  /** Text body. For media messages, this carries the caption. */
  text: string;
  /** Inbound message's own chat id (stringified). Daemon falls back to the
   *  agent's bound chatId when absent — matches today's
   *  `msg.chat?.id ?? chatId ?? ''` resolution. Populated by the connector
   *  during normalization so the daemon's onMessage hot path no longer
   *  needs to cast `m.raw` back to a provider shape. */
  chat_id?: string;
  /** Pre-processed media attachment. Present iff the inbound message
   *  carried media AND the connector was configured with a downloadDir.
   *  When absent (text-only message, or media-without-downloadDir), the
   *  daemon dispatches the text path. */
  media?: NormalizedMedia;
  /** Reply chain. `id` is the connector-specific id of the message being
   *  replied to. `text` is a human-readable rendering of the replied-to
   *  message — for text/caption it's the body; for media it's a label like
   *  `[photo]` / `[voice message]`. Connectors populate `text` so the
   *  daemon doesn't have to read provider-specific media flags off `raw`
   *  to render reply context. */
  reply_to?: { id: string; text?: string };
  /** Thread target id (stringified). Opaque, provider-specific. The
   *  semantic varies by provider:
   *    - Discord: thread CHANNEL id (sending to a thread is
   *      `POST /channels/{thread_channel_id}/messages`).
   *    - Matrix: the root event_id (used in `m.relates_to.event_id`).
   *    - Mattermost: `root_id` (parent message id).
   *    - RocketChat: `tmid` (parent message id).
   *    - Slack: `thread_ts` (parent message timestamp-id).
   *    - Telegram forum supergroups: `message_thread_id` (topic id).
   *
   *  The daemon/agent must NOT attempt to interpret the value beyond
   *  round-tripping it: pass it back unchanged via `SendOptions.thread_id`
   *  to post into the same thread. Each connector knows how to translate
   *  its native shape both directions. PR4 c21 (Codex round-4 H2.3)
   *  reframed this field's contract from "thread root message id" to
   *  "opaque thread target id" because Discord and Telegram forum
   *  topics don't fit the root-message-id model. */
  thread_id?: string;
  /** Original provider payload. Debug only; NEVER serialized to bus events. */
  raw: unknown;
}

/**
 * Reaction update payload — fires when a user adds, changes, or removes
 * an emoji reaction on a message the bot can see.
 *
 * PR4 c8 (Codex P1.F) generalized the `{old,new}_reaction` arrays from
 * the Telegram-specific `TelegramReactionType` tagged union to the
 * connector-agnostic `ConnectorReaction` shape and stringified
 * `message_id` for cross-connector consistency. The Telegram connector
 * translates Telegram's tagged union to `ConnectorReaction` at
 * normalization time; future Discord / Mattermost / RocketChat
 * connectors populate `ConnectorReaction` directly.
 */
export interface NormalizedReactionPayload {
  /** Synthesized update id (Telegram has no native one): `${message_id}-${date}`. */
  id: string;
  ts: number;
  from: { id: string; username?: string; name?: string };
  /** Reaction's own chat id (stringified). Daemon falls back to agent's
   *  chatId when absent — matches today's
   *  `reaction.chat?.id ?? chatId ?? ''` resolution. */
  chat_id?: string;
  /** Stringified message id (provider-format-agnostic). */
  message_id: string;
  /** Empty array means "no prior reaction". */
  old_reaction: ConnectorReaction[];
  /** Empty array means "user removed their reaction". */
  new_reaction: ConnectorReaction[];
  raw: unknown;
}

/**
 * Connector-agnostic inline action (button) descriptor. PR4 c9 (Codex
 * P1.G) lifted this out of the Telegram-specific
 * `{text, callback_data}` shape so Discord components, Mattermost
 * attachment actions, and RocketChat triggers can share a single
 * `SendOptions.buttons` schema.
 *
 * PR4 c15 (Codex round-2 P1.C) made the shape a discriminated union
 * so the two distinct button semantics — callback button (sends an
 * event to the bot when clicked) vs URL button (opens an external
 * link, no callback to the bot) — are both expressible:
 *
 * - `'callback'` — Telegram inline_keyboard `{text, callback_data}`,
 *   Discord ButtonStyle.Primary/Secondary/Danger with custom_id,
 *   Mattermost attachment action with integration.context.action_id,
 *   RocketChat block button with value.
 * - `'url'` — Telegram inline_keyboard `{text, url}`, Discord
 *   ButtonStyle.Link (NO custom_id allowed, url is mandatory),
 *   Mattermost attachment action with url field, RocketChat block
 *   button with url.
 *
 * `actionId` on callback actions round-trips back as
 * `CallbackPayload.data` when the user clicks — byte-identical
 * across all four target providers, so the agent's parser of
 * `callback.data` is provider-agnostic.
 */
export type ConnectorAction =
  | {
      kind: 'callback';
      /** Visible label rendered on the button. */
      label: string;
      /** Opaque action id round-tripped as CallbackPayload.data when clicked. */
      actionId: string;
      /** Visual style hint — connectors may ignore. `primary`=affirmative
       *  (Discord blurple, Mattermost good), `danger`=destructive (Discord
       *  red, Mattermost danger), `secondary`=neutral (default). */
      style?: 'primary' | 'secondary' | 'danger';
    }
  | {
      kind: 'url';
      /** Visible label rendered on the button. */
      label: string;
      /** External URL to open when clicked. No callback fires. */
      url: string;
    };

export interface SendOptions {
  parseMode?: 'markdown' | 'plain' | null;
  replyToId?: string;
  /** 2D layout: outer array = rows, inner array = buttons in row.
   *  Telegram inline_keyboard, Discord components rows, etc.
   *  Connectors with row limits (Telegram: 8 buttons per row max)
   *  truncate or refuse — capability flag `inlineButtons` is the
   *  precondition for using this. */
  buttons?: Array<Array<ConnectorAction>>;
  /** Post the outbound message INTO the named thread. The value is the
   *  opaque provider-specific thread target id round-tripped from
   *  `NormalizedMessage.thread_id` (see that field's docstring for the
   *  per-provider semantic). Gated by `capabilities.threads === true`;
   *  connectors that don't support threads ignore this field. Added in
   *  PR4 c20; contract clarified in c21. */
  thread_id?: string;
  /** Provider-native rich-content payload (Discord embeds, Slack blocks,
   *  Mattermost attachments, Matrix HTML, etc.). Deliberately untyped
   *  (`unknown`) until at least three connectors with native block
   *  support land and a useful cross-provider intersection emerges.
   *  Gated by `capabilities.richBlocks === true`; connectors that
   *  don't support blocks ignore this field. Each connector documents
   *  its expected shape in its own README until the shared schema
   *  materializes. Added in PR4 c20. */
  blocks?: unknown;
  /** Skip Markdown→provider conversion entirely. Caller is sending pre-formatted text. */
  raw?: boolean;
}

export interface SendResult {
  /** Connector-specific outbound message id. */
  id: string;
  ts: number;
}

export interface CallbackPayload {
  /** Connector-specific callback query id, stringified. */
  id: string;
  /** User who clicked the button. PR4 c7 (Codex P1.A) added `username`
   *  and `name` so FastChecker's audit-trail formatter
   *  ("Approved by Alice (@alice)") can consume the typed shape instead
   *  of reading provider-specific fields off `raw`. */
  from: { id: string; username?: string; name?: string };
  /** Opaque action id the agent passed when constructing the button.
   *  Same as `ConnectorAction.actionId` on outbound — connectors round-trip
   *  it byte-for-byte (Telegram callback_data, Discord custom_id,
   *  Mattermost integration id, RocketChat triggerId payload). */
  data: string;
  /** id of the message the user clicked the button on, stringified. */
  message_id: string;
  /** Chat id of the message the user clicked on (stringified). Connectors
   *  populate this when the provider exposes one. Used by the legacy
   *  non-connector edit path; the connector path uses the connector's
   *  bound chat instead. Added in PR4 c7 so callers don't need to cast
   *  `raw` back to the provider shape just to read this. */
  chat_id?: string;
  /**
   * Original provider payload (e.g. the full `TelegramCallbackQuery`).
   * @internal @deprecated PR4+ — kept transitionally as an escape hatch
   * for fields not yet on the generic type. New callers MUST use the
   * typed fields above; PR4 c7 migrated FastChecker's callback paths
   * off `raw`. Producers MUST populate so transitional callers keep
   * working; future connectors without a native single-payload shape
   * may pass `null`.
   */
  raw: unknown;
}

/**
 * Presence update payload. PR4 c20 added support for connectors that
 * surface online/offline/typing events as a separate event stream
 * (Discord gateway `PRESENCE_UPDATE` + `TYPING_START`, Matrix
 * `m.presence` + `m.typing` ephemerals).
 *
 * `kind` is intentionally narrow:
 *   - `'online'` — user came online (or, for `'typing'`-only providers
 *     that don't expose offline, this is the only signal).
 *   - `'offline'` — user went offline / disconnected.
 *   - `'typing'` — user is currently composing a message. Auto-clears
 *     on the provider's side after ~10s; the connector does not need
 *     to emit a "stopped typing" event explicitly.
 *
 * `scope` (PR4 c21, Codex round-4 H2.4) discriminates how the presence
 * is bound. Pre-c21 we had `chat_id?: string` which couldn't represent
 * Discord's guild-scoped PRESENCE_UPDATE cleanly. The discriminated
 * shape covers all cross-provider cases:
 *   - `'global'` — user-wide presence (Matrix `m.presence`, Discord
 *     online/offline relative to the whole user, Slack user.presence).
 *     `id` is absent.
 *   - `'chat'` — chat / room / channel scoped (typing in a specific
 *     conversation). `id` is the chat/room/channel id.
 *   - `'guild'` — Discord guild-scoped presence (a user came online
 *     in this guild). `id` is the guild id. Matrix has no equivalent.
 *
 * Telegram bots don't expose presence and advertise
 * `capabilities.presence === false`; no Telegram presence updates fire.
 */
export interface NormalizedPresenceUpdate {
  id: string;
  ts: number;
  from: { id: string; username?: string; name?: string };
  /** Discriminated scope of the presence event. Replaces the c20 `chat_id?` field. */
  scope:
    | { kind: 'global' }
    | { kind: 'chat'; id: string }
    | { kind: 'guild'; id: string };
  kind: 'online' | 'offline' | 'typing';
  raw: unknown;
}

export interface PollingHandlers {
  /**
   * SYNC handler (the default) OR async (Promise-returning) — see PR4
   * c4 + c14 for the awaitable-handler semantics. Offset/ACK advance
   * happens after this returns / resolves; thrown handler OR rejected
   * promise leaves the offset un-advanced and aborts the batch.
   */
  onMessage: (m: NormalizedMessage) => void;
  /** SYNC — same semantics as onMessage. */
  onCallback?: (c: CallbackPayload) => void;
  /** SYNC — same semantics as onMessage. */
  onReaction?: (r: NormalizedReactionPayload) => void;
  /** SYNC. Fires for presence updates (online / offline / typing).
   *  Only invoked when `capabilities.presence === true`. Daemon may
   *  ignore or surface to agents per its own policy. Added in PR4 c20. */
  onPresence?: (p: NormalizedPresenceUpdate) => void;
}

/**
 * Typed env shape consumed by `TelegramConnector`. The connector factory
 * (`getConnector`) unpacks the right keys per connector before constructing;
 * the legacy daemon path constructs `TelegramConnector` directly with
 * already-parsed values to avoid double-parsing.
 */
export interface TelegramConnectorEnv {
  BOT_TOKEN: string;
  CHAT_ID: string;
  ALLOWED_USER: string;
}
