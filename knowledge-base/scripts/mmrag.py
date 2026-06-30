#!/usr/bin/env python3
"""
mmrag - Multimodal RAG Knowledge Base CLI

Ingest videos, images, audio, documents into a local ChromaDB vector database.

Embedding/generation is provider-pluggable via config `embedding_provider`:
  - "gemini" (default): Gemini Embedding 2 + Gemini Flash for media descriptions
  - "cohere": Cohere embed-v4.0 (asymmetric search_document/search_query) +
    Command A Vision for image/OCR descriptions + rerank-v3.5 two-stage retrieval

Usage:
    mmrag.py ingest <path> [<path>...] [--collection NAME]
    mmrag.py query <question> [--top-k N] [--threshold F] [--max-tokens N] [--collection NAME] [--json] [--full] [--no-rerank]
    mmrag.py reindex [--collection NAME] [--json]
    mmrag.py status [--collection NAME]
    mmrag.py list [--collection NAME]
    mmrag.py collections
    mmrag.py delete <path> [--collection NAME]
    mmrag.py reset --confirm
"""

import argparse
import hashlib
import json
import mimetypes
import os
import subprocess
import sys
import time
from pathlib import Path

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
# cortextOS env-var overrides (set by kb-*.sh scripts)
MMRAG_DIR = Path(os.environ.get("MMRAG_DIR", str(Path.home() / ".mmrag")))
CONFIG_FILE = Path(os.environ.get("MMRAG_CONFIG", str(MMRAG_DIR / "config.json")))
CHROMADB_DIR = Path(os.environ.get("MMRAG_CHROMADB_DIR", str(MMRAG_DIR / "chromadb")))
MEDIA_DIR = MMRAG_DIR / "media"
LOG_DIR = MMRAG_DIR / "logs"

VIDEO_EXTS = {".mp4", ".mov", ".avi", ".mkv", ".webm"}
AUDIO_EXTS = {".mp3", ".wav", ".m4a", ".ogg", ".flac"}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp"}
DOC_EXTS = {".pdf", ".docx", ".doc", ".pptx", ".ppt", ".xlsx", ".xls"}
TEXT_EXTS = {".txt", ".md", ".csv", ".json", ".py", ".js", ".ts", ".go",
             ".rs", ".java", ".cpp", ".c", ".sh", ".yaml", ".yml", ".toml",
             ".html", ".css", ".sql", ".rb", ".swift", ".kt", ".r", ".lua"}

# Defaults
DEFAULT_TEXT_CHUNK_SIZE = 1500
DEFAULT_TEXT_CHUNK_OVERLAP = 200
DEFAULT_VIDEO_CHUNK_SECONDS = 60
DEFAULT_VIDEO_OVERLAP_SECONDS = 15
DEFAULT_AUDIO_CHUNK_SECONDS = 60
DEFAULT_AUDIO_OVERLAP_SECONDS = 10
DEFAULT_EMBEDDING_DIMENSIONS = 768
DEFAULT_SIMILARITY_THRESHOLD = 0.0  # return everything by default, let caller filter
DEFAULT_MAX_TOKENS = 0  # 0 = unlimited
DEFAULT_PREVIEW_CHARS = 300

# Embedding/generation providers
PROVIDER_GEMINI = "gemini"
PROVIDER_COHERE = "cohere"

# Cohere API (v2 REST — https://docs.cohere.com)
COHERE_API_BASE = "https://api.cohere.com"
DEFAULT_COHERE_EMBED_MODEL = "embed-v4.0"
DEFAULT_COHERE_EMBED_DIMENSIONS = 1024  # Matryoshka: 256/512/1024/1536
DEFAULT_COHERE_CHAT_MODEL = "command-a-03-2025"
DEFAULT_COHERE_VISION_MODEL = "command-a-vision-07-2025"
COHERE_EMBED_BATCH_SIZE = 96  # max texts per /v2/embed call

# Rerank (two-stage retrieval: vector recall wide → rerank → top-k)
DEFAULT_RERANK_MODEL = "rerank-v3.5"
DEFAULT_RERANK_TOP_N = 5
DEFAULT_RERANK_CANDIDATE_POOL = 30
DEFAULT_RERANK_THRESHOLD = 0.1  # rerank relevance scores have a different scale than cosine

# Pricing (per 1M tokens unless noted)
EMBEDDING_PRICE_PER_M = 0.20
FLASH_INPUT_PRICE_PER_M = 0.15
FLASH_OUTPUT_PRICE_PER_M = 0.60
COHERE_EMBED_PRICE_PER_M = 0.12
COHERE_RERANK_PRICE_PER_1K_SEARCHES = 2.00
COHERE_CHAT_INPUT_PRICE_PER_M = 2.50
COHERE_CHAT_OUTPUT_PRICE_PER_M = 10.00

# Retry classifier for the Gemini generate_content call inside ingest_pdf.
# Module-level so a fault-injection test client can reference the same set.
TRANSIENT_HTTP_CODES = {429, 500, 503}
TRANSIENT_STATUS_NAMES = {"UNAVAILABLE", "RESOURCE_EXHAUSTED"}

USAGE_FILE = MMRAG_DIR / "usage.json"

# ---------------------------------------------------------------------------
# Usage Tracker
# ---------------------------------------------------------------------------
_tracker = None  # module-level, set by cmd_ingest/cmd_query


