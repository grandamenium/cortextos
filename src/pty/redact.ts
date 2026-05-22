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
 * HuggingFace access-token shape: literal `hf_` prefix followed by 32+
 * alphanumeric characters. Real tokens are 37 chars total (`hf_` + 34
 * char body) but the pattern accepts {32,} as a defensive lower bound
 * matching the canonical gitleaks rule. Origin: 2026-05-06 baseline
 * gitleaks drift caught 27 hf_ token instances persisted to boss agent
 * logs (1 inbound-messages.jsonl + 26 stdout.log) — scrubbed in-place
 * via sed; this closes the hole at the source so future leaks redact at
 * the PTY layer instead of needing another scrub pass.
 */
const HF_TOKEN_PATTERN = /hf_[A-Za-z0-9]{32,}/g;

/**
 * Redact secret-shaped tokens from a PTY output chunk.
 *
 * Replaces each match with a literal `[REDACTED_*]` marker in-place:
 *   - JWT-shaped tokens → `[REDACTED_JWT]`
 *   - HuggingFace `hf_*` tokens → `[REDACTED_HF_TOKEN]`
 *
 * Non-token content (TUI ANSI escapes, regular stdout, shell prompts,
 * etc.) passes through unchanged. Safe to call on every PTY chunk — the
 * regexes are stateless and scale linearly with input length.
 */
export function redactSecrets(data: string): string {
  return data
    .replace(JWT_PATTERN, '[REDACTED_JWT]')
    .replace(HF_TOKEN_PATTERN, '[REDACTED_HF_TOKEN]');
}
