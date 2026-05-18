// Typed message contracts for the cortextOS bus.
//
// Background: the bus delivers arbitrary `text: string` messages between
// agents (see `InboxMessage` in src/types/index.ts). In practice messages
// carry implicit structure — `{kind: 'task'}`, `{kind: 'ack'}`, etc., often
// stuffed into the leading text. Several silent bus failures came from
// typo'd `kind` strings ('aks' instead of 'ack', 'borardcast' instead of
// 'broadcast') that the bus passed through verbatim because it has no
// schema notion. Senders blamed receivers; receivers blamed the bus.
//
// This module gives senders a typed `serializeBusContract` and gives the
// receiver path a best-effort `parseBusContract` that attaches a validated
// `contract` field to InboxMessage when the text body parses cleanly.
// Backward compat is total — plain-text messages still flow, the parser
// just returns null for them.
//
// Zod is NOT in package.json (verified via `npm ls zod`), and the schemas
// here are simple discriminated unions, so we hand-roll lightweight
// validators rather than add a runtime dep.

/**
 * The seven canonical message kinds. Adding a new kind here also requires:
 *   1. A typed interface below extending `BaseContractFields`
 *   2. A union arm in `BusContractMessage`
 *   3. A validator branch in `validateContract`
 *   4. A roundtrip test in `tests/bus/contracts.test.ts`
 */
export type BusContractKind =
  | 'task'
  | 'ack'
  | 'status'
  | 'query'
  | 'reply'
  | 'broadcast'
  | 'error';

/** Common fields every contract message shares. */
interface BaseContractFields {
  kind: BusContractKind;
  from: string;
  to: string;
}

// ---------------------------------------------------------------------------
// Per-kind shapes. Keep payloads minimal — the bus doesn't enforce their
// internal shape, only that they exist. Specific payload schemas can grow
// behind the kind discriminator without affecting the parse path.
// ---------------------------------------------------------------------------

/** A unit of work being handed off to another agent. */
export interface TaskMessage extends BaseContractFields {
  kind: 'task';
  /** Free-form task payload — typically `{ title, description, priority }`. */
  payload: Record<string, unknown>;
}

/** Acknowledgement that a prior message was received / acted upon. */
export interface AckMessage extends BaseContractFields {
  kind: 'ack';
  /** ID of the message being acknowledged. Stays in payload for symmetry. */
  payload: { ref?: string;[k: string]: unknown };
}

/** Periodic / on-demand status report. */
export interface StatusMessage extends BaseContractFields {
  kind: 'status';
  payload: Record<string, unknown>;
}

/** A question expecting a `reply`. */
export interface QueryMessage extends BaseContractFields {
  kind: 'query';
  payload: { question?: string;[k: string]: unknown };
}

/** A reply to a prior `query`. */
export interface ReplyMessage extends BaseContractFields {
  kind: 'reply';
  payload: { ref?: string;[k: string]: unknown };
}

/** Fan-out announcement — `to` may be a wildcard / group label. */
export interface BroadcastMessage extends BaseContractFields {
  kind: 'broadcast';
  payload: Record<string, unknown>;
}

/** Structured error envelope so receivers can branch on type. */
export interface ErrorMessage extends BaseContractFields {
  kind: 'error';
  payload: { code?: string; message?: string;[k: string]: unknown };
}

/**
 * Discriminated union of all seven contract messages. Use the `kind` field
 * to narrow.
 */
export type BusContractMessage =
  | TaskMessage
  | AckMessage
  | StatusMessage
  | QueryMessage
  | ReplyMessage
  | BroadcastMessage
  | ErrorMessage;

/** Set of valid kind strings — used by both parse and validate paths. */
const VALID_KINDS: ReadonlySet<BusContractKind> = new Set<BusContractKind>([
  'task', 'ack', 'status', 'query', 'reply', 'broadcast', 'error',
]);

/**
 * Best-effort parse a bus message text body into a typed contract.
 *
 * Returns null when:
 *   - Text is empty / whitespace
 *   - Text is not valid JSON
 *   - Text parses but the resulting value isn't an object
 *
 * Returns null AND callers can warn (but should NOT drop) when:
 *   - The JSON is an object but `kind` is missing or unknown
 *   - The JSON is an object but `from` / `to` are missing or non-string
 *   - The kind-specific shape fails its validator
 *
 * Distinguishing "not a contract at all" from "broken contract" matters:
 * the bus dispatch in `checkInbox` should preserve legacy plain-text
 * messages silently but log a warning on broken contract attempts so
 * authoring bugs are visible.
 */
export function parseBusContract(text: string): BusContractMessage | null {
  if (!text || text.trim() === '') return null;
  // Cheap pre-filter — JSON.parse is forgiving but throwing on every
  // plain-text message would flood the parser. Only attempt parsing when
  // the body looks JSON-shaped.
  const trimmed = text.trim();
  if (trimmed[0] !== '{' && trimmed[0] !== '[') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Malformed JSON in a JSON-shaped body — return null instead of throwing
    // so the bus path never crashes on a corrupt sender.
    return null;
  }
  return validateContract(parsed);
}

/**
 * Validate an already-parsed JSON value as a contract message.
 *
 * Exported so callers that already JSON.parsed can validate without a
 * redundant parse pass.
 */
export function validateContract(value: unknown): BusContractMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const kind = v['kind'];
  if (typeof kind !== 'string' || !VALID_KINDS.has(kind as BusContractKind)) {
    return null;
  }
  const from = v['from'];
  const to = v['to'];
  if (typeof from !== 'string' || typeof to !== 'string' || !from || !to) {
    return null;
  }
  // payload may be absent in the wild — coerce to {} to keep narrowing clean.
  const payloadRaw = v['payload'];
  const payload: Record<string, unknown> =
    payloadRaw && typeof payloadRaw === 'object' && !Array.isArray(payloadRaw)
      ? (payloadRaw as Record<string, unknown>)
      : {};

  // Per-kind narrow construction. Each branch builds the discriminated union
  // member so the return type is a `BusContractMessage`.
  switch (kind as BusContractKind) {
    case 'task':
      return { kind: 'task', from, to, payload };
    case 'ack':
      return { kind: 'ack', from, to, payload };
    case 'status':
      return { kind: 'status', from, to, payload };
    case 'query':
      return { kind: 'query', from, to, payload };
    case 'reply':
      return { kind: 'reply', from, to, payload };
    case 'broadcast':
      return { kind: 'broadcast', from, to, payload };
    case 'error':
      return { kind: 'error', from, to, payload };
  }
}

/**
 * Serialize a typed contract message to a JSON string suitable for the
 * `text` field of an InboxMessage. The output is stable (sorted keys: kind,
 * from, to, payload) so two equivalent messages serialize identically —
 * useful for the dedup paths that hash message text.
 */
export function serializeBusContract(msg: BusContractMessage): string {
  // Manual ordering — JSON.stringify doesn't sort keys.
  return JSON.stringify({
    kind: msg.kind,
    from: msg.from,
    to: msg.to,
    payload: msg.payload,
  });
}

/**
 * Type guard for narrowing an InboxMessage's optional `contract` field
 * against a specific kind. Convenience helper for consumers.
 */
export function isContractKind<K extends BusContractKind>(
  msg: BusContractMessage | undefined,
  kind: K,
): msg is Extract<BusContractMessage, { kind: K }> {
  return !!msg && msg.kind === kind;
}
