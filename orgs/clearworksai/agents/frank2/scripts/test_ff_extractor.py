from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
import unittest.mock
from datetime import date
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("ff-extractor.py")
SPEC = importlib.util.spec_from_file_location("ff_extractor_script", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Unable to load ff-extractor.py for tests")
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class FirefliesExtractorTests(unittest.TestCase):
    def make_transcript(self, sentence: str, *, meeting_date: str = "2026-06-08T16:00:00Z") -> dict[str, object]:
        return {
            "id": "meeting_123",
            "title": "Acme Follow Up",
            "date": meeting_date,
            "sentences": [
                {
                    "speaker_name": "Josh Weiss",
                    "text": sentence,
                }
            ],
        }

    def test_refine_keeps_due_based_first_person_commitment(self) -> None:
        transcript = self.make_transcript("I'll send the proposal to Acme by Wednesday.")
        items = [
            MODULE.ExtractedItem(
                action="Send the proposal to Acme",
                owner="Josh",
                due_date="Wednesday",
                status="pending",
            )
        ]

        commitments = MODULE.refine_items(transcript, items)

        self.assertEqual(len(commitments), 1)
        self.assertEqual(commitments[0].text, "Send the proposal to Acme (due 2026-06-10)")
        self.assertEqual(commitments[0].id, MODULE.commitment_id("meeting_123", "Send the proposal to Acme"))
        self.assertEqual(commitments[0].source, "ff")
        self.assertEqual(commitments[0].source_ref, "meeting_123 · Acme Follow Up")

    def test_refine_keeps_named_counterparty_without_due(self) -> None:
        transcript = self.make_transcript("Let me call Sara about the contract this afternoon.")
        items = [
            MODULE.ExtractedItem(
                action="Call Sara about the contract",
                owner="Josh Weiss",
                due_date="",
                status="pending",
            )
        ]

        commitments = MODULE.refine_items(transcript, items)

        self.assertEqual(len(commitments), 1)
        self.assertEqual(commitments[0].text, "Call Sara about the contract")

    def test_refine_keeps_llm_assigned_josh_owner_without_verbatim_first_person(self) -> None:
        # We now trust the model's owner=Josh assignment rather than requiring a
        # verbatim "I'll" sentence; a concrete Josh item with a due date is kept.
        transcript = self.make_transcript("Josh should send the proposal to Acme by Wednesday.")
        items = [
            MODULE.ExtractedItem(
                action="Send the proposal to Acme",
                owner="Josh",
                due_date="Wednesday",
                status="pending",
            )
        ]

        commitments = MODULE.refine_items(transcript, items)

        self.assertEqual(len(commitments), 1)
        self.assertEqual(commitments[0].text, "Send the proposal to Acme (due 2026-06-10)")

    def test_refine_drops_already_handled_in_meeting(self) -> None:
        transcript = self.make_transcript("I introduced Rachel to the cyber insurance contact just now.")
        items = [
            MODULE.ExtractedItem(
                action="Introduce Rachel to cyber insurance contacts",
                owner="Josh",
                due_date="During meeting (completed verbally)",
                status="pending",
            )
        ]

        commitments = MODULE.refine_items(transcript, items)

        self.assertEqual(commitments, [])

    def test_refine_drops_vague_software_commitment(self) -> None:
        transcript = self.make_transcript("I will improve the software by Friday.")
        items = [
            MODULE.ExtractedItem(
                action="Improve the software",
                owner="Josh",
                due_date="Friday",
                status="pending",
            )
        ]

        commitments = MODULE.refine_items(transcript, items)

        self.assertEqual(commitments, [])

    def test_refine_drops_considering_mexico(self) -> None:
        transcript = self.make_transcript("I'm considering Mexico for later this year.")
        items = [
            MODULE.ExtractedItem(
                action="Consider Mexico",
                owner="Josh",
                due_date="",
                status="pending",
            )
        ]

        commitments = MODULE.refine_items(transcript, items)

        self.assertEqual(commitments, [])

    def test_commitment_id_is_deterministic_after_normalization(self) -> None:
        first = MODULE.commitment_id("meeting_123", "Call Sara about the contract")
        second = MODULE.commitment_id("meeting_123", "  call  Sara about the contract!!! ")

        self.assertEqual(first, second)
        self.assertRegex(first, r"^ff_meeting_123_[0-9a-f]{12}$")

    def test_resolve_due_date_supports_relative_terms(self) -> None:
        meeting_day = date(2026, 6, 8)

        self.assertEqual(MODULE.resolve_due_date("tomorrow", meeting_day), "2026-06-09")
        self.assertEqual(MODULE.resolve_due_date("Wednesday", meeting_day), "2026-06-10")
        self.assertEqual(MODULE.resolve_due_date("next Wednesday", meeting_day), "2026-06-10")
        self.assertIsNone(MODULE.resolve_due_date("later soon", meeting_day))

    def test_outbound_metadata_unchanged(self) -> None:
        transcript = self.make_transcript("I'll send the proposal to Acme by Wednesday.")
        items = [
            MODULE.ExtractedItem(
                action="Send the proposal to Acme",
                owner="Josh",
                due_date="Wednesday",
                status="pending",
            )
        ]

        commitments = MODULE.refine_items(transcript, items)

        self.assertEqual(len(commitments), 1)
        self.assertEqual(commitments[0].direction, "outbound")
        self.assertEqual(commitments[0].source, "ff")
        self.assertTrue(commitments[0].id.startswith("ff_"))
        self.assertFalse(commitments[0].id.startswith("ffin_"))


class FakeResponse:
    def __init__(self, body: bytes, status: int = 200) -> None:
        self._body = body
        self.status = status

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *args: object) -> bool:
        return False


