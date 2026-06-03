#!/usr/bin/env python3
"""
Unit tests for mmrag.py provider abstraction, Cohere integration, and reindex.

Stdlib-only (unittest + mock) — no chromadb/google-genai/network required, so
these run with any python3:

    python3 -m unittest test_mmrag -v
"""

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import mmrag


class TestProviderConfig(unittest.TestCase):
    def test_default_provider_is_gemini(self):
        self.assertEqual(mmrag.get_provider({}), mmrag.PROVIDER_GEMINI)

    def test_explicit_cohere_provider(self):
        self.assertEqual(mmrag.get_provider({"embedding_provider": "cohere"}), mmrag.PROVIDER_COHERE)

    def test_active_embed_model_gemini(self):
        self.assertEqual(mmrag.active_embed_model({}), "gemini-embedding-2-preview")
        self.assertEqual(
            mmrag.active_embed_model({"embedding_model": "custom-gemini"}),
            "custom-gemini",
        )

    def test_active_embed_model_cohere(self):
        cfg = {"embedding_provider": "cohere"}
        self.assertEqual(mmrag.active_embed_model(cfg), mmrag.DEFAULT_COHERE_EMBED_MODEL)
        cfg["cohere_embed_model"] = "embed-v5.0"
        self.assertEqual(mmrag.active_embed_model(cfg), "embed-v5.0")

    def test_active_dimensions(self):
        # Gemini default
        self.assertEqual(mmrag.active_embed_dimensions({}), mmrag.DEFAULT_EMBEDDING_DIMENSIONS)
        # Cohere default
        self.assertEqual(
            mmrag.active_embed_dimensions({"embedding_provider": "cohere"}),
            mmrag.DEFAULT_COHERE_EMBED_DIMENSIONS,
        )
        # Explicit wins for both
        self.assertEqual(
            mmrag.active_embed_dimensions({"embedding_provider": "cohere", "embedding_dimensions": 512}),
            512,
        )


class TestRerankEnabled(unittest.TestCase):
    def test_default_off_for_gemini(self):
        self.assertFalse(mmrag.is_rerank_enabled({}))
        self.assertFalse(mmrag.is_rerank_enabled({"embedding_provider": "gemini"}))

    def test_default_on_for_cohere(self):
        self.assertTrue(mmrag.is_rerank_enabled({"embedding_provider": "cohere"}))

    def test_explicit_override_wins(self):
        # Gemini provider can opt IN to rerank
        self.assertTrue(mmrag.is_rerank_enabled({"embedding_provider": "gemini", "rerank_enabled": True}))
        # Cohere provider can opt OUT
        self.assertFalse(mmrag.is_rerank_enabled({"embedding_provider": "cohere", "rerank_enabled": False}))


class TestCohereKeyResolution(unittest.TestCase):
    def test_env_key_wins(self):
        with mock.patch.dict("os.environ", {"COHERE_API_KEY": "env-key"}):
            self.assertEqual(mmrag.get_cohere_api_key({"cohere_api_key": "cfg-key"}), "env-key")

    def test_config_key_fallback(self):
        with mock.patch.dict("os.environ", {}, clear=True):
            self.assertEqual(mmrag.get_cohere_api_key({"cohere_api_key": "cfg-key"}), "cfg-key")

    def test_missing_key_exits_when_required(self):
        with mock.patch.dict("os.environ", {}, clear=True):
            with self.assertRaises(SystemExit):
                mmrag.get_cohere_api_key({})

    def test_missing_key_returns_none_when_optional(self):
        with mock.patch.dict("os.environ", {}, clear=True):
            self.assertIsNone(mmrag.get_cohere_api_key({}, required=False))

    def test_availability_helpers(self):
        with mock.patch.dict("os.environ", {}, clear=True):
            self.assertFalse(mmrag.cohere_key_available({}))
            self.assertTrue(mmrag.cohere_key_available({"cohere_api_key": "x"}))
        with mock.patch.dict("os.environ", {"COHERE_API_KEY": "x"}):
            self.assertTrue(mmrag.cohere_key_available({}))


class FakeClients:
    """Stands in for mmrag.Clients without touching real keys."""
    cohere_key = "test-key"


