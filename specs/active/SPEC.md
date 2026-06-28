# Private Briefs Endpoint ("briefs") — 2026-06-03 (rev 2)

**Status**: DRAFT_SPEC
**Requested by**: frank2 (msg 1780515875490-frank2-3j7k6), for Josh's Telegram brief links
**Task**: task_1780515910651_68706590
**Repo**: `~/code/briefs` — NEW standalone repo (`clearworks-ai/briefs`, private). Larry will `git init` + push skeleton (README only) before dispatch; Codexer creates all source files listed below on branch `feature/briefs-v1` off `main`.
**Deploy target**: NEW Railway service `briefs` (Larry provisions service + volume + env vars post-review; deploy needs Josh approval per standing rules)

## Josh's Exact Request (via frank2, verbatim)

> "Need a private briefs endpoint on Railway. Spec: tiny Node/Express service (or add route to Clearpath). frank2 POSTs brief HTML with a secret API key → stored (flat files or PG). frank2 GET retrieves via a token-gated URL: /briefs/:id?token=SECRET. Josh opens the link Telegram sends — sees the brief, no login. No public indexing. Build as minimal as possible."

Architecture decision (Larry): **standalone service, NOT a Clearpath route.** Clearpath is the client-facing gold-standard product; internal ops briefs do not belong in its codebase, deploy cadence, or DB. Storage: **flat files on a Railway volume** (no PG — minimal as requested).

## What to build

Tiny Express 5 + TypeScript (strict) service. Exactly 5 route behaviors, no UI, no DB, no sessions.

### Files Codexer creates (complete list — nothing else)

| File | Purpose |
|------|---------|
| `package.json` | runtime deps: `express` ONLY. devDeps: `typescript`, `@types/express`, `@types/node`. Scripts — `build`: `tsc`; `start`: `node dist/src/server.js`; `test`: `npm run build && node --test --test-reporter=tap dist/tests/` |
| `tsconfig.json` | strict: true, rootDir `.`, outDir `dist`, include `src` + `tests` (so tests compile to `dist/tests/*.test.js`) |
| `src/server.ts` | env validation + app + listen (PORT env, default 3000) |
| `src/briefs.ts` | storage + route handlers |
| `tests/briefs.test.ts` | node:test integration tests via built-in `fetch` against an ephemeral server on a random port with `BRIEFS_DATA_DIR` set to a fresh temp dir |
| `.gitignore` | node_modules, dist, data/ |
| `README.md` | env vars + curl examples |

### Environment variables

| Var | Meaning |
|-----|---------|
| `BRIEFS_API_KEY` | write-auth secret. REQUIRED: if unset or empty, the process prints a clear message to stderr and **exits with code 1 at boot** (before listening). No default value, ever. |
| `BRIEFS_DATA_DIR` | storage dir (default `./data`, created with `mkdir -p` semantics at boot; Railway volume mount `/data`) |
| `PUBLIC_BASE_URL` | used to build returned URLs, e.g. `https://briefs-production.up.railway.app` (default `http://localhost:3000`) |
| `PORT` | listen port (default 3000) |

### Routes (exhaustive)

1. **`POST /briefs`** — auth: `Authorization: Bearer ${BRIEFS_API_KEY}` (constant-time compare via `crypto.timingSafeEqual` on sha256 hashes of presented vs configured key). Body: JSON `{ html: string, title?: string }` parsed with `express.json({ limit: '2mb' })` — an oversized body yields Express's **413**. Validation: `html` must be a non-empty string, else 400. On success: `id` = exactly **16 chars** base64url from `crypto.randomBytes(12)`, `token` = exactly **32 hex chars** from `crypto.randomBytes(16)`. Write `${BRIEFS_DATA_DIR}/${id}.html` (the HTML verbatim) and `${BRIEFS_DATA_DIR}/${id}.json` (`{ id, tokenHash: sha256hex(token), title, createdAt }`) — **the raw token is never written to disk**. Respond 201 `{ id, url: "${PUBLIC_BASE_URL}/briefs/${id}?token=${token}" }`. Missing/wrong key → 401 `{ error: "unauthorized" }`.
2. **`GET /briefs/:id`** — `id` must match `^[A-Za-z0-9_-]{16}$` (path-traversal guard) else 404. Read meta; compare `sha256hex(req.query.token)` to stored `tokenHash` via `timingSafeEqual`. Any failure (bad id format, missing file, missing/wrong/non-string token) → **404** (never 401/403 — don't confirm existence). Success → 200, `Content-Type: text/html; charset=utf-8`, headers `X-Robots-Tag: noindex, nofollow, noarchive`, `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`.
3. **`GET /robots.txt`** → 200 text/plain: `User-agent: *\nDisallow: /`.
4. **`GET /healthz`** → 200 `{ ok: true }`.
5. Anything else → 404.

### Required test cases (minimum — ALL must exist in `tests/briefs.test.ts`; AC-1 asserts ≥9 passing)

1. POST happy path → 201; response `id` length 16; `url` contains a 32-hex-char token
2. POST with no Authorization header → 401
3. POST with wrong key → 401
4. POST with missing/empty `html` → 400
5. GET happy path → 200, body byte-identical to posted HTML, `X-Robots-Tag` header contains `noindex`
6. GET with wrong token → 404
7. GET with path-traversal id (`..%2F..%2Fetc%2Fpasswd`) → 404
8. GET `/robots.txt` → 200 containing `Disallow: /`
9. GET `/healthz` → 200 `{ ok: true }`

### Constraints

- No `any` types. No `console.log` — one structured request log line per request to stdout via a small helper: `method path-without-querystring status` (the token must NEVER appear in logs or on-disk metadata; log `req.path`, never `req.url` / `req.originalUrl`).
- No PII/secret in error responses.
- No list/delete endpoints in v1. No TTL/cleanup in v1 (volume; briefs are small).
- **Zero runtime deps beyond `express`** (enforced by AC-7). No rate limiter, no helmet — headers set manually as specified.
- Write meta JSON before responding; both files written with `fs.promises.writeFile`.

### Numerical commitments (each mapped to an AC)

| Commitment | AC |
|---|---|
| ≥9 required tests pass, 0 fail | AC-1 |
| `id` exactly 16 chars; token exactly 32 hex chars | AC-2 |
| 401 on missing/wrong key; 404 on wrong/missing token + traversal | AC-3 |
| Raw token appears in 0 log lines and 0 stored files | AC-4 |
| 2mb body limit: >2mb → 413, ~1.5mb → 201 | AC-5 |
| Boot exits non-zero when BRIEFS_API_KEY unset | AC-6 |
| Exactly 1 runtime dep (`express`) | AC-7 |
| Live roundtrip + noindex/no-store headers + wrong-token 404 + robots.txt | AC-8 |
| Brief survives an actual `railway redeploy` (volume persistence) | AC-9 |

## Out of scope (do not build)

Clearpath changes · PG · auth UI · brief listing · TTL/cleanup · Telegram sending (frank2 owns that) · Railway config files (`railway.json`/`railway.toml` are forbidden).

## Pipeline after build

Codexer pushes `feature/briefs-v1` → Larry adversarial review (scope match vs this file, no `any`, no `console.log`, token-leak check) → Larry provisions Railway service `briefs` + volume `/data` + env vars, deploys the branch → runs staging ACs 8–9 → PR → Josh approves merge.
