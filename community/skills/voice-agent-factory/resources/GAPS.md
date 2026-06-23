# Gaps + targeted follow-ups (2026-06-06)

The deep-research verified set left 4 gaps. Two build-critical ones were closed with
direct fetches of canonical docs (single-source — confidence "documented" not
"3-vote verified"; re-confirm at first live key-test).

## CLOSED: Server (webhook) tool schema — the gateway's PRIMARY mechanism

Fetched /docs/eleven-agents/customization/tools/server-tools:

```json
{
  "type": "webhook",
  "name": "string",
  "description": "string",
  "api_schema": {
    "url": "string",
    "method": "GET|POST|PUT|PATCH",
    "path_params_schema": {},
    "query_params_schema": {},
    "request_body_schema": {},
    "request_headers": {}
  }
}
```

- Param binding: value_type "LLM Prompt" = model extracts values from conversation;
  path params as {id} in URL, plus query and body params.
- Body content_type: application/json (default) or x-www-form-urlencoded.
- Auth may be configured via `auth_connection` / `auth_resolved_params` or via
  `request_headers` entries depending on the path chosen (see
  `WebhookToolApiSchemaConfig-Input` in /docs/api-reference/tools/create.md).
- Note: current OpenAPI names the POST/PATCH/PUT body schema `request_body_schema`
  (a `response_body_schema` also exists but is documentation-only — not surfaced
  to the LLM per current docs).
- Auth options: OAuth2 client-credentials, OAuth2 JWT, Basic, Bearer, Custom Headers
  with Secret type for sensitive values. -> voice gateway: Bearer/custom-secret
  header is the fit; secret stored in EL workspace secrets, validated by gateway.
- Tool response can set dynamic variables for later conversation use (mapping schema
  not detailed on page).
- No explicit server-tool timeout documented (MCP's is 30s default/300 max; assume
  similar order — measure at key-test).

## CLOSED: Pricing + concurrency (pricing question context)

Fetched /pricing/agents (list prices; the operator's dashboard is the truth for a given account):

| Plan | Incl. minutes | Extra/min | Concurrent |
|---|---|---|---|
| Free | 15 | $0.080 | 4 |
| Starter | 75 | $0.080 | 6 |
| Creator | 275 | $0.080 | 10 |
| Pro | 1,238 | $0.080 | 20 |
| Scale | 3,738 | $0.080 | 30 |
| Business | 12,375 | $0.080 | 40 |

- Burst: $0.160/min buys up to 3x concurrency.
- LLM cost is PASS-THROUGH on top (varies by model — Sonnet 4.5 will bill at actual).
- Typical usage is 1 concurrent call, conversational minutes — even Starter/Creator
  tiers cover a lot of a single operator talking to the agent.

## STILL OPEN (close at build time / key-test)

1. Web SDK WebSocket event taxonomy + audio handling details — libraries docs were
   mid-rename 404s; re-fetch /docs/eleven-agents/libraries/* when building the page.
2. KB/RAG attachment API exact flow (create-from-url endpoint confirmed to exist;
   non-enterprise limits ~20MB/300k chars adjacent-source only). A v1 build likely
   needs no KB — memory-query server tool covers lookups.
3. Voice settings + turn-taking/interruption config keys; max tools per agent;
   hard latency figures. Measure empirically at first live session.
4. Server-tool call timeout (see above — undocumented on page).
