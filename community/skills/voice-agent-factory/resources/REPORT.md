# ElevenLabs Conversational AI — Build-Ready Reference (voice agent builds)

Research snapshot generated 2026-06-06 (28 sources fetched, 86 claims extracted,
25 adversarially verified 3-vote, 24 confirmed / 1 refuted, synthesized to 11
findings — all unanimous against primary ElevenLabs docs).
Companion files: SOURCES.md (full source list w/ quality ratings), GAPS.md (open
questions + single-source follow-ups).

NAMING NOTE: ElevenLabs is actively rebranding "Conversational AI" -> "ElevenAgents" /
"Agents Platform". Doc paths under /agents-platform/ are 404ing and re-resolving to
/eleven-agents/ or /api-reference/. Expect URL drift; the config surface is the same.

---

## 1. LLM selection (VERIFIED high)

- Multi-provider catalog, set via "Language Model" dropdown in agent create/edit UI
  (or `conversation_config` in the create API).
- Anthropic first-party: **Claude Sonnet 4.5, Sonnet 4, Haiku 4.5**, 3.7 Sonnet,
  3.5 Sonnet, 3 Haiku. Also Gemini 3/2.5/2.0, GPT-5/4.1/4o families, EL-hosted
  open models (GLM-4.5-Air, Qwen3-30B-A3B, GPT-OSS-120B).