class InboundDirectionTests(unittest.TestCase):
    def make_transcript(self) -> dict[str, object]:
        return {
            "id": "meeting_123",
            "title": "Acme Follow Up",
            "date": "2026-06-08T16:00:00Z",
            "sentences": [
                {
                    "speaker_name": "Josh Weiss",
                    "text": "Sounds good, send it over when it's ready.",
                }
            ],
        }

    def test_inbound_kept_for_named_client_committing_to_josh(self) -> None:
        items = [
            MODULE.ExtractedItem(
                action="Send Josh the signed contract",
                owner="Sara",
                due_date="tomorrow",
                status="pending",
            )
        ]

        commitments = MODULE.refine_items(self.make_transcript(), items)

        self.assertEqual(len(commitments), 1)
        commitment = commitments[0]
        self.assertEqual(commitment.direction, "inbound")
        self.assertEqual(commitment.source, "ff-inbound")
        self.assertTrue(commitment.id.startswith("ffin_"))
        self.assertEqual(commitment.text, "[inbound] Sara: Send Josh the signed contract (due 2026-06-09)")
        self.assertEqual(commitment.source_ref, "meeting_123 · Acme Follow Up")

    def test_inbound_dropped_for_generic_owners(self) -> None:
        for owner in ("Unassigned", "the team", "Team", "everyone", "Client", "we", "they", ""):
            items = [
                MODULE.ExtractedItem(
                    action="Send Josh the signed contract",
                    owner=owner,
                    due_date="tomorrow",
                    status="pending",
                )
            ]

            commitments = MODULE.refine_items(self.make_transcript(), items)

            self.assertEqual(commitments, [], f"owner {owner!r} should be dropped")

    def test_inbound_dropped_for_vague_action(self) -> None:
        items = [
            MODULE.ExtractedItem(
                action="Look into the contract for Josh",
                owner="Sara",
                due_date="tomorrow",
                status="pending",
            )
        ]

        commitments = MODULE.refine_items(self.make_transcript(), items)

        self.assertEqual(commitments, [])

    def test_inbound_dropped_without_josh_tie(self) -> None:
        items = [
            MODULE.ExtractedItem(
                action="Send the deck to Rachel",
                owner="Sara",
                due_date="later sometime",
                status="pending",
            )
        ]

        commitments = MODULE.refine_items(self.make_transcript(), items)

        self.assertEqual(commitments, [])

    def test_inbound_dropped_when_already_handled(self) -> None:
        items = [
            MODULE.ExtractedItem(
                action="Send Josh the signed contract",
                owner="Sara",
                due_date="During meeting (completed verbally)",
                status="pending",
            )
        ]

        commitments = MODULE.refine_items(self.make_transcript(), items)

        self.assertEqual(commitments, [])

    def test_marcos_suppressed_in_both_directions(self) -> None:
        outbound_items = [
            MODULE.ExtractedItem(
                action="Send proposal to Marcos Santa Ana",
                owner="Josh",
                due_date="Wednesday",
                status="pending",
            )
        ]
        inbound_items = [
            MODULE.ExtractedItem(
                action="Send Josh the revised scope",
                owner="Marcos Santa Ana",
                due_date="tomorrow",
                status="pending",
            )
        ]

        self.assertEqual(MODULE.refine_items(self.make_transcript(), outbound_items), [])
        self.assertEqual(MODULE.refine_items(self.make_transcript(), inbound_items), [])

    def test_inbound_and_outbound_ids_differ_for_same_action(self) -> None:
        action = "Send the signed contract"
        outbound_id = MODULE.directional_commitment_id("meeting_123", action, "outbound")
        inbound_id = MODULE.directional_commitment_id("meeting_123", action, "inbound")

        self.assertNotEqual(outbound_id, inbound_id)
        self.assertEqual(outbound_id, MODULE.commitment_id("meeting_123", action))
        self.assertRegex(outbound_id, r"^ff_meeting_123_[0-9a-f]{12}$")
        self.assertRegex(inbound_id, r"^ffin_meeting_123_[0-9a-f]{12}$")

    def test_post_commitments_includes_direction(self) -> None:
        captured: dict[str, object] = {}

        def fake_urlopen(request: object, timeout: int | None = None) -> FakeResponse:
            captured["body"] = json.loads(request.data.decode("utf-8"))
            return FakeResponse(b'{"ok": true}')

        commitments = [
            MODULE.RefinedCommitment(
                id="ff_meeting_123_abcdefabcdef",
                text="Send the proposal to Acme (due 2026-06-10)",
                source="ff",
                source_ref="meeting_123 · Acme Follow Up",
                direction="outbound",
            ),
            MODULE.RefinedCommitment(
                id="ffin_meeting_123_abcdefabcdef",
                text="[inbound] Sara: Send Josh the signed contract (due 2026-06-09)",
                source="ff-inbound",
                source_ref="meeting_123 · Acme Follow Up",
                direction="inbound",
            ),
        ]

        result = MODULE.post_commitments(
            ingest_url="https://briefs.example/api/tasks/ingest",
            ingest_token="token",
            commitments=commitments,
            urlopen=fake_urlopen,
        )

        self.assertEqual(result, {"ok": True})
        sent = captured["body"]["commitments"]
        self.assertEqual(len(sent), 2)
        for entry in sent:
            self.assertEqual(set(entry), {"id", "text", "direction", "source", "sourceRef"})
        self.assertEqual(sent[0]["direction"], "outbound")
        self.assertEqual(sent[1]["direction"], "inbound")


