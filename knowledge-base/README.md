# Knowledge Base (mmrag)

Local RAG engine for cortextOS: ChromaDB vector store + pluggable embedding/rerank
providers. The TypeScript bus (`bus kb-query`, `bus kb-ingest`, `bus kb-reindex`,
`bus kb-collections`) shells out to `scripts/mmrag.py`, which runs in its own
Python venv (`knowledge-base/venv/`).

## Providers

| Function | `gemini` (default) | `cohere` |
|---|---|---|
| Text/doc embeddings | gemini-embedding-2-preview | embed-v4.0 (asymmetric input types) |
| Image embeddings | multimodal embed | embed-v4.0 (native image input) |
| Rerank stage | — (off by default) | rerank-v3.5 (on by default) |
| Image description / OCR | gemini-2.5-flash | command-a-vision-07-2025 |
| PDF extraction | gemini-2.5-flash (PDF bytes) | local pypdf text extraction |
| Video/audio transcription | gemini-2.5-flash | not supported — falls back to Gemini if `GEMINI_API_KEY` is set |

API keys are read from the org's `secrets.env` (or the framework `.env`):
`GEMINI_API_KEY` and/or `COHERE_API_KEY`.

## Config reference

`<CTX_ROOT>/orgs/<org>/knowledge-base/config.json`:

```jsonc
{
  // Provider switch: "gemini" (default) | "cohere"
  "embedding_provider": "cohere",

  // --- Gemini provider ---
  "embedding_model": "gemini-embedding-2-preview",
  "gemini_model": "gemini-2.5-flash",

  // --- Cohere provider ---
  "cohere_embed_model": "embed-v4.0",
  "cohere_chat_model": "command-a-03-2025",
  "cohere_vision_model": "command-a-vision-07-2025",

  // Embedding dimensionality.
  // Gemini default: 768. Cohere default: 1024 (Matryoshka: 256/512/1024/1536).
  "embedding_dimensions": 1024,

  // --- Rerank stage (two-stage retrieval) ---
  // Default: enabled when provider=cohere, disabled for gemini.
  // Gemini configs can opt in (requires COHERE_API_KEY).
  "rerank_enabled": true,
  "rerank_model": "rerank-v3.5",
  "rerank_top_n": 5,            // results returned after rerank
  "rerank_candidate_pool": 30,  // vector-recall width fed to the reranker
  "rerank_threshold": 0.1,      // min rerank relevance score (NOT cosine)

  // --- Retrieval (vector-only mode) ---
  "similarity_threshold": 0.5,  // min cosine similarity when rerank is off

  // --- Chunking ---
  "text_chunk_size": 1000,
  "text_chunk_overlap": 200,

  "default_collection": "shared"
}
```

### Threshold semantics

- **Rerank on**: vector recall is unfiltered (wide), and `rerank_threshold` is applied
  to the rerank relevance score. This fixes the false-negative class where a relevant
  document scores below the cosine threshold.
- **Rerank off**: `similarity_threshold` is applied to cosine similarity (legacy behaviour).
  Defaults to 0.5 when the config omits it.
- `--threshold` on the CLI overrides whichever threshold is active.
- **Rerank failure fallback**: if the rerank API call fails mid-query (outage), results fall
  back to cosine ordering filtered by `similarity_threshold` — an explicit `--threshold`
  (which is rerank-scale in rerank mode) is NOT reinterpreted as a cosine threshold.

## Migration: switching providers

Changing `embedding_provider` or `embedding_dimensions` makes existing collections
incompatible (different vector spaces). Queries/ingests against a mismatched collection
fail with an actionable error rather than returning garbage.

To migrate:

```bash
# 1. Update config.json (set embedding_provider, embedding_dimensions, keys in secrets.env)
# 2. Re-embed all collections in place:
cortextos bus kb-reindex --org <org>

# Or a single collection:
cortextos bus kb-reindex --org <org> --collection shared-<org>
```

Reindex reads the stored chunk text + metadata out of ChromaDB and re-embeds it under
the new provider — **no source files are needed**, and expensive media descriptions
(video/audio/image) are preserved as-is. Each collection is rebuilt into a temporary
collection first and swapped on success (rename-first with rollback), so an interrupted
reindex never loses data.

Migration works in both directions (gemini → cohere and cohere → gemini).

**Media-chunk limitation:** image/video/audio chunks are re-embedded from their stored
*text descriptions* only — the raw-media component of the original multimodal embedding
is not reproduced. Text-query retrieval is unaffected (descriptions carry the content);
image-to-image similarity is reduced until the media is re-ingested from source.

**Legacy collections:** collections created before provider tagging are treated as
gemini-embedded. A cohere config refuses to query them (even at matching dimensions)
until they are reindexed.

## A/B comparison

```bash
# Rerank pipeline (default with cohere)
cortextos bus kb-query "agent goals and responsibilities" --org <org>

# Vector-only, same corpus
cortextos bus kb-query "agent goals and responsibilities" --org <org> --no-rerank
```

## Tests

```bash
# Python engine tests (stdlib only, no API keys needed)
cd knowledge-base/scripts && python3 -m unittest test_mmrag -v

# TypeScript wrapper tests
npx vitest run tests/unit/bus/knowledge-base.test.ts
```
