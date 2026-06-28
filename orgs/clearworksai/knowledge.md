# Organization Knowledge Base

Shared facts, context, and institutional knowledge for all agents in this org. Read on every session start. Update when you learn something that all agents should know.

## Business

**ClearWorks AI** — an AI Operations and Consulting company run by Josh Weiss.

**Official LLC name:** Clearworks.AI LLC — Entity No. B20260246278, formed 06/19/2026, CA Active
**Registered address:** 849 N Avenue 63, Lower Level, Los Angeles, CA 90042
**CEO / Manager / Registered Agent:** Joshua Shawn Weiss (self-registered)
**Type of business (Clearworks.AI LLC):** AI + Digital Operations Consulting
**Official business phone (Google Voice):** (213) 222-6625
**Source:** CA SOS Certificate of Status + SOI LLC-12 filings (2026-06-19), Google Drive Operations folder

Current focus areas:
- **AuditOS** — audit app, primary engineering push right now
- **ClearPath Academy** — course/training product, launching soon
- **Marketing campaign launch** — top-of-funnel for the consulting arm
- **Client delivery model** — still being designed; open question

Stage: pre-launch / actively shipping product.

## Team

- **Josh Weiss** — founder, operator, primary human in the loop
- Core human team: TBD (fill in as agents learn)
- AI agent fleet (Clearworks-wide, not all inside this cortextOS instance yet):
  FRANK (CoS), HUNTER (sales), COMPASS (client ops), SENTINEL (ops/legal/finance),
  MUSE (content), MAVEN (personal), LARRY (engineering), SRE (security/perf).
  Each has its own Telegram bot. Content is owned by MUSE — do not draft LinkedIn/newsletter directly.

## Technical

Apps and repos (all at `clearworks-ai` on GitHub, local at `~/code/`):

| App | Repo | Railway URL |
|-----|------|-------------|
| Clearpath (gold standard) | `clearworks-ai/clearpath` | clearpath-production-c86d.up.railway.app |
| Lifecycle X | `clearworks-ai/lifecycle-killer` | lifecycle-killer-production.up.railway.app |
| Nonprofit Hub | `clearworks-ai/nonprofit-hub` | nonprofit-hub-production.up.railway.app |
| AuditOS | (extraction/audit product — active dev) | — |

> _Zoom Downloader killed/archived 2026-06-08 (Josh request): GitHub repo archived, Railway service torn down._

**Stack (locked):** Node.js + TypeScript strict, Express 5 (REST only), React 18 + Vite + TanStack Query v5, Drizzle ORM + PostgreSQL, Shadcn/ui + Radix + Tailwind (semantic tokens only), express-session + connect-pg-simple.

**LLM:** Anthropic primary (`claude-3-5-sonnet`). OpenAI only for embeddings (`text-embedding-3-small`).

**Hosting:** Railway auto-deploy on push to main. Never create `railway.json`/`railway.toml` in Clearpath — custom healthcheck config blocks all deploys. Deploy via `git push` to main only.

**Non-negotiables:** every query org-scoped, no `any` type, no `console.log` in committed code, no endpoints without org-scoping, every storage method takes `orgId`.

## Key Links

- Clearpath prod: https://clearpath-production-c86d.up.railway.app
- Clearpath repo: https://github.com/clearworks-ai/clearpath
- Knowledge-sync (Obsidian vault): `~/code/knowledge-sync/`
Obsidian vault: `/Users/joshweiss/code/knowledge-sync/wiki/`
Raw vault: `/Users/joshweiss/code/knowledge-sync/raw/`
Outputs vault: `/Users/joshweiss/code/knowledge-sync/outputs/`

## Knowledge Base — Clearpath Intelligence API (authoritative)

**This org does NOT use the cortextOS built-in Chroma/Gemini KB.** The knowledge base IS Clearpath's intelligence stack. Agents must call Clearpath's API for any RAG operation.