class TestCohereEmbed(unittest.TestCase):
    def setUp(self):
        self.config = {"embedding_provider": "cohere"}
        self.clients = FakeClients()

    def _fake_response(self, n):
        return {"embeddings": {"float": [[0.1] * 4 for _ in range(n)]}}

    def test_embed_texts_payload(self):
        with mock.patch.object(mmrag, "_cohere_post") as post:
            post.return_value = self._fake_response(2)
            vectors = mmrag.cohere_embed_texts(self.clients, self.config, ["a", "b"], "search_document")

        self.assertEqual(len(vectors), 2)
        post.assert_called_once()
        _, path, payload = post.call_args[0]
        self.assertEqual(path, "/v2/embed")
        self.assertEqual(payload["model"], mmrag.DEFAULT_COHERE_EMBED_MODEL)
        self.assertEqual(payload["input_type"], "search_document")
        self.assertEqual(payload["output_dimension"], mmrag.DEFAULT_COHERE_EMBED_DIMENSIONS)
        self.assertEqual(payload["texts"], ["a", "b"])

    def test_embed_batching_over_96(self):
        texts = [f"text {i}" for i in range(200)]
        with mock.patch.object(mmrag, "_cohere_post") as post:
            post.side_effect = [
                self._fake_response(96), self._fake_response(96), self._fake_response(8),
            ]
            vectors = mmrag.cohere_embed_texts(self.clients, self.config, texts, "search_document")

        self.assertEqual(len(vectors), 200)
        self.assertEqual(post.call_count, 3)

    def test_embed_content_routes_query_input_type(self):
        """RETRIEVAL_QUERY task type maps to Cohere search_query (asymmetric embeddings)."""
        with mock.patch.object(mmrag, "_cohere_post") as post:
            post.return_value = self._fake_response(1)
            mmrag.embed_content(self.clients, self.config, "what are agent goals?",
                                task_type="RETRIEVAL_QUERY")

        payload = post.call_args[0][2]
        self.assertEqual(payload["input_type"], "search_query")

    def test_embed_content_routes_document_input_type(self):
        with mock.patch.object(mmrag, "_cohere_post") as post:
            post.return_value = self._fake_response(1)
            mmrag.embed_content(self.clients, self.config, "document chunk text")

        payload = post.call_args[0][2]
        self.assertEqual(payload["input_type"], "search_document")

    def test_embed_multimodal_image_uses_image_input(self):
        with mock.patch.object(mmrag, "_cohere_post") as post:
            post.return_value = {"embeddings": {"float": [[0.1] * 4]}}
            mmrag.embed_multimodal(self.clients, self.config, "a chart", b"\x89PNG", "image/png")

        payload = post.call_args[0][2]
        self.assertIn("inputs", payload)
        content = payload["inputs"][0]["content"]
        self.assertEqual(content[0], {"type": "text", "text": "a chart"})
        self.assertEqual(content[1]["type"], "image_url")
        self.assertTrue(content[1]["image_url"]["url"].startswith("data:image/png;base64,"))

    def test_embed_multimodal_audio_falls_back_to_text(self):
        """Cohere can't embed audio bytes — the description text is embedded instead."""
        with mock.patch.object(mmrag, "_cohere_post") as post:
            post.return_value = self._fake_response(1)
            mmrag.embed_multimodal(self.clients, self.config, "a podcast about agents", b"RIFF", "audio/wav")

        payload = post.call_args[0][2]
        self.assertIn("texts", payload)
        self.assertEqual(payload["texts"], ["a podcast about agents"])

    def test_embed_content_rejects_non_string_for_cohere(self):
        """Provider=cohere + non-str content must raise, never fall through to Gemini."""
        with self.assertRaises(RuntimeError):
            mmrag.embed_content(self.clients, self.config, ["a", "list", "of", "parts"])

    def test_cohere_chat_empty_response_raises(self):
        """An empty Cohere chat response must raise rather than return ''. """
        with mock.patch.object(mmrag, "_cohere_post") as post:
            post.return_value = {"message": {"content": []}, "meta": {}}
            with self.assertRaises(RuntimeError):
                mmrag.cohere_chat_text(self.clients, self.config, "describe this")