class RunStdoutContractTests(unittest.TestCase):
    ENV = {
        "FIREFLIES_API_KEY": "ff-test",
        "ANTHROPIC_API_KEY": "an-test",
        "BRIEFS_INGEST_URL": "https://briefs.example/api/tasks/ingest",
        "TASKS_INGEST_TOKEN": "tok-test",
    }

    def make_urlopen(self, transcripts: list[dict[str, object]], calls: list[str]):
        def fake_urlopen(request: object, timeout: int | None = None) -> FakeResponse:
            url = request.full_url
            calls.append(url)
            if "fireflies" in url:
                body: dict[str, object] = {"data": {"transcripts": transcripts}}
            elif "anthropic" in url:
                prompt = json.loads(request.data.decode("utf-8"))["messages"][0]["content"]
                if prompt.startswith("Extract action items"):
                    body = {
                        "content": [
                            {
                                "type": "text",
                                "text": json.dumps(
                                    [
                                        {
                                            "action": "Send the proposal to Acme",
                                            "owner": "Josh",
                                            "dueDate": "tomorrow",
                                            "status": "pending",
                                        },
                                        {
                                            "action": "Send Josh the signed contract",
                                            "owner": "Sara",
                                            "dueDate": "tomorrow",
                                            "status": "pending",
                                        },
                                    ]
                                ),
                            }
                        ]
                    }
                else:
                    body = {"content": [{"type": "text", "text": json.dumps({"is_casual": False})}]}
            else:
                body = {"ok": True}
            return FakeResponse(json.dumps(body).encode("utf-8"))

        return fake_urlopen

    def make_transcript(self) -> dict[str, object]:
        return {
            "id": "meeting_123",
            "title": "Acme Follow Up",
            "date": "2026-06-08T16:00:00Z",
            "sentences": [
                {
                    "speaker_name": "Josh Weiss",
                    "text": "I'll send the proposal to Acme tomorrow.",
                }
            ],
        }

    def run_and_capture(self, transcripts: list[dict[str, object]], *, dry_run: bool) -> tuple[dict[str, object], list[str], Path]:
        calls: list[str] = []
        with tempfile.TemporaryDirectory() as tmp:
            watermark_path = Path(tmp) / "watermark.json"
            stdout = io.StringIO()
            with unittest.mock.patch.dict(os.environ, self.ENV):
                with contextlib.redirect_stdout(stdout):
                    exit_code = MODULE.run(
                        limit=5,
                        dry_run=dry_run,
                        watermark_path=watermark_path,
                        urlopen=self.make_urlopen(transcripts, calls),
                    )
            self.assertEqual(exit_code, 0)
            watermark_exists = watermark_path.exists()
        printed = json.loads(stdout.getvalue())
        printed["_watermark_exists"] = watermark_exists
        return printed, calls, watermark_path

    def assert_items_shape(self, items: list[dict[str, object]]) -> None:
        for entry in items:
            self.assertEqual(set(entry), {"id", "text", "direction", "source", "sourceRef"})

    def test_no_fresh_transcripts_prints_empty_items(self) -> None:
        printed, calls, _ = self.run_and_capture([], dry_run=False)

        self.assertEqual(printed["items"], [])
        self.assertEqual(printed["meetings"], 0)
        self.assertFalse(printed["posted"])
        self.assertFalse(any("briefs.example" in url for url in calls))

    def test_dry_run_prints_items_and_does_not_post_or_advance_watermark(self) -> None:
        printed, calls, _ = self.run_and_capture([self.make_transcript()], dry_run=True)

        self.assertTrue(printed["dry_run"])
        self.assertEqual(len(printed["items"]), 2)
        self.assert_items_shape(printed["items"])
        directions = {entry["direction"] for entry in printed["items"]}
        self.assertEqual(directions, {"outbound", "inbound"})
        self.assertFalse(any("briefs.example" in url for url in calls))
        self.assertFalse(printed["_watermark_exists"])

    def test_dry_run_succeeds_with_ingest_env_unset(self) -> None:
        # SKILL DEGRADED path: BRIEFS_INGEST_URL / TASKS_INGEST_TOKEN missing →
        # --dry-run must still run extract-only (exit 0, items printed, no POST).
        calls: list[str] = []
        degraded_env = {
            "FIREFLIES_API_KEY": "ff-test",
            "ANTHROPIC_API_KEY": "an-test",
        }
        with tempfile.TemporaryDirectory() as tmp:
            watermark_path = Path(tmp) / "watermark.json"
            stdout = io.StringIO()
            with unittest.mock.patch.dict(os.environ, degraded_env, clear=True):
                self.assertNotIn("BRIEFS_INGEST_URL", os.environ)
                self.assertNotIn("TASKS_INGEST_TOKEN", os.environ)
                with contextlib.redirect_stdout(stdout):
                    exit_code = MODULE.run(
                        limit=5,
                        dry_run=True,
                        watermark_path=watermark_path,
                        urlopen=self.make_urlopen([self.make_transcript()], calls),
                    )
            self.assertEqual(exit_code, 0)
            self.assertFalse(watermark_path.exists())

        printed = json.loads(stdout.getvalue())
        self.assertTrue(printed["dry_run"])
        self.assertEqual(len(printed["items"]), 2)
        self.assert_items_shape(printed["items"])
        self.assertFalse(any("briefs.example" in url for url in calls))

    def test_non_dry_run_still_requires_ingest_env(self) -> None:
        degraded_env = {
            "FIREFLIES_API_KEY": "ff-test",
            "ANTHROPIC_API_KEY": "an-test",
        }
        with tempfile.TemporaryDirectory() as tmp:
            watermark_path = Path(tmp) / "watermark.json"
            with unittest.mock.patch.dict(os.environ, degraded_env, clear=True):
                with self.assertRaises(ValueError):
                    MODULE.run(
                        limit=5,
                        dry_run=False,
                        watermark_path=watermark_path,
                        urlopen=self.make_urlopen([self.make_transcript()], []),
                    )

    def test_noop_print_includes_items_array(self) -> None:
        calls: list[str] = []

        def casual_urlopen(request: object, timeout: int | None = None) -> FakeResponse:
            url = request.full_url
            calls.append(url)
            if "fireflies" in url:
                body: dict[str, object] = {"data": {"transcripts": [self.make_transcript()]}}
            elif "anthropic" in url:
                body = {"content": [{"type": "text", "text": json.dumps({"is_casual": True})}]}
            else:
                body = {"ok": True}
            return FakeResponse(json.dumps(body).encode("utf-8"))

        with tempfile.TemporaryDirectory() as tmp:
            watermark_path = Path(tmp) / "watermark.json"
            stdout = io.StringIO()
            with unittest.mock.patch.dict(os.environ, self.ENV):
                with contextlib.redirect_stdout(stdout):
                    exit_code = MODULE.run(limit=5, dry_run=False, watermark_path=watermark_path, urlopen=casual_urlopen)
            self.assertEqual(exit_code, 0)

        printed = json.loads(stdout.getvalue())
        self.assertTrue(printed["noop"])
        self.assertEqual(printed["items"], [])
        self.assertFalse(any("briefs.example" in url for url in calls))

    def test_posted_print_includes_items(self) -> None:
        printed, calls, _ = self.run_and_capture([self.make_transcript()], dry_run=False)

        self.assertTrue(printed["posted"])
        self.assertEqual(len(printed["items"]), 2)
        self.assert_items_shape(printed["items"])
        sources = {entry["source"] for entry in printed["items"]}
        self.assertEqual(sources, {"ff", "ff-inbound"})
        self.assertTrue(any("briefs.example" in url for url in calls))
        self.assertTrue(printed["_watermark_exists"])


if __name__ == "__main__":
    unittest.main()