class UsageTracker:
    def __init__(self, operation="unknown"):
        self.session = {
            "embedding_tokens": 0,
            "embedding_calls": 0,
            "generation_input_tokens": 0,
            "generation_output_tokens": 0,
            "generation_calls": 0,
            # Cohere-specific counters (zero for pure-Gemini sessions)
            "cohere_embedding_tokens": 0,
            "cohere_generation_input_tokens": 0,
            "cohere_generation_output_tokens": 0,
            "rerank_calls": 0,
            "started_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "operation": operation,
        }

    def track_embedding(self, content, provider=PROVIDER_GEMINI, media_bytes_len=0):
        self.session["embedding_calls"] += 1
        tokens = 0
        if isinstance(content, str):
            tokens = int(len(content.split()) * 1.3)
        elif isinstance(content, list):
            for part in content:
                if isinstance(part, str):
                    tokens += int(len(part.split()) * 1.3)
                else:
                    try:
                        tokens += max(256, len(part.data) // 4)
                    except Exception:
                        tokens += 256
        # Raw media payload sent alongside the text (e.g. Cohere image embedding)
        if media_bytes_len:
            tokens += max(256, media_bytes_len // 4)
        self.session["embedding_tokens"] += tokens
        if provider == PROVIDER_COHERE:
            self.session["cohere_embedding_tokens"] += tokens

    def track_generation(self, response):
        self.session["generation_calls"] += 1
        um = getattr(response, "usage_metadata", None)
        if um:
            self.session["generation_input_tokens"] += getattr(um, "prompt_token_count", 0) or 0
            self.session["generation_output_tokens"] += getattr(um, "candidates_token_count", 0) or 0

    def track_cohere_generation(self, response_json):
        """Track a Cohere /v2/chat response (raw JSON dict).

        v2 chat responses report billing under meta.billed_units; usage.billed_units
        is checked as a fallback for forward compatibility.
        """
        self.session["generation_calls"] += 1
        billed = (response_json.get("meta", {}) or {}).get("billed_units", {}) \
            or (response_json.get("usage", {}) or {}).get("billed_units", {}) or {}
        self.session["cohere_generation_input_tokens"] += billed.get("input_tokens", 0) or 0
        self.session["cohere_generation_output_tokens"] += billed.get("output_tokens", 0) or 0

    def track_rerank(self):
        self.session["rerank_calls"] += 1

    def cost(self):
        # Gemini embedding tokens = total minus the Cohere subset
        gemini_emb_tokens = self.session["embedding_tokens"] - self.session["cohere_embedding_tokens"]
        emb = (gemini_emb_tokens / 1_000_000) * EMBEDDING_PRICE_PER_M
        emb += (self.session["cohere_embedding_tokens"] / 1_000_000) * COHERE_EMBED_PRICE_PER_M
        gen_in = (self.session["generation_input_tokens"] / 1_000_000) * FLASH_INPUT_PRICE_PER_M
        gen_in += (self.session["cohere_generation_input_tokens"] / 1_000_000) * COHERE_CHAT_INPUT_PRICE_PER_M
        gen_out = (self.session["generation_output_tokens"] / 1_000_000) * FLASH_OUTPUT_PRICE_PER_M
        gen_out += (self.session["cohere_generation_output_tokens"] / 1_000_000) * COHERE_CHAT_OUTPUT_PRICE_PER_M
        rerank = (self.session["rerank_calls"] / 1_000) * COHERE_RERANK_PRICE_PER_1K_SEARCHES
        return {
            "embedding": round(emb, 6),
            "generation_input": round(gen_in, 6),
            "generation_output": round(gen_out, 6),
            "rerank": round(rerank, 6),
            "total": round(emb + gen_in + gen_out + rerank, 6),
        }

    def persist(self):
        MMRAG_DIR.mkdir(parents=True, exist_ok=True)
        self.session["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        self.session["cost"] = self.cost()

        data = {"cumulative": {}, "sessions": []}
        if USAGE_FILE.exists():
            try:
                with open(USAGE_FILE) as f:
                    data = json.load(f)
            except (json.JSONDecodeError, KeyError):
                data = {"cumulative": {}, "sessions": []}

        data.setdefault("sessions", []).append(self.session)

        c = data.get("cumulative", {})
        for key in ["embedding_tokens", "embedding_calls",
                     "generation_input_tokens", "generation_output_tokens",
                     "generation_calls",
                     "cohere_embedding_tokens", "cohere_generation_input_tokens",
                     "cohere_generation_output_tokens", "rerank_calls"]:
            c[key] = c.get(key, 0) + self.session[key]

        c["total_cost"] = round(sum(
            s.get("cost", {}).get("total", 0) for s in data["sessions"]
        ), 6)
        data["cumulative"] = c

        with open(USAGE_FILE, "w") as f:
            json.dump(data, f, indent=2)

    def summary_line(self):
        c = self.cost()
        line = (f"  Tokens: {self.session['embedding_tokens']:,} embedding, "
                f"{self.session['generation_input_tokens']:,} gen-input, "
                f"{self.session['generation_output_tokens']:,} gen-output")
        if self.session["rerank_calls"]:
            line += f" | Rerank calls: {self.session['rerank_calls']}"
        line += f" | Cost: ${c['total']:.4f}"
        return line


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
def load_config():
    if not CONFIG_FILE.exists():
        print("ERROR: Config not found. Run setup first:")
        print(f"  bash {Path(__file__).parent / 'setup.sh'}")
        sys.exit(1)
    with open(CONFIG_FILE) as f:
        return json.load(f)


def get_provider(config):
    """Active embedding/generation provider for this KB."""
    return config.get("embedding_provider", PROVIDER_GEMINI)


def get_api_key(config):
    """Gemini API key (name kept for backward compatibility with older configs)."""
    key = os.environ.get("GEMINI_API_KEY") or config.get("gemini_api_key")
    if not key:
        print("ERROR: No Gemini API key. Set GEMINI_API_KEY or run setup.")
        sys.exit(1)
    return key


def get_cohere_api_key(config, required=True):
    """Cohere API key from env or config. Exits with a clear error when required."""
    key = os.environ.get("COHERE_API_KEY") or config.get("cohere_api_key")
    if not key and required:
        print("ERROR: No Cohere API key. Set COHERE_API_KEY in .env / orgs/<org>/secrets.env "
              "(required when embedding_provider=cohere or rerank is enabled).")
        sys.exit(1)
    return key


def gemini_key_available(config):
    return bool(os.environ.get("GEMINI_API_KEY") or config.get("gemini_api_key"))


def cohere_key_available(config):
    return bool(os.environ.get("COHERE_API_KEY") or config.get("cohere_api_key"))


def active_embed_model(config):
    """The embedding model ID for the active provider."""
    if get_provider(config) == PROVIDER_COHERE:
        return config.get("cohere_embed_model", DEFAULT_COHERE_EMBED_MODEL)
    return config.get("embedding_model", "gemini-embedding-2-preview")


def active_embed_dimensions(config):
    """The embedding dimensionality for the active provider."""
    if get_provider(config) == PROVIDER_COHERE:
        return config.get("embedding_dimensions", DEFAULT_COHERE_EMBED_DIMENSIONS)
    return config.get("embedding_dimensions", DEFAULT_EMBEDDING_DIMENSIONS)


def is_rerank_enabled(config):
    """Rerank stage on/off.

    Explicit `rerank_enabled` in config wins. Otherwise rerank defaults ON when
    the provider is cohere (it is the headline of the cohere pipeline) and OFF
    for gemini configs (backward compatible — no Cohere key required there).
    """
    explicit = config.get("rerank_enabled")
    if explicit is not None:
        return bool(explicit)
    return get_provider(config) == PROVIDER_COHERE


# ---------------------------------------------------------------------------
# Provider clients
# ---------------------------------------------------------------------------
def _load_factory(dotted_path):
    """Resolve a dotted import path to a callable.

    Accepts 'pkg.mod.attr' or 'pkg.mod:attr'. The colon form is unambiguous when
    the attribute name collides with a submodule name, so it is preferred.
    """
    if ":" in dotted_path:
        module_path, _, attr_path = dotted_path.partition(":")
    else:
        module_path, _, attr_path = dotted_path.rpartition(".")
    if not module_path or not attr_path:
        raise ValueError(
            f"MMRAG_GEMINI_CLIENT_FACTORY {dotted_path!r} must be 'module.attr' or 'module:attr'"
        )
    import importlib
    obj = importlib.import_module(module_path)
    for part in attr_path.split("."):
        obj = getattr(obj, part)
    if not callable(obj):
        raise TypeError(
            f"MMRAG_GEMINI_CLIENT_FACTORY {dotted_path!r} resolved to non-callable {type(obj).__name__}"
        )
    return obj


class Clients:
    """Lazy holder for provider API clients, routed by config embedding_provider."""

    def __init__(self, config):
        self.config = config
        self._genai = None
        self._cohere_key = None

    @property
    def genai(self):
        if self._genai is None:
            # Route through get_genai_client() so the MMRAG_GEMINI_CLIENT_FACTORY
            # injection seam (fault-injection tests, _test_clients/) keeps working.
            # When a factory is injected, don't demand a real GEMINI_API_KEY —
            # fake clients don't need one (the factory receives whatever is set).
            if os.environ.get("MMRAG_GEMINI_CLIENT_FACTORY"):
                self._genai = get_genai_client(
                    os.environ.get("GEMINI_API_KEY") or self.config.get("gemini_api_key") or "factory-injected")
            else:
                self._genai = get_genai_client(get_api_key(self.config))
        return self._genai

    @property
    def cohere_key(self):
        if self._cohere_key is None:
            self._cohere_key = get_cohere_api_key(self.config)
        return self._cohere_key


def get_genai_client(api_key):
    """Construct a Gemini client.

    Default returns google.genai.Client(api_key=api_key) — byte-identical to
    the prior behavior. To inject a fake client (e.g. for testing the retry
    loop in ingest_pdf), set the env-var MMRAG_GEMINI_CLIENT_FACTORY to a
    dotted import path of a callable taking (api_key) and returning an object
    with .models.generate_content / .models.embed_content compatible shape.
    See knowledge-base/scripts/_test_clients/fault_injection.py for a reference.
    """
    factory_path = os.environ.get("MMRAG_GEMINI_CLIENT_FACTORY")
    if factory_path:
        return _load_factory(factory_path)(api_key)
    from google import genai
    return genai.Client(api_key=api_key)


def _retry_generate_content(client, *, model, contents, backoffs=(5, 15, 45)):
    """Call client.models.generate_content with bounded retries on transient APIErrors.

    Retries on HTTP code in TRANSIENT_HTTP_CODES or status name in
    TRANSIENT_STATUS_NAMES; re-raises immediately on any other APIError (auth,
    malformed request, etc.); re-raises last_err after all attempts exhausted.

    backoffs is a tuple of sleep seconds between attempts. len(backoffs) is the
    attempt count. Tests pass (0, 0, 0) to skip sleeps.
    """
    from google.genai import errors as _genai_errors
    last_err = None
    for attempt, backoff in enumerate(backoffs, start=1):
        try:
            return client.models.generate_content(model=model, contents=contents)
        except _genai_errors.APIError as e:
            last_err = e
            is_transient = (e.code in TRANSIENT_HTTP_CODES) or (e.status in TRANSIENT_STATUS_NAMES)
            if not is_transient:
                raise
            if attempt < len(backoffs):
                print(f"    Transient error (HTTP {e.code} {e.status or ''}); retrying in {backoff}s (attempt {attempt}/{len(backoffs)})")
                time.sleep(backoff)
            else:
                print(f"    Exhausted retries on transient error: HTTP {e.code} {e.status or ''}")
    raise last_err if last_err else RuntimeError("retry loop completed without response or error")



# ---------------------------------------------------------------------------
# Cohere REST (v2) — stdlib urllib, no extra dependency
# ---------------------------------------------------------------------------
def _cohere_post(api_key, path, payload, timeout=60, retries=3):
    """POST to the Cohere v2 API with retry on rate-limit/transient errors."""
    import urllib.request
    import urllib.error

    last_err = None
    for attempt in range(retries):
        req = urllib.request.Request(
            f"{COHERE_API_BASE}{path}",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"bearer {api_key}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                body = resp.read().decode("utf-8")
                try:
                    return json.loads(body)
                except json.JSONDecodeError as e:
                    # Non-JSON 200 body (e.g. proxy/CDN error page) — surface as a
                    # RuntimeError so callers' fallback handling applies.
                    raise RuntimeError(
                        f"Cohere API {path} returned non-JSON response: {body[:200]}"
                    ) from e
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")
            last_err = RuntimeError(f"Cohere API {path} failed ({e.code}): {body[:500]}")
            if e.code in (429, 500, 502, 503, 504) and attempt < retries - 1:
                time.sleep(2 ** attempt)
                continue
            raise last_err from e
        except urllib.error.URLError as e:
            last_err = RuntimeError(f"Cohere API {path} unreachable: {e.reason}")
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
                continue
            raise last_err from e
    raise last_err


def cohere_embed_texts(clients, config, texts, input_type="search_document"):
    """Embed text strings with Cohere embed-v4.0. Returns list of float vectors.

    input_type is the asymmetric-embedding lever: "search_document" at ingest,
    "search_query" at query time.
    """
    model = config.get("cohere_embed_model", DEFAULT_COHERE_EMBED_MODEL)
    dims = config.get("embedding_dimensions", DEFAULT_COHERE_EMBED_DIMENSIONS)
    all_embeddings = []
    for i in range(0, len(texts), COHERE_EMBED_BATCH_SIZE):
        batch = texts[i:i + COHERE_EMBED_BATCH_SIZE]
        resp = _cohere_post(clients.cohere_key, "/v2/embed", {
            "model": model,
            "input_type": input_type,
            "embedding_types": ["float"],
            "output_dimension": dims,
            "texts": batch,
        })
        try:
            all_embeddings.extend(resp["embeddings"]["float"])
        except (KeyError, TypeError) as e:
            raise RuntimeError(f"Unexpected Cohere embed response shape: {str(resp)[:200]}") from e
        if _tracker:
            for t in batch:
                _tracker.track_embedding(t, provider=PROVIDER_COHERE)
    return all_embeddings


def cohere_embed_image(clients, config, description_text, media_bytes, mime_type):
    """Embed an image (plus its text description) with Cohere embed-v4.0 image input."""
    import base64
    model = config.get("cohere_embed_model", DEFAULT_COHERE_EMBED_MODEL)
    dims = config.get("embedding_dimensions", DEFAULT_COHERE_EMBED_DIMENSIONS)
    data_url = f"data:{mime_type};base64,{base64.b64encode(media_bytes).decode('utf-8')}"
    content = []
    if description_text:
        content.append({"type": "text", "text": description_text})
    content.append({"type": "image_url", "image_url": {"url": data_url}})
    resp = _cohere_post(clients.cohere_key, "/v2/embed", {
        "model": model,
        "input_type": "search_document",
        "embedding_types": ["float"],
        "output_dimension": dims,
        "inputs": [{"content": content}],
    })
    if _tracker:
        _tracker.track_embedding(description_text or "", provider=PROVIDER_COHERE,
                                 media_bytes_len=len(media_bytes))
    try:
        return resp["embeddings"]["float"][0]
    except (KeyError, IndexError, TypeError) as e:
        raise RuntimeError(f"Unexpected Cohere embed response shape: {str(resp)[:200]}") from e


def cohere_chat_text(clients, config, prompt, image_data_url=None, vision=False):
    """Call Cohere /v2/chat (Command A / Command A Vision). Returns response text."""
    model = config.get("cohere_vision_model", DEFAULT_COHERE_VISION_MODEL) if vision \
        else config.get("cohere_chat_model", DEFAULT_COHERE_CHAT_MODEL)
    if image_data_url:
        content = [
            {"type": "image_url", "image_url": {"url": image_data_url}},
            {"type": "text", "text": prompt},
        ]
    else:
        content = prompt
    resp = _cohere_post(clients.cohere_key, "/v2/chat", {
        "model": model,
        "messages": [{"role": "user", "content": content}],
    }, timeout=120)
    if _tracker:
        _tracker.track_cohere_generation(resp)
    parts = (resp.get("message", {}) or {}).get("content", []) or []
    text = "".join(p.get("text", "") for p in parts if p.get("type") == "text")
    if not text.strip():
        raise RuntimeError(f"Cohere chat ({model}) returned an empty response")
    return text


def cohere_rerank(clients, config, query, documents, top_n):
    """Call Cohere /v2/rerank. Returns list of {index, relevance_score} dicts."""
    model = config.get("rerank_model", DEFAULT_RERANK_MODEL)
    resp = _cohere_post(clients.cohere_key, "/v2/rerank", {
        "model": model,
        "query": query,
        "documents": documents,
        "top_n": min(top_n, len(documents)),
    })
    if _tracker:
        _tracker.track_rerank()
    return resp.get("results", [])


# ---------------------------------------------------------------------------
# Provider-routed embedding + description
# ---------------------------------------------------------------------------
def embed_content(client, config, content, task_type="RETRIEVAL_DOCUMENT"):
    """Embed content via the configured provider.

    content: text string (any provider) or list of Gemini Parts (gemini provider
    only — passing non-string content with provider=cohere raises RuntimeError).
    task_type uses Gemini naming; mapped to Cohere input_type for cohere.
    """
    if get_provider(config) == PROVIDER_COHERE:
        if not isinstance(content, str):
            # Never silently fall through to Gemini — mixed-provider vectors in
            # one collection are not comparable. Media goes via embed_multimodal.
            raise RuntimeError(
                "embed_content with provider=cohere only accepts text strings; "
                "use embed_multimodal for media content"
            )
        input_type = "search_query" if task_type == "RETRIEVAL_QUERY" else "search_document"
        return cohere_embed_texts(client, config, [content], input_type)[0]

    # Gemini path (default)
    from google.genai import types
    result = client.genai.models.embed_content(
        model=config.get("embedding_model", "gemini-embedding-2-preview"),
        contents=content,
        config=types.EmbedContentConfig(
            output_dimensionality=config.get("embedding_dimensions", DEFAULT_EMBEDDING_DIMENSIONS),
            task_type=task_type,
        ),
    )
    if _tracker:
        _tracker.track_embedding(content)
    return result.embeddings[0].values


def embed_texts_batch(client, config, texts, task_type="RETRIEVAL_DOCUMENT"):
    """Embed many texts efficiently (batched for cohere, sequential for gemini)."""
    if get_provider(config) == PROVIDER_COHERE:
        input_type = "search_query" if task_type == "RETRIEVAL_QUERY" else "search_document"
        return cohere_embed_texts(client, config, texts, input_type)
    return [embed_content(client, config, t, task_type) for t in texts]


def embed_multimodal(client, config, description_text, media_bytes, mime_type):
    """
    Option B embedding: combine text description + raw media into one embedding.
    This captures both semantic text meaning AND visual/audio content.

    Cohere: images embed natively (data URL); audio/video bytes are not supported,
    so those fall back to embedding the text description only.
    """
    if get_provider(config) == PROVIDER_COHERE:
        if mime_type and mime_type.startswith("image/"):
            return cohere_embed_image(client, config, description_text, media_bytes, mime_type)
        # No Cohere audio/video embedding — the description text carries the content
        return embed_content(client, config, description_text)

    from google.genai import types
    contents = [
        description_text,
        types.Part.from_bytes(data=media_bytes, mime_type=mime_type),
    ]
    return embed_content(client, config, contents)


def embed_query(client, config, query_text):
    """Embed a query string for retrieval."""
    return embed_content(client, config, query_text, task_type="RETRIEVAL_QUERY")


MEDIA_DESCRIBE_PROMPTS = {
    "video": (
        "Provide a detailed description of this video. Include:\n"
        "1. What is being shown/demonstrated\n"
        "2. Any text visible on screen\n"
        "3. Key concepts or topics discussed\n"
        "4. A transcript of any spoken words\n"
        "5. Step-by-step actions if it's a tutorial\n"
        "Be thorough - this description will be used for search and retrieval."
    ),
    "image": (
        "Describe this image in detail. Include:\n"
        "1. What is shown in the image\n"
        "2. Any text visible in the image\n"
        "3. Key concepts or topics depicted\n"
        "4. Colors, layout, and composition\n"
        "Be thorough - this description will be used for search and retrieval."
    ),
    "audio": (
        "Transcribe and describe this audio. Include:\n"
        "1. A full transcript of spoken words\n"
        "2. Description of any sounds or music\n"
        "3. Key topics discussed\n"
        "4. Speaker identification if possible\n"
        "Be thorough - this description will be used for search and retrieval."
    ),
}


def gemini_describe_media(client, config, file_path, media_type="video"):
    """Use Gemini Flash to generate a text description of media."""
    from google.genai import types

    mime = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
    with open(file_path, "rb") as f:
        data = f.read()

    response = client.genai.models.generate_content(
        model=config.get("gemini_model", "gemini-2.5-flash"),
        contents=[
            types.Part.from_bytes(data=data, mime_type=mime),
            MEDIA_DESCRIBE_PROMPTS.get(media_type, MEDIA_DESCRIBE_PROMPTS["video"]),
        ],
    )
    if _tracker:
        _tracker.track_generation(response)
    return response.text, data, mime


def cohere_describe_image(client, config, file_path):
    """Use Cohere Command A Vision to generate a text description of an image."""
    import base64
    mime = mimetypes.guess_type(str(file_path))[0] or "image/png"
    with open(file_path, "rb") as f:
        data = f.read()
    data_url = f"data:{mime};base64,{base64.b64encode(data).decode('utf-8')}"
    text = cohere_chat_text(client, config, MEDIA_DESCRIBE_PROMPTS["image"],
                            image_data_url=data_url, vision=True)
    return text, data, mime


def describe_media(client, config, file_path, media_type="video"):
    """Generate a text description of media via the configured provider.

    Cohere covers images (Command A Vision). Video/audio transcription has no
    Cohere equivalent — falls back to Gemini when a key is available, otherwise
    raises so the caller can degrade gracefully.
    """
    if get_provider(config) == PROVIDER_COHERE:
        if media_type == "image":
            return cohere_describe_image(client, config, file_path)
        if gemini_key_available(config):
            print(f"    [cohere] No Cohere model for {media_type} — falling back to Gemini")
            return gemini_describe_media(client, config, file_path, media_type)
        raise RuntimeError(
            f"Cannot describe {media_type} with provider=cohere and no GEMINI_API_KEY fallback. "
            f"Set GEMINI_API_KEY in secrets.env to ingest video/audio."
        )
    return gemini_describe_media(client, config, file_path, media_type)

# ---------------------------------------------------------------------------
# ChromaDB
# ---------------------------------------------------------------------------
def collection_metadata_for(config):
    """Collection metadata tagging which provider/model/dims the vectors use."""
    return {
        "hnsw:space": "cosine",
        "embedding_provider": get_provider(config),
        "embedding_model": active_embed_model(config),
        "embedding_dimensions": active_embed_dimensions(config),
    }


def get_chroma_collection(collection_name="default", config=None):
    import chromadb
    client = chromadb.PersistentClient(path=str(CHROMADB_DIR))

    # Self-heal an interrupted reindex swap at the ACCESS layer: if the named
    # collection vanished mid-swap but its __pre_reindex copy survives, restore
    # the copy instead of letting get_or_create silently create a fresh EMPTY
    # collection on top of it — that would strand the orphaned data and make
    # the kb-reindex self-heal path unreachable.
    existing = {c.name if hasattr(c, "name") else c for c in client.list_collections()}
    orphan_name = f"{collection_name}{REINDEX_OLD_SUFFIX}"
    if collection_name not in existing and orphan_name in existing:
        client.get_collection(orphan_name).modify(name=collection_name)

    metadata = collection_metadata_for(config) if config else {"hnsw:space": "cosine"}
    collection = client.get_or_create_collection(
        name=collection_name,
        metadata=metadata,
    )
    # ChromaDB never updates metadata on get_or_create. An EMPTY collection whose
    # stored metadata disagrees with the active provider config would otherwise be
    # a trap: ingest is blocked by the compat check, but reindex skips empty
    # collections — unrecoverable without a reset. Recreate it with fresh metadata.
    if config and collection.count() == 0:
        stored = collection.metadata or {}
        wanted = collection_metadata_for(config)
        if any(stored.get(k) != v for k, v in wanted.items() if k != "hnsw:space"):
            client.delete_collection(collection_name)
            collection = client.create_collection(name=collection_name, metadata=wanted)
    return collection


def get_chroma_client():
    import chromadb
    return chromadb.PersistentClient(path=str(CHROMADB_DIR))


def check_collection_compat(collection, config):
    """Detect provider/dimension mismatch between a collection and the active config.

    Without this, switching embedding_provider against an existing collection
    produces a cryptic ChromaDB dimension error (or silent garbage results).
    Returns None when compatible, otherwise an actionable error string.
    """
    if collection.count() == 0:
        return None

    cfg_provider = get_provider(config)
    cfg_dims = active_embed_dimensions(config)
    cfg_model = active_embed_model(config)
    meta = collection.metadata or {}
    col_provider = meta.get("embedding_provider")
    col_dims = meta.get("embedding_dimensions")
    col_model = meta.get("embedding_model")

    # Collections created before provider tagging were embedded with Gemini
    # (the only provider that existed). When the active provider is non-gemini,
    # they MUST be reindexed — even matching dimensions would be a different,
    # incomparable vector space.
    if col_provider is None and cfg_provider != PROVIDER_GEMINI:
        return (
            f"Collection '{collection.name}' predates provider tagging (embedded with gemini) "
            f"but embedding_provider is now '{cfg_provider}'. "
            f"Run: cortextos bus kb-reindex to migrate it."
        )

    # Untagged + gemini config: probe one stored embedding to catch dimension changes
    if col_provider is None:
        try:
            sample = collection.get(limit=1, include=["embeddings"])
            embeddings = sample.get("embeddings")
            if embeddings is not None and len(embeddings) > 0:
                col_dims = len(embeddings[0])
        except Exception:
            return None  # can't probe — let the query attempt proceed

    if col_provider and col_provider != cfg_provider:
        return (
            f"Collection '{collection.name}' was embedded with provider '{col_provider}' "
            f"but embedding_provider is now '{cfg_provider}'. "
            f"Run: cortextos bus kb-reindex to migrate it."
        )
    if col_dims and int(col_dims) != int(cfg_dims):
        return (
            f"Collection '{collection.name}' has {col_dims}-dimension embeddings "
            f"but the config expects {cfg_dims}. "
            f"Run: cortextos bus kb-reindex to migrate it."
        )
    # Same provider + same dims but a different model is still a different vector space
    if col_model and col_model != cfg_model:
        return (
            f"Collection '{collection.name}' was embedded with model '{col_model}' "
            f"but the config now uses '{cfg_model}'. "
            f"Run: cortextos bus kb-reindex to migrate it."
        )
    return None

# ---------------------------------------------------------------------------
# Text chunking
# ---------------------------------------------------------------------------
def _markdown_sections(text):
    """Split markdown into (heading_path, body) sections.

    heading_path is the breadcrumb of headings above the section, e.g.
    "Knowledge Base (RAG) > Query". Body text before any heading gets path "".
    Heading lines stay part of their section body.
    """
    import re
    sections = []
    heading_stack = []  # list of (level, title)
    current_lines = []

    def flush():
        body = "\n".join(current_lines).strip()
        if body:
            path = " > ".join(t for _, t in heading_stack)
            sections.append((path, body))
        current_lines.clear()

    in_code_fence = False
    for line in text.split("\n"):
        # Lines inside fenced code blocks are never headings (bash/python comments
        # at column 0 would otherwise match the heading regex)
        if line.lstrip().startswith("```"):
            in_code_fence = not in_code_fence
            current_lines.append(line)
            continue
        m = None if in_code_fence else re.match(r'^(#{1,6})\s+(.+)$', line)
        if m:
            flush()
            level = len(m.group(1))
            while heading_stack and heading_stack[-1][0] >= level:
                heading_stack.pop()
            heading_stack.append((level, m.group(2).strip()))
            current_lines.append(line)
        else:
            current_lines.append(line)
    flush()
    return sections


def chunk_markdown(text, filename, chunk_size=DEFAULT_TEXT_CHUNK_SIZE,
                   overlap=DEFAULT_TEXT_CHUNK_OVERLAP):
    """Markdown-aware chunking with contextual headers.

    Every chunk is prefixed with "[<filename> > <heading path>]" so the embedded
    text carries its document identity — a chunk that says "## Step 2: reply"
    means nothing to a retriever unless it knows it came from the comms skill.
    Adjacent small sections are merged greedily up to chunk_size; oversized
    sections fall back to the char-based splitter.
    """
    sections = _markdown_sections(text)
    if not sections:
        return []

    def header(path):
        return f"[{filename} > {path}]" if path else f"[{filename}]"

    def common_path_prefix(paths):
        """Longest common breadcrumb prefix of the merged sections' paths."""
        split_paths = [p.split(" > ") if p else [] for p in paths]
        prefix = []
        for parts in zip(*split_paths):
            if all(x == parts[0] for x in parts):
                prefix.append(parts[0])
            else:
                break
        return " > ".join(prefix)

    chunks = []
    pending_body = ""
    pending_paths = []

    def flush_pending():
        nonlocal pending_body, pending_paths
        if pending_body.strip():
            # A merged chunk is labelled with the breadcrumb common to ALL its
            # sections (often the shared parent heading), never a misleading one
            label = common_path_prefix(pending_paths) if pending_paths else ""
            chunks.append(f"{header(label)}\n{pending_body.strip()}")
        pending_body = ""
        pending_paths = []

    for path, body in sections:
        if len(body) > chunk_size:
            # Oversized section: flush whatever is pending, then sub-chunk it
            flush_pending()
            for sub in chunk_text(body, chunk_size=chunk_size, overlap=overlap):
                chunks.append(f"{header(path)}\n{sub}")
            continue
        # Greedy merge: accumulate small sections until chunk_size would be exceeded
        if pending_body and len(pending_body) + len(body) + 1 > chunk_size:
            flush_pending()
        pending_paths.append(path)
        pending_body = f"{pending_body}\n\n{body}" if pending_body else body
    flush_pending()

    return chunks


def chunk_text(text, chunk_size=DEFAULT_TEXT_CHUNK_SIZE, overlap=DEFAULT_TEXT_CHUNK_OVERLAP):
    """Split text into overlapping chunks, preferring paragraph/section boundaries."""
    if len(text) <= chunk_size:
        return [text] if text.strip() else []

    chunks = []
    start = 0
    while start < len(text):
        end = start + chunk_size

        # Try to break at a paragraph boundary (double newline)
        if end < len(text):
            # Look backwards from end for a good break point
            search_zone = text[max(start + chunk_size // 2, start):end]
            # Prefer double newline (paragraph break)
            para_break = search_zone.rfind("\n\n")
            if para_break != -1:
                end = max(start + chunk_size // 2, start) + para_break + 2
            else:
                # Fall back to single newline
                line_break = search_zone.rfind("\n")
                if line_break != -1:
                    end = max(start + chunk_size // 2, start) + line_break + 1

        chunk = text[start:end]
        if chunk.strip():
            chunks.append(chunk.strip())
        start = end - overlap
        if start >= len(text):
            break

    return chunks

# ---------------------------------------------------------------------------
# Video chunking with FFmpeg
# ---------------------------------------------------------------------------
def get_media_duration(file_path):
    """Get duration of a media file in seconds. Returns 0 if unreadable."""
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
             "-of", "csv=p=0", str(file_path)],
            capture_output=True, text=True,
        )
        val = result.stdout.strip()
        return float(val) if val else 0.0
    except (ValueError, subprocess.SubprocessError):
        return 0.0


def chunk_video(video_path, chunk_seconds=DEFAULT_VIDEO_CHUNK_SECONDS,
                overlap_seconds=DEFAULT_VIDEO_OVERLAP_SECONDS):
    """Split video into overlapping chunks using FFmpeg."""
    video_path = Path(video_path)
    output_dir = MEDIA_DIR / video_path.stem
    output_dir.mkdir(parents=True, exist_ok=True)

    duration = get_media_duration(video_path)

    chunks = []
    start = 0
    idx = 0
    step = chunk_seconds - overlap_seconds

    while start < duration:
        end = min(start + chunk_seconds, duration)
        # Skip tiny trailing chunks (< 5 seconds)
        if end - start < 5 and idx > 0:
            break

        output_file = output_dir / f"chunk_{idx:04d}.mp4"

        if not output_file.exists():
            subprocess.run(
                ["ffmpeg", "-y", "-i", str(video_path),
                 "-ss", str(start), "-t", str(end - start),
                 "-c", "copy", "-avoid_negative_ts", "1",
                 str(output_file)],
                capture_output=True,
            )

        chunks.append({
            "path": str(output_file),
            "start": start,
            "end": end,
            "index": idx,
        })

        start += step
        idx += 1

    return chunks


def chunk_audio(audio_path, chunk_seconds=DEFAULT_AUDIO_CHUNK_SECONDS,
                overlap_seconds=DEFAULT_AUDIO_OVERLAP_SECONDS):
    """Split audio into overlapping chunks using FFmpeg."""
    audio_path = Path(audio_path)
    output_dir = MEDIA_DIR / audio_path.stem
    output_dir.mkdir(parents=True, exist_ok=True)

    duration = get_media_duration(audio_path)

    ext = audio_path.suffix
    chunks = []
    start = 0
    idx = 0
    step = chunk_seconds - overlap_seconds

    while start < duration:
        end = min(start + chunk_seconds, duration)
        if end - start < 3 and idx > 0:
            break

        output_file = output_dir / f"chunk_{idx:04d}{ext}"

        if not output_file.exists():
            subprocess.run(
                ["ffmpeg", "-y", "-i", str(audio_path),
                 "-ss", str(start), "-t", str(end - start),
                 "-c", "copy", str(output_file)],
                capture_output=True,
            )

        chunks.append({
            "path": str(output_file),
            "start": start,
            "end": end,
            "index": idx,
        })

        start += step
        idx += 1

    return chunks

# ---------------------------------------------------------------------------
# File ID helper
# ---------------------------------------------------------------------------
def file_id(path, chunk_idx=None):
    """Generate a stable ID for a file or chunk."""
    h = hashlib.md5(str(path).encode()).hexdigest()[:12]
    if chunk_idx is not None:
        return f"{h}_chunk{chunk_idx}"
    return h

# ---------------------------------------------------------------------------
# Ingest logic
# ---------------------------------------------------------------------------
def already_exists(collection, doc_id):
    """Check if a document ID already exists in the collection. Respects --force flag."""
    if args_force:
        return False
    existing = collection.get(ids=[doc_id])
    return bool(existing and existing["ids"])


def ingest_text_file(client, config, collection, file_path):
    """Ingest a text-based file.

    With contextual_chunking (default on): markdown files are split on heading
    structure and every chunk carries a "[filename > heading path]" context
    header; other text files get a "[filename]" header. This makes small or
    fragmentary chunks retrievable — naked text fragments embed poorly.
    """
    file_path = Path(file_path)
    text = file_path.read_text(errors="replace")
    if not text.strip():
        print(f"  SKIP (empty): {file_path}")
        return 0

    chunk_size = config.get("text_chunk_size", DEFAULT_TEXT_CHUNK_SIZE)
    overlap = config.get("text_chunk_overlap", DEFAULT_TEXT_CHUNK_OVERLAP)
    contextual = config.get("contextual_chunking", True)

    if contextual and file_path.suffix.lower() in (".md", ".markdown"):
        chunks = chunk_markdown(text, file_path.name, chunk_size=chunk_size, overlap=overlap)
    elif contextual:
        chunks = [f"[{file_path.name}]\n{c}"
                  for c in chunk_text(text, chunk_size=chunk_size, overlap=overlap)]
    else:
        # Legacy char-based chunking, no context headers
        chunks = chunk_text(text, chunk_size=chunk_size, overlap=overlap)

    count = 0
    for i, chunk in enumerate(chunks):
        doc_id = file_id(file_path, i)
        if already_exists(collection, doc_id):
            continue

        embedding = embed_content(client, config, chunk)
        collection.upsert(
            ids=[doc_id],
            embeddings=[embedding],
            documents=[chunk],
            metadatas=[{
                "source": str(file_path.resolve()),
                "type": "text",
                "chunk_index": i,
                "total_chunks": len(chunks),
                "filename": file_path.name,
                "file_ext": file_path.suffix.lower(),
                "ingested_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            }],
        )
        count += 1

    return count


def ingest_image(client, config, collection, file_path):
    """Ingest an image: Gemini Flash describes it, then embed description + raw image together."""
    file_path = Path(file_path)
    doc_id = file_id(file_path)

    if already_exists(collection, doc_id):
        print(f"  SKIP (exists): {file_path}")
        return 0

    print(f"  Generating description for {file_path.name}...")
    description, media_bytes, mime = describe_media(client, config, file_path, "image")

    # Option B: embed text description + raw image together
    try:
        embedding = embed_multimodal(client, config, description, media_bytes, mime)
    except Exception:
        # Fallback to text-only embedding if multimodal fails (e.g., file too large)
        embedding = embed_content(client, config, description)

    collection.upsert(
        ids=[doc_id],
        embeddings=[embedding],
        documents=[description],
        metadatas=[{
            "source": str(file_path.resolve()),
            "type": "image",
            "filename": file_path.name,
            "file_ext": file_path.suffix.lower(),
            "mime_type": mime,
            "ingested_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        }],
    )
    return 1


def extract_audio_from_video(video_path, output_path):
    """Extract audio track from a video file as mp3."""
    subprocess.run(
        ["ffmpeg", "-y", "-i", str(video_path),
         "-vn", "-acodec", "libmp3lame", "-q:a", "4",
         str(output_path)],
        capture_output=True,
    )
    return Path(output_path).exists()


def ingest_video(client, config, collection, file_path):
    """Ingest a video: chunk it, describe each chunk, embed.

    For large videos (chunks > 20MB), falls back to audio-only extraction
    since the video bytes would be too large for the embedding API.
    For small chunks, uses full multimodal embedding (description + video).
    """
    file_path = Path(file_path)
    size_mb = file_path.stat().st_size / (1024 * 1024)
    duration = get_media_duration(file_path)

    if duration <= 0:
        print(f"  SKIP (unreadable/zero duration): {file_path}")
        return 0

    print(f"  Video: {file_path.name} ({size_mb:.0f}MB, {duration:.0f}s)")

    # Chunk the video
    chunk_secs = config.get("video_chunk_seconds", DEFAULT_VIDEO_CHUNK_SECONDS)
    overlap_secs = config.get("video_overlap_seconds", DEFAULT_VIDEO_OVERLAP_SECONDS)

    print(f"  Chunking into {chunk_secs}s segments with {overlap_secs}s overlap...")
    chunks = chunk_video(file_path, chunk_seconds=chunk_secs, overlap_seconds=overlap_secs)
    total_chunks = len(chunks)
    print(f"  Created {total_chunks} chunks")

    count = 0
    for chunk in chunks:
        doc_id = file_id(file_path, chunk["index"])
        if already_exists(collection, doc_id):
            continue

        chunk_path = Path(chunk["path"])
        chunk_size_mb = chunk_path.stat().st_size / (1024 * 1024) if chunk_path.exists() else 0

        print(f"  Chunk {chunk['index'] + 1}/{total_chunks} "
              f"({chunk['start']:.0f}s-{chunk['end']:.0f}s, {chunk_size_mb:.1f}MB)")

        description = None
        media_bytes = None
        mime = None

        # Strategy: try video description first, fall back to audio-only for large chunks
        if chunk_size_mb <= 20:
            # Small enough for full video analysis
            try:
                description, media_bytes, mime = describe_media(client, config, chunk_path, "video")
                print(f"    Described via video")
            except Exception as e:
                print(f"    Video description failed ({e}), trying audio...")

        if description is None:
            # Large chunk or video failed: extract audio and describe that
            audio_path = chunk_path.with_suffix(".mp3")
            if not audio_path.exists():
                print(f"    Extracting audio track...")
                extract_audio_from_video(chunk_path, audio_path)

            if audio_path.exists() and audio_path.stat().st_size > 0:
                try:
                    description, media_bytes, mime = describe_media(client, config, audio_path, "audio")
                    # Prefix so the agent knows this came from a video's audio
                    description = (
                        f"[Audio extracted from video: {file_path.name}, "
                        f"{chunk['start']:.0f}s-{chunk['end']:.0f}s]\n\n{description}"
                    )
                    print(f"    Described via audio extraction")
                except Exception as e:
                    print(f"    Audio description also failed: {e}")

        if description is None:
            description = (
                f"Video chunk from {file_path.name}, "
                f"{chunk['start']:.0f}s to {chunk['end']:.0f}s. "
                f"(Description unavailable - file may be too large or corrupted)"
            )

        # Embed: try multimodal if we have small media bytes, else text-only
        if media_bytes and mime and len(media_bytes) < 20 * 1024 * 1024:
            try:
                embedding = embed_multimodal(client, config, description, media_bytes, mime)
            except Exception:
                embedding = embed_content(client, config, description)
        else:
            embedding = embed_content(client, config, description)

        collection.upsert(
            ids=[doc_id],
            embeddings=[embedding],
            documents=[description],
            metadatas=[{
                "source": str(file_path.resolve()),
                "type": "video_chunk",
                "chunk_index": chunk["index"],
                "total_chunks": total_chunks,
                "chunk_start_seconds": chunk["start"],
                "chunk_end_seconds": chunk["end"],
                "chunk_path": str(chunk_path),
                "filename": file_path.name,
                "file_ext": file_path.suffix.lower(),
                "duration_seconds": duration,
                "ingested_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            }],
        )
        count += 1

    return count


def ingest_audio(client, config, collection, file_path):
    """Ingest audio: chunk if needed, describe, embed description + audio together."""
    file_path = Path(file_path)
    duration = get_media_duration(file_path)
    if duration <= 0:
        print(f"  SKIP (unreadable/zero duration): {file_path}")
        return 0
    max_chunk = config.get("audio_chunk_seconds", DEFAULT_AUDIO_CHUNK_SECONDS)

    if duration <= max_chunk:
        # Short enough to process as one piece
        doc_id = file_id(file_path)
        if already_exists(collection, doc_id):
            print(f"  SKIP (exists): {file_path}")
            return 0

        print(f"  Transcribing {file_path.name}...")
        description, media_bytes, mime = describe_media(client, config, file_path, "audio")

        try:
            embedding = embed_multimodal(client, config, description, media_bytes, mime)
        except Exception:
            embedding = embed_content(client, config, description)

        collection.upsert(
            ids=[doc_id],
            embeddings=[embedding],
            documents=[description],
            metadatas=[{
                "source": str(file_path.resolve()),
                "type": "audio",
                "filename": file_path.name,
                "file_ext": file_path.suffix.lower(),
                "duration_seconds": duration,
                "ingested_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            }],
        )
        return 1
    else:
        # Chunk the audio
        print(f"  Chunking audio: {file_path.name} ({duration:.0f}s)...")
        overlap = config.get("audio_overlap_seconds", DEFAULT_AUDIO_OVERLAP_SECONDS)
        chunks = chunk_audio(file_path, chunk_seconds=max_chunk, overlap_seconds=overlap)
        total_chunks = len(chunks)
        count = 0

        for chunk in chunks:
            doc_id = file_id(file_path, chunk["index"])
            if already_exists(collection, doc_id):
                continue

            print(f"  Transcribing chunk {chunk['index'] + 1}/{total_chunks}...")
            try:
                description, media_bytes, mime = describe_media(client, config, chunk["path"], "audio")
            except Exception as e:
                print(f"  WARNING: Failed to transcribe chunk {chunk['index']}: {e}")
                description = f"Audio chunk from {file_path.name}, {chunk['start']:.0f}s to {chunk['end']:.0f}s"
                media_bytes = None
                mime = None

            if media_bytes and mime:
                try:
                    embedding = embed_multimodal(client, config, description, media_bytes, mime)
                except Exception:
                    embedding = embed_content(client, config, description)
            else:
                embedding = embed_content(client, config, description)

            collection.upsert(
                ids=[doc_id],
                embeddings=[embedding],
                documents=[description],
                metadatas=[{
                    "source": str(file_path.resolve()),
                    "type": "audio_chunk",
                    "chunk_index": chunk["index"],
                    "total_chunks": total_chunks,
                    "chunk_start_seconds": chunk["start"],
                    "chunk_end_seconds": chunk["end"],
                    "chunk_path": chunk["path"],
                    "filename": file_path.name,
                    "file_ext": file_path.suffix.lower(),
                    "ingested_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                }],
            )
            count += 1
        return count


def extract_pdf_text_local(file_path):
    """Extract PDF text page-by-page locally with pypdf (no API call).

    Returns a list of page-text strings, or None if pypdf is unavailable.
    """
    try:
        from pypdf import PdfReader
    except ImportError:
        return None
    reader = PdfReader(str(file_path))
    return [(page.extract_text() or "") for page in reader.pages]


def ingest_pdf(client, config, collection, file_path):
    """Ingest a PDF page-by-page.

    Gemini provider: send PDF bytes to Gemini Flash (captures charts/images too).
    Cohere provider: extract text locally with pypdf (local-first, no PDF-bytes
    model at Cohere) — falls back to Gemini when pypdf is missing and a Gemini
    key exists.
    """
    file_path = Path(file_path)

    print(f"  Analyzing PDF: {file_path.name}...")

    text = None
    local_pages = None
    if get_provider(config) == PROVIDER_COHERE:
        local_pages = extract_pdf_text_local(file_path)
        if local_pages is None:
            if gemini_key_available(config):
                print("  [cohere] pypdf not installed — falling back to Gemini PDF extraction")
            else:
                print(f"  SKIP: pypdf not installed and no GEMINI_API_KEY fallback for {file_path}")
                return 0
        elif not any(p.strip() for p in local_pages):
            # Scanned/image-only PDF: pypdf finds no text layer. Gemini can OCR it;
            # without a Gemini key this would silently ingest zero chunks.
            if gemini_key_available(config):
                print("  [cohere] No extractable text (scanned PDF?) — falling back to Gemini OCR")
                local_pages = None
            else:
                print(f"  SKIP: no extractable text in {file_path.name} (scanned/image-only PDF) "
                      f"and no GEMINI_API_KEY fallback for OCR")
                return 0

    if local_pages is None:
        # Gemini path: full extraction including visual elements.
        # Gemini Flash returns 503 UNAVAILABLE during high-demand windows. Without
        # retries, a single 503 kills the ingest. _retry_generate_content wraps the
        # call with bounded retries on transient SDK conditions and fails fast
        # on everything else.
        from google.genai import types
        with open(file_path, "rb") as f:
            data = f.read()
        extraction_prompt = (
            "Extract ALL content from this PDF. For each page, include:\n"
            "1. Page number\n"
            "2. All text content (headings, body, lists, footnotes)\n"
            "3. Description of any images, charts, diagrams, or tables\n"
            "4. Key concepts and topics on that page\n"
            "Separate each page's content with '=== PAGE N ===' markers.\n"
            "Be thorough - this will be used for search and retrieval."
        )
        response = _retry_generate_content(
            client.genai,
            model=config.get("gemini_model", "gemini-2.5-flash"),
            contents=[
                types.Part.from_bytes(data=data, mime_type="application/pdf"),
                extraction_prompt,
            ],
        )
        if _tracker:
            _tracker.track_generation(response)
        text = response.text

    # Determine page sections as (page_number, content) pairs.
    # Local pypdf pages keep their ORIGINAL page numbers even when empty pages
    # are skipped (a blank page 2 must not renumber page 3).
    pages = []
    if local_pages is not None:
        pages = [(idx + 1, p.strip()) for idx, p in enumerate(local_pages) if p.strip()]
    elif "=== PAGE" in text:
        import re
        page_splits = re.split(r'===\s*PAGE\s*\d+\s*===', text)
        pages = [(idx + 1, p.strip()) for idx, p in enumerate(page_splits) if p.strip()]
    else:
        # No page markers - chunk as text
        chunks = chunk_text(
            text,
            chunk_size=config.get("text_chunk_size", DEFAULT_TEXT_CHUNK_SIZE),
            overlap=config.get("text_chunk_overlap", DEFAULT_TEXT_CHUNK_OVERLAP),
        )
        pages = [(idx + 1, c) for idx, c in enumerate(chunks)]

    count = 0
    for i, (page_number, page_content) in enumerate(pages):
        doc_id = file_id(file_path, i)
        if already_exists(collection, doc_id):
            continue

        embedding = embed_content(client, config, page_content)
        collection.upsert(
            ids=[doc_id],
            embeddings=[embedding],
            documents=[page_content],
            metadatas=[{
                "source": str(file_path.resolve()),
                "type": "pdf_page",
                "chunk_index": i,
                "total_chunks": len(pages),
                "page_number": page_number,
                "filename": file_path.name,
                "file_ext": ".pdf",
                "ingested_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            }],
        )
        count += 1
    return count


def extract_docx_text(file_path):
    """Extract text from .docx using python-docx."""
    from docx import Document
    doc = Document(str(file_path))
    parts = []
    for para in doc.paragraphs:
        if para.text.strip():
            style_name = para.style.name if para.style else ""
            if style_name.startswith("Heading"):
                level = style_name.replace("Heading ", "").strip()
                prefix = "#" * (int(level) if level.isdigit() else 1)
                parts.append(f"{prefix} {para.text}")
            else:
                parts.append(para.text)
    # Also extract tables
    for table in doc.tables:
        rows = []
        for row in table.rows:
            cells = [cell.text.strip() for cell in row.cells]
            rows.append(" | ".join(cells))
        if rows:
            parts.append("\n".join(rows))
    return "\n\n".join(parts)


def extract_pptx_text(file_path):
    """Extract text from .pptx using python-pptx."""
    from pptx import Presentation
    prs = Presentation(str(file_path))
    slides = []
    for i, slide in enumerate(prs.slides):
        texts = [f"=== SLIDE {i+1} ==="]
        for shape in slide.shapes:
            if shape.has_text_frame:
                for para in shape.text_frame.paragraphs:
                    if para.text.strip():
                        texts.append(para.text)
            if shape.has_table:
                for row in shape.table.rows:
                    cells = [cell.text.strip() for cell in row.cells]
                    texts.append(" | ".join(cells))
        # Notes
        if slide.has_notes_slide and slide.notes_slide.notes_text_frame:
            notes = slide.notes_slide.notes_text_frame.text.strip()
            if notes:
                texts.append(f"Speaker Notes: {notes}")
        slides.append("\n".join(texts))
    return "\n\n".join(slides)


def extract_xlsx_text(file_path):
    """Extract text from .xlsx using openpyxl."""
    from openpyxl import load_workbook
    wb = load_workbook(str(file_path), data_only=True)
    parts = []
    for sheet_name in wb.sheetnames:
        ws = wb[sheet_name]
        rows = []
        for row in ws.iter_rows(values_only=True):
            cells = [str(c) if c is not None else "" for c in row]
            if any(cells):
                rows.append(" | ".join(cells))
        if rows:
            parts.append(f"=== SHEET: {sheet_name} ===\n" + "\n".join(rows[:200]))  # cap at 200 rows
    return "\n\n".join(parts)


def ingest_office_doc(client, config, collection, file_path):
    """Ingest Office documents (.docx, .pptx, .xlsx) by extracting text locally."""
    file_path = Path(file_path)
    ext = file_path.suffix.lower()

    print(f"  Extracting content from {file_path.name}...")

    try:
        if ext in (".docx", ".doc"):
            text = extract_docx_text(file_path)
            type_name = "docx"
        elif ext in (".pptx", ".ppt"):
            text = extract_pptx_text(file_path)
            type_name = "slides"
        elif ext in (".xlsx", ".xls"):
            text = extract_xlsx_text(file_path)
            type_name = "spreadsheet"
        else:
            print(f"  SKIP (unsupported office format): {file_path}")
            return 0
    except Exception as e:
        print(f"  ERROR extracting {file_path.name}: {e}")
        return 0

    if not text.strip():
        print(f"  SKIP (empty document): {file_path}")
        return 0

    # Split presentations by slide markers, everything else by text chunks
    sections = []
    if type_name == "slides" and "=== SLIDE" in text:
        import re
        slide_splits = re.split(r'===\s*SLIDE\s*\d+\s*===', text)
        sections = [s.strip() for s in slide_splits if s.strip()]
    elif type_name == "spreadsheet" and "=== SHEET" in text:
        import re
        sheet_splits = re.split(r'===\s*SHEET:.*?===', text)
        sections = [s.strip() for s in sheet_splits if s.strip()]
    else:
        sections = chunk_text(
            text,
            chunk_size=config.get("text_chunk_size", DEFAULT_TEXT_CHUNK_SIZE),
            overlap=config.get("text_chunk_overlap", DEFAULT_TEXT_CHUNK_OVERLAP),
        )

    count = 0
    for i, section in enumerate(sections):
        if not section.strip():
            continue
        doc_id = file_id(file_path, i)
        if already_exists(collection, doc_id):
            continue

        embedding = embed_content(client, config, section)
        meta = {
            "source": str(file_path.resolve()),
            "type": type_name,
            "chunk_index": i,
            "total_chunks": len(sections),
            "filename": file_path.name,
            "file_ext": ext,
            "ingested_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        }
        if type_name == "slides":
            meta["slide_number"] = i + 1

        collection.upsert(ids=[doc_id], embeddings=[embedding], documents=[section], metadatas=[meta])
        count += 1
    return count


# Global flag for --force re-ingestion
args_force = False


def ingest_file(client, config, collection, file_path):
    """Route a file to the appropriate ingest handler."""
    file_path = Path(file_path)
    ext = file_path.suffix.lower()

    # Skip common non-content files
    skip_names = {".ds_store", "thumbs.db", ".gitignore", ".gitkeep", "package-lock.json",
                  "yarn.lock", "pnpm-lock.yaml", ".eslintcache"}
    if file_path.name.lower() in skip_names:
        return 0

    # Skip junk directories
    skip_dirs = {".git", "node_modules", "__pycache__", ".venv", "venv", ".env",
                 ".next", ".nuxt", "dist", "build", ".cache", ".turbo",
                 "vendor", ".terraform", ".angular", ".svelte-kit", ".output",
                 "coverage", ".nyc_output", ".pytest_cache", ".mypy_cache"}
    parts = set(file_path.parts)
    if parts & skip_dirs:
        return 0

    # Skip text files > 10MB (likely generated/binary)
    size_mb = file_path.stat().st_size / (1024 * 1024)
    if ext in TEXT_EXTS and size_mb > 10:
        print(f"  SKIP (too large: {size_mb:.0f}MB): {file_path}")
        return 0
    if ext in IMAGE_EXTS and size_mb > 50:
        print(f"  SKIP (too large: {size_mb:.0f}MB): {file_path}")
        return 0
    if ext in DOC_EXTS and size_mb > 100:
        print(f"  SKIP (too large: {size_mb:.0f}MB): {file_path}")
        return 0

    if ext in VIDEO_EXTS:
        return ingest_video(client, config, collection, file_path)
    elif ext in AUDIO_EXTS:
        return ingest_audio(client, config, collection, file_path)
    elif ext in IMAGE_EXTS:
        return ingest_image(client, config, collection, file_path)
    elif ext == ".pdf":
        return ingest_pdf(client, config, collection, file_path)
    elif ext in DOC_EXTS:
        return ingest_office_doc(client, config, collection, file_path)
    elif ext in TEXT_EXTS:
        return ingest_text_file(client, config, collection, file_path)
    else:
        # Try as text for unknown extensions
        try:
            file_path.read_text(errors="strict")[:100]
            return ingest_text_file(client, config, collection, file_path)
        except (UnicodeDecodeError, Exception):
            print(f"  SKIP (binary/unsupported): {file_path}")
            return 0

# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------
def cmd_ingest(args):
    global args_force, _tracker
    args_force = getattr(args, 'force', False)
    _tracker = UsageTracker("ingest")

    config = load_config()
    client = Clients(config)
    collection_name = args.collection or config.get("default_collection", "default")
    collection = get_chroma_collection(collection_name, config)

    # Refuse to mix embedding spaces — vectors from different providers/dims
    # in one collection are not comparable.
    compat_err = check_collection_compat(collection, config)
    if compat_err:
        print(f"ERROR: {compat_err}")
        sys.exit(1)

    if args_force:
        print(f"Force mode: will re-ingest existing files")

    total = 0
    skipped = 0
    errors = 0

    try:
        for path_str in args.paths:
            p = Path(path_str).resolve()
            if p.is_dir():
                files = sorted(f for f in p.rglob("*") if f.is_file() and not f.name.startswith("."))
                print(f"Ingesting directory: {p} ({len(files)} files)")
                for f in files:
                    print(f"  Processing: {f.relative_to(p)}")
                    try:
                        count = ingest_file(client, config, collection, f)
                        total += count
                        if count > 0:
                            print(f"    Added {count} chunk(s)")
                        elif count == 0:
                            skipped += 1
                    except Exception as e:
                        print(f"    ERROR: {e}")
                        errors += 1
            elif p.is_file():
                print(f"Ingesting: {p.name}")
                try:
                    count = ingest_file(client, config, collection, p)
                    total += count
                    if count > 0:
                        print(f"  Added {count} chunk(s)")
                except Exception as e:
                    print(f"  ERROR: {e}")
                    errors += 1
            else:
                print(f"NOT FOUND: {p}")
    finally:
        _tracker.persist()

    print(f"\nDone! Ingested {total} new chunk(s) into '{collection_name}'")
    if skipped:
        print(f"  Skipped: {skipped} (already existed or empty)")
    if errors:
        print(f"  Errors: {errors}")
    print(_tracker.summary_line())


def deduplicate_results(results, similarity_ratio=0.85):
    """Remove near-duplicate results based on content overlap."""
    if len(results) <= 1:
        return results

    deduped = [results[0]]
    for r in results[1:]:
        is_dup = False
        r_content = r["content"][:500]  # compare first 500 chars
        for existing in deduped:
            e_content = existing["content"][:500]
            # Quick overlap check: count shared words
            r_words = set(r_content.lower().split())
            e_words = set(e_content.lower().split())
            if not r_words or not e_words:
                continue
            overlap = len(r_words & e_words) / max(len(r_words), len(e_words))
            if overlap > similarity_ratio:
                is_dup = True
                break
        if not is_dup:
            deduped.append(r)
    return deduped


def cmd_query(args):
    global _tracker
    _tracker = UsageTracker("query")

    config = load_config()
    client = Clients(config)
    collection_name = args.collection or config.get("default_collection", "default")
    collection = get_chroma_collection(collection_name, config)

    if collection.count() == 0:
        print("Knowledge base is empty. Ingest some files first.")
        return

    # Refuse to query across mismatched embedding spaces — give the operator
    # an actionable reindex hint instead of a cryptic dimension error.
    compat_err = check_collection_compat(collection, config)
    if compat_err:
        print(f"ERROR: {compat_err}")
        sys.exit(1)

    # Two-stage retrieval: when rerank is on, recall WIDE from the vector store
    # and let the reranker decide relevance. The cosine threshold is only
    # applied when rerank is off (single-stage legacy behaviour).
    use_rerank = is_rerank_enabled(config) and not getattr(args, "no_rerank", False)
    if use_rerank and not cohere_key_available(config):
        print("WARNING: rerank enabled but no COHERE_API_KEY — falling back to vector-only retrieval",
              file=sys.stderr)
        use_rerank = False

    # Result count: explicit --top-k wins; otherwise rerank_top_n (rerank mode) or 5
    if args.top_k is not None:
        final_k = args.top_k
    elif use_rerank:
        final_k = config.get("rerank_top_n", DEFAULT_RERANK_TOP_N)
    else:
        final_k = 5
    if use_rerank:
        fetch_k = max(config.get("rerank_candidate_pool", DEFAULT_RERANK_CANDIDATE_POOL), final_k)
        # Recall stage is unfiltered; relevance is judged by the reranker
        threshold = 0.0
        rerank_threshold = args.threshold if args.threshold is not None \
            else config.get("rerank_threshold", DEFAULT_RERANK_THRESHOLD)
    else:
        # Fetch extra results so we have room after filtering/dedup.
        # Vector-only mode keeps the historical 0.5 relevance floor when the
        # config does not specify similarity_threshold (the bus wrapper always
        # used to enforce 0.5 — don't get noisier on legacy configs).
        fetch_k = final_k * 3
        threshold = args.threshold if args.threshold is not None else config.get("similarity_threshold", 0.5)
        rerank_threshold = None
    max_tokens = args.max_tokens or config.get("max_tokens", DEFAULT_MAX_TOKENS)
    show_full = args.full
    type_filter = args.type  # e.g., "image", "video", "text", "pdf"

    query_embedding = embed_query(client, config, args.question)

    # Build ChromaDB where filter for type
    where_filter = None
    if type_filter:
        # Map user-friendly names to stored types
        type_map = {
            "image": {"type": "image"},
            "video": {"type": "video_chunk"},
            "text": {"type": "text"},
            "pdf": {"type": "pdf_page"},
            "audio": {"$or": [{"type": "audio"}, {"type": "audio_chunk"}]},
        }
        if type_filter in type_map:
            where_filter = type_map[type_filter]
        else:
            # Direct type match
            where_filter = {"type": type_filter}

    query_kwargs = {
        "query_embeddings": [query_embedding],
        "n_results": min(fetch_k, collection.count()),
        "include": ["documents", "metadatas", "distances"],
    }
    if where_filter:
        query_kwargs["where"] = where_filter

    try:
        results = collection.query(**query_kwargs)
    except Exception as e:
        # where filter might fail if no docs match - fall back to unfiltered
        if where_filter:
            del query_kwargs["where"]
            results = collection.query(**query_kwargs)
        else:
            raise

    # Filter by similarity threshold
    filtered = []
    if results["ids"] and results["ids"][0]:
        for i, doc_id in enumerate(results["ids"][0]):
            distance = results["distances"][0][i] if results["distances"] else 0
            similarity = 1 - distance
            if similarity >= threshold:
                filtered.append({
                    "id": doc_id,
                    "content": results["documents"][0][i] if results["documents"] else "",
                    "similarity": similarity,
                    "metadata": results["metadatas"][0][i] if results["metadatas"] else {},
                })

    # Deduplicate near-identical results (same file in multiple lesson folders)
    filtered = deduplicate_results(filtered)

    # Rerank stage (two-stage retrieval): reorder candidates by true relevance
    # and apply the threshold against the RERANK score, not raw cosine. This is
    # what fixes the "0 results for an obviously-answerable query" failure mode.
    reranked = False
    if use_rerank and filtered:
        try:
            rerank_hits = cohere_rerank(client, config, args.question,
                                        [r["content"] for r in filtered],
                                        top_n=len(filtered))
            rescored = []
            for hit in rerank_hits:
                r = filtered[hit["index"]]
                r["rerank_score"] = hit["relevance_score"]
                if hit["relevance_score"] >= rerank_threshold:
                    rescored.append(r)
            filtered = rescored
            reranked = True
        except (RuntimeError, KeyError, IndexError) as e:
            print(f"WARNING: rerank failed ({e}) — using vector-similarity ordering", file=sys.stderr)
            # The recall stage was unfiltered (rerank was meant to judge relevance).
            # Re-apply the cosine floor so a transient Cohere outage doesn't make
            # results noisier than plain vector-only mode.
            fallback_threshold = config.get("similarity_threshold", 0.5)
            filtered = [r for r in filtered if r["similarity"] >= fallback_threshold]

    # Trim to requested top_k after dedup/rerank
    filtered = filtered[:final_k]

    # Apply max_tokens budget
    if max_tokens > 0:
        budgeted = []
        token_count = 0
        for r in filtered:
            chunk_tokens = len(r["content"]) // 4
            if token_count + chunk_tokens > max_tokens:
                remaining = max_tokens - token_count
                if remaining > 50:
                    r["content"] = r["content"][:remaining * 4] + "... [truncated]"
                    budgeted.append(r)
                break
            budgeted.append(r)
            token_count += chunk_tokens
        filtered = budgeted

    # Collect unique source files for the agent
    source_files = list(dict.fromkeys(
        r["metadata"].get("source", "") for r in filtered if r["metadata"].get("source")
    ))

    if args.json:
        output = {
            "query": args.question,
            "collection": collection_name,
            "result_count": len(filtered),
            "source_files": source_files,
            "reranked": reranked,
            "provider": get_provider(config),
            "results": [],
        }
        for r in filtered:
            meta = r["metadata"]
            entry = {
                "content": r["content"] if show_full else r["content"][:DEFAULT_PREVIEW_CHARS],
                "content_full_length": len(r["content"]),
                "similarity": round(r["similarity"], 4),
                "source": meta.get("source", ""),
                "type": meta.get("type", ""),
                "filename": meta.get("filename", ""),
            }
            if r.get("rerank_score") is not None:
                entry["rerank_score"] = round(r["rerank_score"], 4)
            # Add type-specific fields
            if meta.get("chunk_index") is not None:
                entry["chunk_index"] = meta["chunk_index"]
                entry["total_chunks"] = meta.get("total_chunks", 0)
            if meta.get("chunk_start_seconds") is not None:
                entry["time_start"] = meta["chunk_start_seconds"]
                entry["time_end"] = meta.get("chunk_end_seconds", 0)
            if meta.get("chunk_path"):
                entry["chunk_path"] = meta["chunk_path"]
            if meta.get("page_number"):
                entry["page_number"] = meta["page_number"]
            output["results"].append(entry)

        print(json.dumps(output, indent=2))
    else:
        print(f"Query: {args.question}")
        print(f"Collection: {collection_name}")
        if reranked:
            print(f"Results: {len(filtered)} (reranked, threshold: {rerank_threshold})")
        else:
            print(f"Results: {len(filtered)} (threshold: {threshold})")
        if source_files:
            print(f"Source files ({len(source_files)}):")
            for sf in source_files:
                print(f"  - {sf}")
        print("-" * 60)

        if filtered:
            for i, r in enumerate(filtered):
                meta = r["metadata"]
                if r.get("rerank_score") is not None:
                    print(f"\n[{i+1}] Rerank: {r['rerank_score']:.3f} (cosine: {r['similarity']:.3f})")
                else:
                    print(f"\n[{i+1}] Similarity: {r['similarity']:.3f}")
                print(f"    Source: {meta.get('source', 'unknown')}")
                print(f"    Type: {meta.get('type', 'unknown')}")
                if meta.get("chunk_index") is not None:
                    print(f"    Chunk: {meta['chunk_index'] + 1}/{meta.get('total_chunks', '?')}")
                if meta.get("chunk_start_seconds") is not None:
                    print(f"    Time: {meta['chunk_start_seconds']:.0f}s - {meta.get('chunk_end_seconds', 0):.0f}s")
                if meta.get("chunk_path"):
                    print(f"    Chunk file: {meta['chunk_path']}")
                if meta.get("page_number"):
                    print(f"    Page: {meta['page_number']}")

                content = r["content"]
                if not show_full and len(content) > DEFAULT_PREVIEW_CHARS:
                    content = content[:DEFAULT_PREVIEW_CHARS] + f"... [{len(r['content'])} chars total, use --full to see all]"
                print(f"    Content: {content}")
        else:
            print("No results above similarity threshold.")

    _tracker.persist()


def cmd_usage(args):
    """Show token usage and cost summary."""
    if args.reset:
        if USAGE_FILE.exists():
            USAGE_FILE.unlink()
        print("Usage data reset.")
        return

    if not USAGE_FILE.exists():
        print("No usage data yet. Run an ingest or query first.")
        return

    with open(USAGE_FILE) as f:
        data = json.load(f)

    if args.json:
        print(json.dumps(data, indent=2))
        return

    c = data.get("cumulative", {})
    sessions = data.get("sessions", [])

    emb_cost = (c.get("embedding_tokens", 0) / 1_000_000) * EMBEDDING_PRICE_PER_M
    gen_in_cost = (c.get("generation_input_tokens", 0) / 1_000_000) * FLASH_INPUT_PRICE_PER_M
    gen_out_cost = (c.get("generation_output_tokens", 0) / 1_000_000) * FLASH_OUTPUT_PRICE_PER_M
    total = emb_cost + gen_in_cost + gen_out_cost

    print("mmrag Usage Summary")
    print("=" * 40)
    print(f"Total cost:    ${total:.4f}")
    print(f"Total calls:   {c.get('embedding_calls', 0) + c.get('generation_calls', 0)} "
          f"({c.get('embedding_calls', 0)} embedding, {c.get('generation_calls', 0)} generation)")
    print()
    print("Token breakdown:")
    print(f"  Embedding:         {c.get('embedding_tokens', 0):>10,} tokens (est)  ${emb_cost:.4f}")
    print(f"  Generation input:  {c.get('generation_input_tokens', 0):>10,} tokens        ${gen_in_cost:.4f}")
    print(f"  Generation output: {c.get('generation_output_tokens', 0):>10,} tokens        ${gen_out_cost:.4f}")
    print()
    print(f"Sessions: {len(sessions)}")
    if sessions:
        last = sessions[-1]
        print(f"  Last: {last.get('operation', '?')} @ {last.get('finished_at', '?')} "
              f"(${last.get('cost', {}).get('total', 0):.4f})")

    # Per-day breakdown from sessions
    by_day = {}
    for s in sessions:
        day = s.get("started_at", "")[:10]
        if day:
            by_day.setdefault(day, {"cost": 0, "count": 0})
            by_day[day]["cost"] += s.get("cost", {}).get("total", 0)
            by_day[day]["count"] += 1

    if by_day:
        print()
        print("Daily breakdown:")
        for day in sorted(by_day.keys(), reverse=True)[:7]:
            d = by_day[day]
            print(f"  {day}:  ${d['cost']:.4f} ({d['count']} sessions)")


def cmd_status(args):
    config = load_config()
    collection_name = args.collection or config.get("default_collection", "default")

    try:
        collection = get_chroma_collection(collection_name)
        count = collection.count()
    except Exception:
        count = 0

    print(f"Collection: {collection_name}")
    print(f"Total chunks: {count}")
    print(f"Data dir: {MMRAG_DIR}")
    print(f"ChromaDB: {CHROMADB_DIR}")
    print(f"Config: {CONFIG_FILE}")

    # Show config values
    provider = get_provider(config)
    print(f"\nProvider: {provider}")
    print(f"  Embedding model: {active_embed_model(config)}")
    print(f"  Embedding dims: {active_embed_dimensions(config)}")
    rerank_on = is_rerank_enabled(config)
    print(f"  Rerank: {'enabled' if rerank_on else 'disabled'}"
          + (f" ({config.get('rerank_model', DEFAULT_RERANK_MODEL)}, "
             f"pool={config.get('rerank_candidate_pool', DEFAULT_RERANK_CANDIDATE_POOL)}, "
             f"top_n={config.get('rerank_top_n', DEFAULT_RERANK_TOP_N)})" if rerank_on else ""))

    print(f"\nChunk settings:")
    print(f"  Text: {config.get('text_chunk_size', DEFAULT_TEXT_CHUNK_SIZE)} chars, {config.get('text_chunk_overlap', DEFAULT_TEXT_CHUNK_OVERLAP)} overlap")
    print(f"  Video: {config.get('video_chunk_seconds', DEFAULT_VIDEO_CHUNK_SECONDS)}s, {config.get('video_overlap_seconds', DEFAULT_VIDEO_OVERLAP_SECONDS)}s overlap")
    print(f"  Audio: {config.get('audio_chunk_seconds', DEFAULT_AUDIO_CHUNK_SECONDS)}s, {config.get('audio_overlap_seconds', DEFAULT_AUDIO_OVERLAP_SECONDS)}s overlap")

    if count > 0:
        all_data = collection.get(include=["metadatas"])
        types_map = {}
        sources = set()
        for meta in all_data["metadatas"]:
            t = meta.get("type", "unknown")
            types_map[t] = types_map.get(t, 0) + 1
            sources.add(meta.get("source", "unknown"))

        print(f"\nUnique sources: {len(sources)}")
        print("Type breakdown:")
        for t, c in sorted(types_map.items()):
            print(f"  {t}: {c} chunks")


def cmd_list(args):
    config = load_config()
    collection_name = args.collection or config.get("default_collection", "default")

    try:
        collection = get_chroma_collection(collection_name)
    except Exception:
        print("No data found.")
        return

    all_data = collection.get(include=["metadatas"])
    if not all_data["ids"]:
        print("No documents in collection.")
        return

    # Group by source
    by_source = {}
    for meta in all_data["metadatas"]:
        src = meta.get("source", "unknown")
        if src not in by_source:
            by_source[src] = {"type": meta.get("type", "unknown"), "chunks": 0,
                              "filename": meta.get("filename", "")}
        by_source[src]["chunks"] += 1

    print(f"Collection: {collection_name} ({len(by_source)} files, {len(all_data['ids'])} chunks)")
    print(f"{'Source':<60} {'Type':<15} {'Chunks':<8}")
    print("-" * 85)
    for src, info in sorted(by_source.items()):
        display = src if len(src) <= 58 else "..." + src[-55:]
        print(f"{display:<60} {info['type']:<15} {info['chunks']:<8}")


def cmd_collections(args):
    chroma = get_chroma_client()
    collections = chroma.list_collections()
    if not collections:
        print("No collections found.")
        return
    print(f"{'Collection':<30} {'Documents':<12}")
    print("-" * 44)
    for c in collections:
        col = chroma.get_collection(c.name if hasattr(c, 'name') else c)
        name = c.name if hasattr(c, 'name') else c
        print(f"{name:<30} {col.count():<12}")


def cmd_delete(args):
    config = load_config()
    collection_name = args.collection or config.get("default_collection", "default")
    collection = get_chroma_collection(collection_name)

    source_path = str(Path(args.path).resolve())
    all_data = collection.get(include=["metadatas"])

    ids_to_delete = []
    for i, meta in enumerate(all_data["metadatas"]):
        if meta.get("source") == source_path:
            ids_to_delete.append(all_data["ids"][i])

    if not ids_to_delete:
        print(f"No documents found for: {source_path}")
        return

    collection.delete(ids=ids_to_delete)
    print(f"Deleted {len(ids_to_delete)} chunk(s) from '{collection_name}' for: {source_path}")


REINDEX_TMP_SUFFIX = "__reindex_tmp"
REINDEX_OLD_SUFFIX = "__pre_reindex"
REINDEX_BATCH_SIZE = 50


def reindex_collection(chroma, client, config, name):
    """Migrate one collection to the currently configured embedding provider.

    Reads the stored chunk text + metadata out of ChromaDB (no source files
    needed — expensive media descriptions are preserved as-is), re-embeds with
    the active provider, builds a temp collection, then swaps.

    The swap is rename-first so there is no window where the collection name
    points at nothing: original → <name>__pre_reindex, temp → <name>, then the
    old data is dropped. If renaming the temp fails, the original is restored
    under its own name. The rebuild is also count-verified before any swap.

    Returns the number of chunks migrated.
    """
    tmp_name = f"{name}{REINDEX_TMP_SUFFIX}"
    old_name = f"{name}{REINDEX_OLD_SUFFIX}"

    # Self-heal an interrupted swap: if a previous run crashed between renaming
    # the original (→ __pre_reindex) and renaming the temp (→ name), the data
    # only exists under __pre_reindex. Restore it before doing anything else.
    try:
        src = chroma.get_collection(name)
    except Exception:
        try:
            orphan = chroma.get_collection(old_name)
        except Exception:
            raise RuntimeError(f"Collection '{name}' not found")
        print(f"  {name}: recovering from interrupted reindex (restoring {old_name})", file=sys.stderr)
        orphan.modify(name=name)
        src = orphan

    total = src.count()
    if total == 0:
        print(f"  {name}: empty, skipping", file=sys.stderr)
        return 0

    # Clean up any stale temp/old collections from a previously interrupted run.
    # Safe: at this point `name` exists and holds the authoritative data.
    for stale in (tmp_name, old_name):
        try:
            chroma.delete_collection(stale)
        except Exception:
            pass

    # Preserve any custom collection metadata; provider fields take precedence
    merged_meta = {**(src.metadata or {}), **collection_metadata_for(config)}
    dst = chroma.create_collection(name=tmp_name, metadata=merged_meta)

    provider = get_provider(config)
    print(f"  {name}: re-embedding {total} chunks → {provider} "
          f"({active_embed_model(config)}, {active_embed_dimensions(config)}d)", file=sys.stderr)

    migrated = 0
    offset = 0
    while offset < total:
        batch = src.get(limit=REINDEX_BATCH_SIZE, offset=offset, include=["documents", "metadatas"])
        ids = batch["ids"]
        if not ids:
            break
        docs = batch["documents"]
        metas = batch["metadatas"]

        # Media chunks (image/video/audio) are re-embedded from their stored TEXT
        # descriptions only — the raw-media component of the original multimodal
        # embedding is not reproduced (no source bytes, no re-describe cost).
        media_count = sum(1 for m in metas if m.get("type") not in ("text", "pdf_page", "docx", "slides", "spreadsheet"))
        if media_count:
            print(f"    note: {media_count} media chunk(s) re-embedded from text descriptions only", file=sys.stderr)

        # Re-embed the stored chunk text under the new provider (batched)
        embeddings = embed_texts_batch(client, config, docs, task_type="RETRIEVAL_DOCUMENT")

        # Tag chunk metadata with migration provenance
        stamp = time.strftime("%Y-%m-%dT%H:%M:%S")
        for m in metas:
            m["embedding_provider"] = provider
            m["reindexed_at"] = stamp

        dst.upsert(ids=ids, embeddings=embeddings, documents=docs, metadatas=metas)
        migrated += len(ids)
        offset += REINDEX_BATCH_SIZE
        print(f"    {min(migrated, total)}/{total}", file=sys.stderr)

    # Verify the rebuild is complete before touching the original
    rebuilt = dst.count()
    if rebuilt != total:
        chroma.delete_collection(tmp_name)
        raise RuntimeError(
            f"reindex of '{name}' incomplete: rebuilt {rebuilt}/{total} chunks — "
            f"original collection left untouched"
        )

    # Swap (rename-first, with rollback):
    #   1. original → <name>__pre_reindex
    #   2. temp     → <name>            (rollback step 1 on failure)
    #   3. drop <name>__pre_reindex
    src.modify(name=old_name)
    try:
        dst.modify(name=name)
    except Exception:
        # Restore the original under its real name; leave the temp for inspection
        src.modify(name=name)
        raise
    try:
        chroma.delete_collection(old_name)
    except Exception:
        print(f"  WARNING: could not delete old collection '{old_name}' — remove it manually", file=sys.stderr)

    print(f"  {name}: done ({migrated} chunks)", file=sys.stderr)
    return migrated


def cmd_reindex(args):
    """Migrate existing collections to the configured embedding provider/dimensions."""
    global _tracker
    _tracker = UsageTracker("reindex")

    config = load_config()
    client = Clients(config)
    chroma = get_chroma_client()

    if args.collection:
        names = [args.collection]
    else:
        names = [c.name if hasattr(c, "name") else c for c in chroma.list_collections()]
        names = [n for n in names
                 if not n.endswith(REINDEX_TMP_SUFFIX) and not n.endswith(REINDEX_OLD_SUFFIX)]

    if not names:
        print("No collections found to reindex.", file=sys.stderr)
        return

    provider = get_provider(config)
    print(f"Reindexing {len(names)} collection(s) → provider={provider}, "
          f"model={active_embed_model(config)}, dims={active_embed_dimensions(config)}", file=sys.stderr)

    summary = {"provider": provider, "model": active_embed_model(config),
               "dimensions": active_embed_dimensions(config), "collections": {}}
    errors = 0
    try:
        for name in names:
            try:
                count = reindex_collection(chroma, client, config, name)
                summary["collections"][name] = count
            except Exception as e:
                print(f"  ERROR reindexing {name}: {e}", file=sys.stderr)
                summary["collections"][name] = f"ERROR: {e}"
                errors += 1
    finally:
        _tracker.persist()

    if getattr(args, "json", False):
        print(json.dumps(summary, indent=2))
    else:
        print(f"\nReindex complete: {len(names) - errors}/{len(names)} collection(s) migrated")
        print(_tracker.summary_line())
    if errors:
        sys.exit(1)


def cmd_reset(args):
    if not args.confirm:
        print("ERROR: Pass --confirm to reset the knowledge base.")
        return

    chroma = get_chroma_client()
    collections = chroma.list_collections()
    count = 0
    for c in collections:
        name = c.name if hasattr(c, 'name') else c
        chroma.delete_collection(name)
        count += 1

    import shutil
    if MEDIA_DIR.exists():
        shutil.rmtree(MEDIA_DIR)
        MEDIA_DIR.mkdir(parents=True)

    print(f"Reset complete. Deleted {count} collection(s) and cleared media cache.")

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(
        description="Multimodal RAG Knowledge Base CLI",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="command", help="Command to run")

    # ingest
    p_ingest = sub.add_parser("ingest", help="Ingest files into the knowledge base")
    p_ingest.add_argument("paths", nargs="+", help="File or directory paths to ingest")
    p_ingest.add_argument("--collection", "-c", help="Collection name (default: 'default')")
    p_ingest.add_argument("--force", action="store_true", help="Re-ingest files even if already in the KB")

    # query
    p_query = sub.add_parser("query", help="Query the knowledge base")
    p_query.add_argument("question", help="Question to ask")
    p_query.add_argument("--top-k", "-k", type=int, default=None,
                         help="Max number of results (default: rerank_top_n when reranking, else 5)")
    p_query.add_argument("--threshold", "-t", type=float, default=None,
                         help="Min similarity threshold 0.0-1.0 (default: 0.0, return all)")
    p_query.add_argument("--max-tokens", "-m", type=int, default=0,
                         help="Max total tokens in results (0=unlimited)")
    p_query.add_argument("--collection", "-c", help="Collection name")
    p_query.add_argument("--type", help="Filter by content type: image, video, text, pdf, audio")
    p_query.add_argument("--json", "-j", action="store_true", help="Output as JSON (for agent consumption)")
    p_query.add_argument("--full", "-f", action="store_true", help="Show full content (not truncated)")
    p_query.add_argument("--no-rerank", dest="no_rerank", action="store_true",
                         help="Disable the rerank stage (A/B comparison / fallback)")

    # reindex (provider migration)
    p_reindex = sub.add_parser("reindex",
                               help="Re-embed existing collections with the configured embedding provider")
    p_reindex.add_argument("--collection", "-c", help="Collection to reindex (default: all collections)")
    p_reindex.add_argument("--json", "-j", action="store_true", help="Output summary as JSON")

    # status
    p_status = sub.add_parser("status", help="Show knowledge base status")
    p_status.add_argument("--collection", "-c", help="Collection name")

    # list
    p_list = sub.add_parser("list", help="List ingested documents")
    p_list.add_argument("--collection", "-c", help="Collection name")

    # collections
    sub.add_parser("collections", help="List all collections")

    # delete
    p_delete = sub.add_parser("delete", help="Delete a document by source path")
    p_delete.add_argument("path", help="Source file path to delete")
    p_delete.add_argument("--collection", "-c", help="Collection name")

    # reset
    p_reset = sub.add_parser("reset", help="Reset the entire knowledge base")
    p_reset.add_argument("--confirm", action="store_true", help="Confirm reset")

    # usage
    p_usage = sub.add_parser("usage", help="Show token usage and cost summary")
    p_usage.add_argument("--json", "-j", action="store_true", help="Output as JSON")
    p_usage.add_argument("--reset", action="store_true", help="Reset usage data")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    commands = {
        "ingest": cmd_ingest,
        "query": cmd_query,
        "reindex": cmd_reindex,
        "status": cmd_status,
        "list": cmd_list,
        "collections": cmd_collections,
        "delete": cmd_delete,
        "reset": cmd_reset,
        "usage": cmd_usage,
    }

    commands[args.command](args)


if __name__ == "__main__":
    main()