class TestCohereRerank(unittest.TestCase):
    def test_rerank_payload_and_results(self):
        clients = FakeClients()
        config = {"embedding_provider": "cohere"}
        docs = ["doc a", "doc b", "doc c"]
        with mock.patch.object(mmrag, "_cohere_post") as post:
            post.return_value = {"results": [
                {"index": 2, "relevance_score": 0.99},
                {"index": 0, "relevance_score": 0.42},
            ]}
            results = mmrag.cohere_rerank(clients, config, "the query", docs, top_n=5)

        _, path, payload = post.call_args[0]
        self.assertEqual(path, "/v2/rerank")
        self.assertEqual(payload["model"], mmrag.DEFAULT_RERANK_MODEL)
        self.assertEqual(payload["query"], "the query")
        self.assertEqual(payload["documents"], docs)
        # top_n is clamped to the number of documents
        self.assertEqual(payload["top_n"], 3)
        # Results pass through in rerank order
        self.assertEqual(results[0]["index"], 2)
        self.assertAlmostEqual(results[0]["relevance_score"], 0.99)


class FakeCollection:
    """Minimal stand-in for a chromadb collection."""

    def __init__(self, name="test", count=1, metadata=None, embeddings=None):
        self.name = name
        self._count = count
        self.metadata = metadata or {}
        self._embeddings = embeddings

    def count(self):
        return self._count

    def get(self, **kwargs):
        return {"embeddings": self._embeddings}


class TestCollectionCompat(unittest.TestCase):
    def test_empty_collection_always_compatible(self):
        col = FakeCollection(count=0)
        self.assertIsNone(mmrag.check_collection_compat(col, {"embedding_provider": "cohere"}))

    def test_provider_match_compatible(self):
        col = FakeCollection(metadata={
            "embedding_provider": "cohere",
            "embedding_dimensions": mmrag.DEFAULT_COHERE_EMBED_DIMENSIONS,
        })
        self.assertIsNone(mmrag.check_collection_compat(col, {"embedding_provider": "cohere"}))

    def test_provider_mismatch_flagged_with_reindex_hint(self):
        col = FakeCollection(name="shared-personas", metadata={
            "embedding_provider": "gemini", "embedding_dimensions": 3072,
        })
        err = mmrag.check_collection_compat(col, {"embedding_provider": "cohere"})
        self.assertIsNotNone(err)
        self.assertIn("gemini", err)
        self.assertIn("cohere", err)
        self.assertIn("kb-reindex", err)

    def test_legacy_collection_dimension_probe(self):
        """Collections created before provider tagging: detect mismatch via stored vector dims."""
        col = FakeCollection(name="legacy", metadata={}, embeddings=[[0.1] * 3072])
        # Cohere config expects 1024 dims → mismatch
        err = mmrag.check_collection_compat(col, {"embedding_provider": "cohere"})
        self.assertIsNotNone(err)
        self.assertIn("kb-reindex", err)

    def test_legacy_collection_blocked_for_cohere_even_with_matching_dims(self):
        """Untagged collections are gemini-embedded by definition — a cohere config must
        never query them, even when dimensions coincide (different vector spaces)."""
        col = FakeCollection(name="legacy", metadata={}, embeddings=[[0.1] * 1024])
        err = mmrag.check_collection_compat(col, {"embedding_provider": "cohere",
                                                  "embedding_dimensions": 1024})
        self.assertIsNotNone(err)
        self.assertIn("kb-reindex", err)

    def test_legacy_collection_matching_dims_ok(self):
        col = FakeCollection(name="legacy", metadata={}, embeddings=[[0.1] * 768])
        # Gemini config with default 768 dims → compatible
        self.assertIsNone(mmrag.check_collection_compat(col, {}))

    def test_model_change_same_dims_flagged(self):
        """Same provider + same dims but a different embedding model is incompatible."""
        col = FakeCollection(name="tagged", metadata={
            "embedding_provider": "cohere",
            "embedding_dimensions": 1024,
            "embedding_model": "embed-v4.0",
        })
        err = mmrag.check_collection_compat(col, {
            "embedding_provider": "cohere",
            "embedding_dimensions": 1024,
            "cohere_embed_model": "embed-v5.0",
        })
        self.assertIsNotNone(err)
        self.assertIn("embed-v4.0", err)
        self.assertIn("embed-v5.0", err)
        self.assertIn("kb-reindex", err)


