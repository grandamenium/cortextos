# opencode-usage

Read OpenCode Go (Zen) subscription usage — rolling / weekly / monthly quota — for agents
running on the `opencode-go` provider, so the fleet can see remaining Go limits *before*
hitting a `GoUsageLimitError` mid-run.

## Why this exists

OpenCode Go exposes a **live usage API**. The canonical endpoint `GET /zen/go/v1/usage`
(Bearer-auth) is deployed — [anomalyco/opencode#16513](https://github.com/anomalyco/opencode/pull/16513)
merged **2026-08-11** — and returns rolling / weekly / monthly windows:

```json
{ "usage": {
  "rolling": { "status": "ok", "percent": 52, "resetsAt": "2026-09-23T00:34:52.704Z" },
  "weekly":  { "status": "ok", "percent": 20, "resetsAt": "2026-09-28T00:00:00.000Z" },
  "monthly": { "status": "ok", "percent": 61, "resetsAt": "2026-09-25T14:30:41.000Z" }
} }
```

`opencode stats` only reports **local session token cost**, not subscription quota, so this
script fills that gap. It is **API-first**: it calls the Bearer endpoint and parses both the
merged shape above and the earlier proposed `windows[]` shape (back-compat). If the API is
unreachable, it falls back to the community dashboard-cookie scrape (opencode issue
[#18648](https://github.com/anomalyco/opencode/issues/18648)).

## Usage

```bash
node scripts/opencode-usage.mjs                     # human table (matches the intended `opencode usage` UX)
node scripts/opencode-usage.mjs --json              # structured JSON envelope
node scripts/opencode-usage.mjs --store <ctxRoot>   # also write the envelope to <ctxRoot>/state/usage/
node scripts/opencode-usage.mjs --key sk-...        # explicit key
node scripts/opencode-usage.mjs --workspace wrk_... # workspace id (fallback path only)
```

Zero runtime dependencies (Node >= 18 global `fetch`). Cross-platform.

### Key resolution (first hit wins)

1. `--key <k>`
2. `$OPENCODE_GO_API_KEY`
3. `$OPENCODE_API_KEY`
4. `~/.local/share/opencode/auth.json` → `opencode-go.key` (where opencode stores it)
   - override the path with `$OPENCODE_AUTH_PATH`

### Fallback (dashboard scrape, only when the API is unreachable)

Needs a browser session cookie and workspace id:

- `$OPENCODE_AUTH_COOKIE` — the `auth` cookie from opencode.ai (DevTools → Application →
  Cookies → opencode.ai). Session cookies expire, so this is a stopgap.
- `$OPENCODE_WORKSPACE_ID` or `--workspace`.

## JSON envelope (for the usage-monitor)

From the live (merged #16513) primary shape, the envelope carries `resetsAt` and leaves the
dollar/second fields null (the API reports only status + percent + resetsAt):

```json
{
  "source": "opencode-go",
  "method": "bearer-api",
  "plan": null,
  "useBalance": null,
  "balance": null,
  "windows": [
    { "name": "rolling", "status": "ok", "usagePercent": 52, "used": null, "limit": null, "resetInSec": null, "resetsAt": "2026-09-23T00:34:52.704Z" }
  ],
  "endpoint": "https://opencode.ai/zen/go/v1/usage",
  "fetched_at": "2026-09-22T09:00:00.000Z"
}
```

The raw upstream body it parses is `{ "usage": { "rolling": {...}, "weekly": {...}, "monthly": {...} } }`
(see the example under "Why this exists"). The legacy `windows[]` body is still parsed too,
in which case `used` / `limit` / `resetInSec` carry through.

`--store <ctxRoot>` writes this to `<ctxRoot>/state/usage/opencode-go-latest.json` plus a
daily `opencode-go-YYYY-MM-DD.jsonl`, mirroring the convention in `src/bus/metrics.ts`
(`storeUsageData`). This is the seam the fleet usage-monitor consumes — no core edits to
`metrics.ts` required.

## Exit codes

| code | meaning |
| --- | --- |
| 0 | usage retrieved (primary or fallback) |
| 2 | no API key resolvable |
| 3 | key rejected (401) |
| 4 | primary API unreachable and no working fallback |

## Tests

`tests/unit/scripts/opencode-usage.test.ts` (vitest) — key resolution, primary 200 parse,
404→fallback→failure, `--store` output, rendering, and CLI exit codes, all with an
injected `fetch` (no network).