**Architecture:**
- **DB:** Supabase Postgres + pgvector (moved off Railway Postgres 2026-03-30)
- **Embeddings:** Gemini `gemini-embedding-exp-03-07`, 3072 dimensions — handles text, images, audio in one model. (The rest of Clearpath still uses OpenAI embeddings for non-multimodal paths; intelligence stack is Gemini.)
- **ORM:** Drizzle over the Supabase connection string, same storage.ts patterns.
- **Auth:** `X-Api-Key` header → resolved to orgId by storage layer → every query org-scoped → cross-org returns 404.

**Base URL: `https://clrpath.ai`** — do NOT use the Railway URL. It 301-redirects to the custom domain and DROPS the `X-Api-Key` header in the redirect, giving a bogus 401. This has burned prior agents repeatedly.

**Env vars (in `orgs/clearworksai/secrets.env`):**
- `CLEARPATH_BASE_URL=https://clrpath.ai`
- `CLEARPATH_API_KEY=cpk_...` (org-scoped to Clearworks.AI Internal)
- `CLEARPATH_ORG_ID=0ce7b73b-9161-47a6-a800-a0c8f15a4ae4`
- `CLEARPATH_USER_ID=53388948`

**Ingest:**
```
POST https://clrpath.ai/api/intelligence/ingest
Headers: X-Api-Key: $CLEARPATH_API_KEY
Body:    { "text": "...", "title": "...", "sourceType": "..." }
   or:    { "url": "...",  "title": "...", "sourceType": "..." }
```
- URL inputs: server fetches the page first.
- Content chunked → each chunk embedded via Gemini (3072-d) → inserted into intelligence table, scoped to the org resolved from the API key.
- Response: chunk count.

**Query:**
```
POST https://clrpath.ai/api/intelligence/ask
Headers: X-Api-Key: $CLEARPATH_API_KEY
Body:    { "query": "...", "orgId": "$CLEARPATH_ORG_ID" }
```
- pgvector cosine similarity, top-k chunks returned as context. Some endpoint variants synthesize an answer via an LLM call.

**Code locations in `~/code/clearpath/server/`:**
- `routes/intelligence/intelligence-extraction.ts`, `intelligence-ask.ts` — ingest / ask endpoints
- `routes/embeddings.ts` — admin + `/api/intelligence/ingest` (media pipeline entry point; accepts text/URL/files incl. images, PDFs, audio, video)
- `storage/embeddings.ts`, `storage/intelligence.ts` — vector ops
- `services/retrieval.ts` — retrieval logic
- `services/embedding.ts`, `services/embedding-pipeline.ts` — Gemini client + chunking + backfill
- `db.ts` — Supabase connection
- `shared/schema.ts` — `intelligenceEmbeddings` Drizzle schema + vector column

**Future:** we will wire this into the cortextOS dashboard as a KB page pointing at the same Supabase/pgvector store. Not built yet.

## Clearpath Org IDs (UUIDs, not slugs)

The Clearpath MCP expects the real DB UUID, not a slug. Unknown UUIDs silently return empty stats (no error) — guessing is unproductive.

- **Clearworks.AI Internal (client)** — use this for intelligence queries
  `0ce7b73b-9161-47a6-a800-a0c8f15a4ae4`
- **Clearworks.AI (reseller)**
  `06b560b6-524d-4b0e-90d4-6059addeb9e8`
- **Holdco Partner Platform**
  `48d14151-a951-4a36-b6f5-0aba059a357e`

Josh's Clearpath user_id: `53388948`

Source: frank-cc memory (`reference_clearpath_org_ids.md`), 2026-04-10.

## Decisions Log

- **2026-03-30** — Stack locked: Clearworks apps use Node + TS strict, Express 5, React 18 + Vite + TanStack Query v5, Drizzle + Postgres, Shadcn + Tailwind semantic tokens only.
- **2026-03-30** — LLM: Anthropic primary, OpenAI embeddings only. Hosting: Railway auto-deploy on push to main.
- **2026-03-30** — MUSE owns all content. Frank / other agents do not draft LinkedIn or newsletter posts directly.
- **2026-03-30** — Todoist is authoritative for tasks, not markdown files. Query the API for status.
- **2026-04-05** — Never create `railway.json`/`railway.toml` in Clearpath. Custom healthcheck config blocks deploys. Deploy via `git push` to main only.
