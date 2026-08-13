import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { schnorr, utils as secpUtils, hashes as secpHashes } from '@noble/secp256k1';
import { bytesToHex, hexToBytes, utf8ToBytes, concatBytes } from '@noble/hashes/utils.js';

// @noble/secp256k1 v3 requires the consumer to wire in its hash functions
// rather than bundling one itself (keeps the core package hash-agnostic).
// Without this, schnorr.sign/verify throw "hashes.sha256 not set" at
// runtime — set once at module load, before any signing/verification call.
secpHashes.sha256 = sha256;
secpHashes.hmacSha256 = (key: Uint8Array, ...messages: Uint8Array[]) =>
  hmac(sha256, key, concatBytes(...messages));

/**
 * Minimal Nostr (NIP-01) event construction and signing — the narrow subset
 * Buzz's NIP-29 direct-connection protocol needs: build the canonical
 * serialization, hash it to get the event id, and produce a BIP-340 schnorr
 * signature over that id.
 *
 * Deliberately not a general-purpose Nostr SDK: no relay-list parsing, no
 * NIP-04/44 encryption, no bech32 (npub/nsec) helpers. Buzz agents only need
 * to sign and publish kind:9 (channel message) and kind:22242 (NIP-42 auth)
 * events, and optionally verify relay-signed discovery events.
 *
 * Uses `@noble/secp256k1` + `@noble/hashes` for the schnorr signature and
 * sha256 hashing rather than a hand-rolled implementation — see the "New
 * dependency" note in docs/superpowers/specs/sp4-buzz-adapter-design.md and
 * the PR description for why this one exception to the zero-deps convention
 * was made.
 */

export interface NostrTag extends Array<string> {}

export interface UnsignedNostrEvent {
  pubkey: string;
  created_at: number;
  kind: number;
  tags: NostrTag[];
  content: string;
}

export interface NostrEvent extends UnsignedNostrEvent {
  id: string;
  sig: string;
}

/**
 * Computes the NIP-01 event id: sha256 of the canonical JSON serialization
 * `[0, pubkey, created_at, kind, tags, content]` with no extra whitespace.
 */
export function computeEventId(event: UnsignedNostrEvent): string {
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
  return bytesToHex(sha256(utf8ToBytes(serialized)));
}

/**
 * Builds and signs a Nostr event.
 *
 * @param kind Nostr event kind (9 = channel message, 22242 = NIP-42 auth).
 * @param content Event content (message text; empty string for AUTH events).
 * @param tags Event tags (e.g. `[["h", channelId]]`).
 * @param secretKeyHex Hex-encoded 32-byte secp256k1 secret key.
 */
export function buildEvent(
  kind: number,
  content: string,
  tags: NostrTag[],
  secretKeyHex: string,
): NostrEvent {
  const secretKey = hexToBytes(secretKeyHex);
  const pubkey = bytesToHex(schnorr.getPublicKey(secretKey));

  const unsigned: UnsignedNostrEvent = {
    pubkey,
    created_at: Math.floor(Date.now() / 1000),
    kind,
    tags,
    content,
  };

  const id = computeEventId(unsigned);
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), secretKey));

  return { ...unsigned, id, sig };
}

/**
 * Builds a NIP-42 kind:22242 AUTH event responding to a relay challenge.
 * Tags: `[["relay", relayUrl], ["challenge", challenge]]`, per the wire
 * protocol in NOSTR.md / buzz-ws-client's connection.rs reference.
 */
export function buildAuthEvent(
  challenge: string,
  relayUrl: string,
  secretKeyHex: string,
): NostrEvent {
  return buildEvent(22242, '', [
    ['relay', relayUrl],
    ['challenge', challenge],
  ], secretKeyHex);
}

/**
 * Builds a kind:9 channel message event. `replyToEventId`, when provided,
 * adds a NIP-10 `["e", "<parent-event-id>", "", "reply"]` tag.
 */
export function buildChannelMessageEvent(
  channelId: string,
  content: string,
  secretKeyHex: string,
  replyToEventId?: string,
): NostrEvent {
  const tags: NostrTag[] = [['h', channelId]];
  if (replyToEventId) {
    tags.push(['e', replyToEventId, '', 'reply']);
  }
  return buildEvent(9, content, tags, secretKeyHex);
}

/**
 * Verifies a (typically relay-signed) event's signature and id integrity.
 * Returns false on any malformed input rather than throwing — callers treat
 * an unverifiable event as untrusted, not as an error condition.
 */
export function verifyEvent(event: NostrEvent): boolean {
  try {
    const unsigned: UnsignedNostrEvent = {
      pubkey: event.pubkey,
      created_at: event.created_at,
      kind: event.kind,
      tags: event.tags,
      content: event.content,
    };
    const expectedId = computeEventId(unsigned);
    if (expectedId !== event.id) return false;
    return schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(event.pubkey));
  } catch {
    return false;
  }
}

/**
 * Derives the hex-encoded public key for a hex-encoded secret key.
 */
export function getPublicKey(secretKeyHex: string): string {
  return bytesToHex(schnorr.getPublicKey(hexToBytes(secretKeyHex)));
}

/**
 * Generates a fresh random secp256k1 keypair (hex-encoded). Used by the
 * `buzz-admin`-equivalent out-of-band key generation flow — NOT called from
 * `add-agent` (see the "Identity minting UX" decision in the design spec /
 * PR description: key generation is a deliberate, separate operator step).
 */
export function generateKeypair(): { secretKey: string; pubkey: string } {
  const secretKeyBytes = secpUtils.randomSecretKey();
  const secretKey = bytesToHex(secretKeyBytes);
  const pubkey = bytesToHex(schnorr.getPublicKey(secretKeyBytes));
  return { secretKey, pubkey };
}
