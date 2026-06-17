# Sources — ElevenLabs Conversational AI research (2026-06-06)

Research snapshot 2026-06-06: 28 sources fetched, quality-rated. "unreliable" below
mostly = 404-drift from the Conversational AI -> ElevenAgents docs rename, not bad
content; canonical replacements listed where resolved.

## Primary (claims survived 3-vote verification)

- https://elevenlabs.io/docs/eleven-agents/customization/llm — LLM catalog, 2MB prompt budget
- https://elevenlabs.io/docs/eleven-agents/customization/personalization/overrides — overrides + SDK shape
- https://elevenlabs.io/blog/claude-sonnet-4-is-now-available-in-conversational-ai — Claude first-party
- https://elevenlabs.io/docs/eleven-agents/best-practices/prompting-guide — model recommendations, tool surface
- https://elevenlabs.io/docs/agents-platform/customization/tools/mcp/security — MCP security + approval UI labels
- https://elevenlabs.io/docs/agents-platform/api-reference/mcp/create — MCP server attach (canonical: /docs/api-reference/mcp/create)
- https://elevenlabs.io/docs/eleven-agents/customization/tools/client-tools — client tool schema + SDK map
- https://elevenlabs.io/docs/api-reference/conversations/get-signed-url — signed URL endpoint
- https://elevenlabs.io/docs/eleven-agents/api-reference/conversations/get-webrtc-token — WebRTC token
- https://elevenlabs.io/docs/api-reference/agents/create — agents create CRUD
- https://elevenlabs.io/docs/api-reference/agents/update — agents update CRUD
- https://elevenlabs.io/docs/eleven-agents/customization/knowledge-base/rag — RAG (claims fetched, partial survival)
- https://elevenlabs.io/docs/api-reference/knowledge-base/create-from-url — KB ingestion endpoint
- https://elevenlabs.io/pricing/agents — pricing page (claims did NOT survive to synthesis — re-check live)
- https://elevenlabs.io/blog/how-do-you-optimize-latency-for-conversational-ai — latency practices

## 404-drift / unreliable at fetch time (re-resolve under /docs/eleven-agents/)

- /docs/agents-platform/customization/tools/server-tools — server-tool schema — resolved in GAPS; re-confirm at key-test because docs drift
- /docs/agents-platform/customization/authentication — auth guide (content corroborated via api-reference)
- /docs/conversational-ai/libraries/web-sockets, /docs/agents-platform/libraries/java-script — SDK/WebSocket events (build-time re-fetch)
- /docs/conversational-ai/guides/llm-cascading, /docs/changelog, /docs/agents-platform/customization/tools
- help.elevenlabs.io concurrency articles (both name-variants)

## Third-party blogs (corroboration only, not load-bearing)

- simbavoice.ai concurrency comparison, deepgram.com production-limits post,
  aividpipeline.com agents guide 2026

## Refuted (excluded from report)

- "Default LLM = GPT-4o/GLM-4.5-Air; Gemini 2.5 Flash Lite for speed" — 1-2 vote.
  Always set the model explicitly.