- EL prompting guide recommends Claude Sonnet 4/4.5 for complex multi-step reasoning
  and tool orchestration ("highest accuracy and reasoning capability with excellent
  tool-calling reliability") — supports the Sonnet 4.5 pick for the agent.
- REFUTED (1-2 vote, excluded): "default LLM is GPT-4o/GLM-4.5-Air, Gemini 2.5 Flash
  Lite for speed" — do not rely on any claimed default; set the model explicitly.

## 2. System prompt budget (VERIFIED high)

- **Max system prompt size 2MB — SHARED budget** across agent instructions +
  knowledge-base content + other system-level context.
- KB has separate larger limits (~20MB/300k chars non-enterprise, adjacent-source
  only — see GAPS.md) with RAG for larger sets.
- Build implication: persona prompt + any inlined context must stay well under 2MB;
  prefer KB/RAG or memory-query tools for bulk context.

## 3. Conversation overrides (VERIFIED high)

- Per-conversation replaceable fields: system prompt, first message, language, LLM,
  voice ID, text-only mode, TTS stability/speed/similarity-boost.
- **Disabled by default**; must be enabled PER-FIELD in the agent's Security tab
  before runtime use. Unsupplied enabled overrides fall back to dashboard defaults.
- SDK shape (note nesting — system prompt string lives at agent.prompt.prompt):

```js
Conversation.startSession({
  overrides: {
    agent: { prompt: { prompt, llm }, firstMessage, language },
    tts: { voiceId },
    conversation: { textOnly: true },
  },
})
```

## 4. Tool mechanisms — four kinds (VERIFIED high)

1. **Client tools** — run in the browser. Config: `type: "client"`, `name`
   (case-sensitive), `description`, `expects_response` (bool — whether result feeds
   back into conversation context), `parameters` array of
   `{id, type, value_type: "llm_prompt", description, required}`.
   SDK registration: `clientTools: { toolName: async (parameters) => result }`
   passed to `Conversation.startSession()`.
2. **Server tools (webhook)** — EL calls the gateway's HTTPS endpoint; dynamic
   params; auth via secrets in headers. Exact JSON schema NOT in verified set —
   see GAPS.md. This is the PRIMARY mechanism for the voice gateway.
3. **System tools** — EL-internal (end-call etc.); dedicated docs page.
4. **MCP tools** (live since changelog 2026-04-27):
   - Attach: `POST /v1/convai/mcp-servers`, body nests under `config`:
     required `config.url` (HTTPS only) + `config.name`. Returns
     id/config/metadata/access_info/dependent_agents.
   - Approval policy enum: `auto_approve_all` | `require_approval_all` (DEFAULT) |
     `require_approval_per_tool` (UI: "No Approval" / "Always Ask (Recommended)" /
     "Fine-Grained Tool Approval").
   - `response_timeout_secs`: default 30, max 300.
   - EL disclaims all security responsibility for third-party MCP servers — if a
     cortextOS MCP surface is exposed to EL, the implementer owns its auth + hardening.

## 5. Auth + session flow (VERIFIED high)

- API auth: `xi-api-key` header (marked optional in some OpenAPI specs but is the
  actual mechanism). **Never ships to the browser.**
- Private agents — two server-minted session paths, both keyed on `agent_id`
  (accepts `agent_…` or `seng_…` ids):
  - WebSocket: `GET /v1/convai/conversation/get-signed-url` -> signed URL valid
    ~15 min (older snake_case `get_signed_url` deprecated).
  - WebRTC: `GET /v1/convai/conversation/token` -> `TokenResponseModel {token}`,
    passed to startSession as `conversationToken`.
- Matches the gateway design exactly: gateway mints signed URL/token, browser never sees key.

## 6. Web SDK contract (@elevenlabs/client + React) (VERIFIED high)

- Session start: `Conversation.startSession()` with `overrides` (shape above),
  `clientTools` map of async callbacks, and signed-url/conversationToken for
  private agents.
- Client-tool return values become conversation context when `expects_response`
  is enabled.
- Full WebSocket event taxonomy not in verified set (libraries docs were among the
  404-drift pages) — see GAPS.md; re-fetch /docs/eleven-agents/libraries on build.

## 7. Programmatic agent CRUD (VERIFIED high)

- Create: `POST https://api.elevenlabs.io/v1/convai/agents/create` with
  `xi-api-key` -> `CreateAgentResponseModel` incl. `agent_id`.
- Update endpoint documented at /docs/api-reference/agents/update (sibling
  get/delete implied by the /v1/convai/* CRUD namespace; only create + update
  pages were in the verified/fetched set).

## 8. NOT covered by verified claims — status

- Pricing per tier + concurrency limits: CLOSED by GAPS.md single-source follow-up
  (re-confirm at first live key-test; account dashboard is the truth).
- Server-tool exact webhook JSON schema: CLOSED by GAPS.md (request_body_schema);
  call timeout still unmeasured — measure at key-test.
- KB/RAG attachment API details (create-from-url endpoint exists in source list) — open.
- Voice settings + turn-taking/interruption config keys; max tools per agent;
  latency figures — open.

---

## Capability mapping (plan -> verified config)

| Agent capability | EL mechanism | Status |
|---|---|---|
| Persona | system prompt (2MB shared budget) via agents/create | VERIFIED |
| Brain | Claude Sonnet 4.5 first-party, Language Model dropdown / API | VERIFIED |
| Tap-to-talk browser | @elevenlabs/client startSession + signed URL | VERIFIED |
| Key isolation | server-minted get-signed-url / token, xi-api-key server-side | VERIFIED |
| Bus actions (status/memory/task/message) | server tools -> the gateway | mechanism verified, exact schema GAP |
| Mid-call UI actions (if any) | client tools map | VERIFIED |
| Bulk context | KB + RAG (separate limits) | partial — attachment API GAP |
| Per-session tuning | overrides (enable per-field in Security tab first) | VERIFIED |
| Future MCP path | POST /v1/convai/mcp-servers, require_approval_all default | VERIFIED |

Remaining build-time / key-test checks: WebSocket event taxonomy + audio handling,
KB/RAG attachment flow (if used), voice settings / turn-taking / max-tools / latency
figures, and server-tool call-timeout measurement. Server-tool schema and
pricing/concurrency are CLOSED in GAPS.md — re-confirm at key-test (docs drift;
the account dashboard beats public pricing pages).
