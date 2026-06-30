#!/usr/bin/env python3
"""
Unit tests for mmrag.py contextual chunking (markdown-aware sections +
document-identity headers).

Stdlib-only (unittest) — no chromadb/google-genai/network required:

    python3 -m unittest test_mmrag -v
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import mmrag


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

if __name__ == "__main__":
    unittest.main()
