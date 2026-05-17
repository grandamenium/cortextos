/**
 * PTY output redaction.
 *
 * Secret-bearing output can reach the PTY capture stream whenever an agent
 * runs a shell command that prints credentials — curl -v against an
 * authenticated endpoint, wget --debug, openssl s_client, dumping a cookie
 * jar, etc. The PTY's OutputBuffer ring captures everything the child
 * process emits and also streams it verbatim to a persisted stdout.log.
 * Without redaction, any JWT, bearer token, or session cookie that happens
 * to appear in the agent's terminal ends up persisted to disk indefinitely.
 *
 * Origin: discovered via a baseline gitleaks audit of agent stdout logs
 * which found 16 JWTs (`authjs.session-token=eyJ...`) emitted to stdout
 * by `curl -v` against an authenticated NextAuth endpoint. Initial
 * hypothesis was that a logging code path was at fault; the actual cause
 * turned out to be agent-level shell commands the PTY captured faithfully.
 * The fix therefore lives at the PTY layer (defense-in-depth for any
 * future exposure via any tool) rather than in an individual code path.
 *
 * Known limitation: PTY data arrives in OS-buffered chunks (typically 4KB
 * on Linux). If a chunk boundary happens to fall inside a JWT, neither
 * chunk matches the regex and the token slips through unredacted across
 * two push() calls. JWTs are typically 300-500 bytes so they fit in one
 * chunk in the overwhelming majority of real cases — every observed leak
 * in the origin audit fit in a single chunk. Buffer-aware redaction
 * (carry a trailing partial-match buffer across chunks) is the follow-up
 * if this edge case ever surfaces in production. Test `chunk-boundary
 * regression guard` in output-buffer.test.ts locks this documented
 * behavior in place so any future change has to be explicit.
 */

/**
 * JWT shape: three base64url segments separated by dots, each at least
 * 10 characters long. The length qualifier prevents false positives on
 * random short alphanumeric sequences that happen to contain two dots
 * (e.g. "a.b.c" or "v1.2.3" would not match). `eyJ` prefix anchors on
 * the standard JWT header (base64 encoding of `{"alg":...` or
 * `{"typ":...`).
 */
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;

/**
 * Extended secret patterns (Wave-0 B3) — surfaced by 2026-05-17 security audit
 * SEC-001/003: live OAuth + Telegram bot tokens were found in plaintext logs
 * and outbound-messages.jsonl because JWT-only redaction missed them.
 */
// Anthropic OAuth + API key tokens. sk-ant-oat01-* is OAuth (long-lived per fleet);
// sk-ant-api03-* is direct API key. Both ~100+ chars after the prefix.
const ANTHROPIC_TOKEN_PATTERN = /sk-ant-(?:oat01|api03)-[A-Za-z0-9_-]{20,}/g;
// OpenRouter sk-or-v1-... keys (occasionally injected for multi-LLM bridges).
const OPENROUTER_TOKEN_PATTERN = /sk-or-v1-[A-Za-z0-9]{20,}/g;
// Telegram bot token: <int>:<base64-ish> (35-char random suffix).
// Anchor on word boundary to avoid false positives mid-hex-string.
const TELEGRAM_BOT_TOKEN_PATTERN = /\b\d{6,}:[A-Za-z0-9_-]{30,}/g;
// Bearer <token> in Authorization headers. Case-insensitive.
const BEARER_HEADER_PATTERN = /[Bb]earer\s+[A-Za-z0-9._\-+\/=]{16,}/g;
// Telegram API URLs that embed the bot token in the path: /bot<token>/<method>.
// Strip the token portion so log lines like "fetch failed for https://api.telegram.org/bot<TOKEN>/getUpdates" don't leak.
const TELEGRAM_BOT_URL_PATTERN = /\/bot\d+:[A-Za-z0-9_-]{30,}\//g;

/**
 * Redact secrets from a PTY output chunk.
 *
 * Replaces each match with a literal `[REDACTED_*]` marker in-place.
 * Order matters: more-specific patterns first (URL containing token before
 * the bare token pattern) so we don't double-redact partial matches.
 * Non-secret content passes through unchanged. Safe to call on every PTY
 * chunk — all regexes are stateless and scale linearly with input length.
 */
export function redactSecrets(data: string): string {
  return data
    .replace(TELEGRAM_BOT_URL_PATTERN, '/bot[REDACTED_TG_TOKEN]/')
    .replace(ANTHROPIC_TOKEN_PATTERN, '[REDACTED_ANTHROPIC_TOKEN]')
    .replace(OPENROUTER_TOKEN_PATTERN, '[REDACTED_OPENROUTER_TOKEN]')
    .replace(BEARER_HEADER_PATTERN, 'Bearer [REDACTED_BEARER]')
    .replace(TELEGRAM_BOT_TOKEN_PATTERN, '[REDACTED_TG_TOKEN]')
    .replace(JWT_PATTERN, '[REDACTED_JWT]');
}
