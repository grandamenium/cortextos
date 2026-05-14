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

// Provider-specific tagged-union shape needed by the existing
// `FastChecker.formatTelegramReaction` formatter. Imported (not re-defined)
// so reaction payloads stay byte-identical with current daemon behavior.
import type { TelegramReactionType } from '../types/index.js';

export type ConnectorKind = 'telegram' | 'none';

export interface ConnectorCapabilities {
  /** Connector supports inline-button rendering (Telegram inline_keyboard, Slack blocks, RocketChat attachment actions). */
  inlineButtons: boolean;
  /** Connector supports media attachments (photo / document upload). */
  media: boolean;
  /** Connector transcribes inbound voice/audio notes to text. */
  voiceTranscription: boolean;
  /** Connector supports formatted text (HTML/Markdown/blocks); caller may pass a parseMode hint. */
  formattedText: boolean;
  /** Connector exposes a long-poll loop for inbound messages. */
  longPolling: boolean;
  /** Connector supports a "typing..." indicator before replies. */
  typingIndicator: boolean;
  /** Connector emits reaction-add/change/remove updates. */
  reactions: boolean;
  /** Connector can acknowledge an inline-button callback (Telegram answerCallbackQuery, Slack ack response, RocketChat triggerId reply). */
  interactiveCallbacks: boolean;
  /** Connector can edit a previously-sent message in its bound chat (Telegram editMessageText, Slack chat.update, RocketChat updateMessage). */
  messageEdits: boolean;
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
  /** Original provider payload. Debug only; NEVER serialized to bus events. */
  raw: unknown;
}

/**
 * Reaction update payload — fires when a user adds, changes, or removes
 * an emoji reaction on a message the bot can see.
 *
 * PR1-pragma: this normalized payload carries the full Telegram tagged
 * union for reactions because `FastChecker.formatTelegramReaction` (the
 * existing formatter we route through) consumes that exact shape and
 * preserves custom-emoji info via the `{type:'custom_emoji',custom_emoji_id}`
 * variant. Matrix/RocketChat connectors will either translate their
 * native reaction shape to this Telegram shape OR a follow-up PR will
 * generalize the type (e.g. introducing `ConnectorReaction`). Out of
 * scope for this PR.
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
  /** Number, not stringified — matches `formatTelegramReaction(messageId: number)`. */
  message_id: number;
  /** Empty array means "no prior reaction". */
  old_reaction: TelegramReactionType[];
  /** Empty array means "user removed their reaction". */
  new_reaction: TelegramReactionType[];
  raw: unknown;
}

export interface SendOptions {
  parseMode?: 'markdown' | 'plain' | null;
  replyToId?: string;
  buttons?: Array<Array<{ text: string; callback_data: string }>>;
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

export interface PollingHandlers {
  /**
   * SYNC handler. Offset/ACK advance happens after this returns; thrown
   * handler aborts the batch (matches existing `TelegramPoller` behavior
   * at `src/connectors/telegram/poller.ts`). Any async work (media
   * download, transcription) initiated from inside must be fire-and-
   * forget exactly as today.
   */
  onMessage: (m: NormalizedMessage) => void;
  /** SYNC — same semantics as onMessage. */
  onCallback?: (c: CallbackPayload) => void;
  /** SYNC — same semantics as onMessage. */
  onReaction?: (r: NormalizedReactionPayload) => void;
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