class TestContextualChunking(unittest.TestCase):
    MD = """# Knowledge Base

Intro paragraph about the KB.

## Query

How to query things.

## Ingest

How to ingest things.

### Private scope

Private collection details.
"""

    def test_markdown_sections_heading_paths(self):
        sections = mmrag._markdown_sections(self.MD)
        paths = [p for p, _ in sections]
        self.assertEqual(paths, [
            "Knowledge Base",
            "Knowledge Base > Query",
            "Knowledge Base > Ingest",
            "Knowledge Base > Ingest > Private scope",
        ])

    def test_chunk_markdown_prepends_context_headers(self):
        # chunk_size=50 keeps every section as its own chunk (no merging)
        chunks = mmrag.chunk_markdown(self.MD, "SKILL.md", chunk_size=50, overlap=10)
        self.assertTrue(all(c.startswith("[SKILL.md") for c in chunks))
        # Each unmerged section carries its full breadcrumb
        self.assertTrue(any("Ingest > Private scope" in c for c in chunks))

    def test_chunk_markdown_merge_uses_parent_breadcrumb(self):
        # When small sections merge, the chunk takes the FIRST section's path
        chunks = mmrag.chunk_markdown(self.MD, "SKILL.md", chunk_size=80, overlap=10)
        self.assertTrue(all(c.startswith("[SKILL.md") for c in chunks))
        # Content from the deep section is present even though its breadcrumb merged away
        self.assertTrue(any("Private collection details." in c for c in chunks))

    def test_chunk_markdown_merges_small_sections(self):
        # With a generous chunk size, all sections merge into one chunk
        chunks = mmrag.chunk_markdown(self.MD, "SKILL.md", chunk_size=5000, overlap=10)
        self.assertEqual(len(chunks), 1)
        self.assertIn("[SKILL.md", chunks[0])
        self.assertIn("Private collection details.", chunks[0])

    def test_chunk_markdown_splits_oversized_sections(self):
        big = "# Top\n\n" + ("word " * 600)  # ~3000 chars under one heading
        chunks = mmrag.chunk_markdown(big, "BIG.md", chunk_size=1000, overlap=100)
        self.assertGreater(len(chunks), 1)
        self.assertTrue(all(c.startswith("[BIG.md > Top]") for c in chunks))

    def test_plain_text_unaffected(self):
        """Non-markdown text via chunk_text has no headers (header added by caller)."""
        chunks = mmrag.chunk_text("plain text content", chunk_size=100, overlap=10)
        self.assertEqual(chunks, ["plain text content"])

    def test_code_block_comments_are_not_headings(self):
        """Council fix: # comments inside fenced code blocks must not split sections."""
        md = (
            "# Setup\n\nRun this:\n\n"
            "```bash\n# this is a comment, not a heading\necho hello\n```\n\n"
            "## Next step\n\nMore text.\n"
        )
        sections = mmrag._markdown_sections(md)
        paths = [p for p, _ in sections]
        self.assertEqual(paths, ["Setup", "Setup > Next step"])
        # The comment line stays inside the Setup section body
        self.assertIn("# this is a comment", sections[0][1])

    def test_merged_chunk_uses_common_breadcrumb(self):
        """Council fix: a chunk merging sections from different branches gets the
        common parent breadcrumb, never the first section's misleading full path."""
        md = (
            "# KB\n\n## Query\n\nshort q text.\n\n## Ingest\n\nshort i text.\n"
        )
        chunks = mmrag.chunk_markdown(md, "F.md", chunk_size=5000, overlap=10)
        self.assertEqual(len(chunks), 1)
        # Common prefix of "KB", "KB > Query", "KB > Ingest" is "KB"
        self.assertTrue(chunks[0].startswith("[F.md > KB]"))

    def test_tiny_file_gets_identity(self):
        """The GOALS.md failure case: a tiny file still produces a context-bearing chunk."""
        tiny = "# Goals\n\nKeep the user organised.\n"
        chunks = mmrag.chunk_markdown(tiny, "GOALS.md", chunk_size=1000, overlap=200)
        self.assertEqual(len(chunks), 1)
        self.assertIn("[GOALS.md > Goals]", chunks[0])
        self.assertIn("Keep the user organised.", chunks[0])


class TestCoherePostRetry(unittest.TestCase):
    def _http_error(self, code):
        import urllib.error
        return urllib.error.HTTPError(
            url="https://api.cohere.com/v2/embed", code=code,
            msg="err", hdrs={}, fp=mock.MagicMock(read=lambda: b'{"message": "boom"}'),
        )

    def test_retries_on_429_then_succeeds(self):
        ok_response = mock.MagicMock()
        ok_response.read.return_value = json.dumps({"ok": True}).encode()
        ok_response.__enter__ = lambda s: ok_response
        ok_response.__exit__ = mock.MagicMock(return_value=False)

        with mock.patch("urllib.request.urlopen") as urlopen, \
             mock.patch("time.sleep"):
            urlopen.side_effect = [self._http_error(429), ok_response]
            result = mmrag._cohere_post("key", "/v2/embed", {})

        self.assertEqual(result, {"ok": True})
        self.assertEqual(urlopen.call_count, 2)

    def test_no_retry_on_400(self):
        with mock.patch("urllib.request.urlopen") as urlopen, \
             mock.patch("time.sleep"):
            urlopen.side_effect = [self._http_error(400)]
            with self.assertRaises(RuntimeError):
                mmrag._cohere_post("key", "/v2/embed", {})

        self.assertEqual(urlopen.call_count, 1)

    def test_non_json_body_raises_runtime_error(self):
        """A 200 response with a non-JSON body (proxy error page) raises RuntimeError,
        not JSONDecodeError — so callers' fallback handling applies."""
        ok_response = mock.MagicMock()
        ok_response.read.return_value = b"<html>502 Bad Gateway</html>"
        ok_response.__enter__ = lambda s: ok_response
        ok_response.__exit__ = mock.MagicMock(return_value=False)

        with mock.patch("urllib.request.urlopen") as urlopen:
            urlopen.return_value = ok_response
            with self.assertRaises(RuntimeError):
                mmrag._cohere_post("key", "/v2/embed", {})

    def test_malformed_embed_response_raises_runtime_error(self):
        """An embed response missing the embeddings key raises RuntimeError with context."""
        clients = FakeClients()
        config = {"embedding_provider": "cohere"}
        with mock.patch.object(mmrag, "_cohere_post") as post:
            post.return_value = {"message": "quota exceeded"}
            with self.assertRaises(RuntimeError):
                mmrag.cohere_embed_texts(clients, config, ["text"], "search_document")


class TestUsageTrackerCohere(unittest.TestCase):
    def test_cohere_embedding_cost(self):
        tracker = mmrag.UsageTracker("test")
        # ~1M tokens of cohere embeddings
        tracker.session["embedding_tokens"] = 1_000_000
        tracker.session["cohere_embedding_tokens"] = 1_000_000
        cost = tracker.cost()
        self.assertAlmostEqual(cost["embedding"], mmrag.COHERE_EMBED_PRICE_PER_M, places=4)

    def test_mixed_provider_embedding_cost(self):
        tracker = mmrag.UsageTracker("test")
        tracker.session["embedding_tokens"] = 2_000_000
        tracker.session["cohere_embedding_tokens"] = 1_000_000
        cost = tracker.cost()
        expected = mmrag.EMBEDDING_PRICE_PER_M + mmrag.COHERE_EMBED_PRICE_PER_M
        self.assertAlmostEqual(cost["embedding"], expected, places=4)

    def test_rerank_cost(self):
        tracker = mmrag.UsageTracker("test")
        for _ in range(100):
            tracker.track_rerank()
        cost = tracker.cost()
        self.assertAlmostEqual(cost["rerank"], 0.1 * mmrag.COHERE_RERANK_PRICE_PER_1K_SEARCHES, places=4)

    def test_cohere_generation_tracking_meta_format(self):
        """v2 chat responses report billing under meta.billed_units."""
        tracker = mmrag.UsageTracker("test")
        tracker.track_cohere_generation({
            "meta": {"billed_units": {"input_tokens": 1000, "output_tokens": 500}},
        })
        self.assertEqual(tracker.session["cohere_generation_input_tokens"], 1000)
        self.assertEqual(tracker.session["cohere_generation_output_tokens"], 500)
        self.assertEqual(tracker.session["generation_calls"], 1)

    def test_cohere_generation_tracking_usage_fallback(self):
        """usage.billed_units is accepted as a forward-compatibility fallback."""
        tracker = mmrag.UsageTracker("test")
        tracker.track_cohere_generation({
            "usage": {"billed_units": {"input_tokens": 200, "output_tokens": 100}},
        })
        self.assertEqual(tracker.session["cohere_generation_input_tokens"], 200)
        self.assertEqual(tracker.session["cohere_generation_output_tokens"], 100)


if __name__ == "__main__":
    unittest.main()
