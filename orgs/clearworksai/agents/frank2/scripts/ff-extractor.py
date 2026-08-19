#!/usr/bin/env python3
"""Extract high-confidence Josh commitments from recent Fireflies transcripts."""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import re
import tempfile
import unicodedata
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path
from typing import Any, Callable, Iterable


LOGGER = logging.getLogger(__name__)
SCRIPT_PATH = Path(__file__).resolve()
AGENT_DIR = SCRIPT_PATH.parent.parent
STATE_DIR = AGENT_DIR / "state"
DEFAULT_WATERMARK_PATH = STATE_DIR / "ff-extractor-watermark.json"
DEFAULT_TRANSCRIPT_LIMIT = 20
FIREFLIES_API_URL = "https://api.fireflies.ai/graphql"
ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"
CLASSIFIER_MODEL = os.environ.get("FF_CLASSIFIER_MODEL", "claude-haiku-4-5")
EXTRACTOR_MODEL = os.environ.get("FF_EXTRACTOR_MODEL", "claude-sonnet-4-5")
CLASSIFIER_MAX_CHARS = 24000
EXTRACTOR_MAX_CHARS = 48000
TRANSCRIPT_FIELDS = """
  id
  title
  date
  duration
  organizer_email
  participants
  speakers {
    id
    name
  }
  summary {
    overview
    shorthand_bullet
    action_items
    keywords
  }
  transcript_url
  sentences {
    speaker_id
    speaker_name
    text
    raw_text
    start_time
    end_time
  }
"""
CLASSIFIER_PROMPT = """Analyze this meeting transcript for actionable commitments.

TRANSCRIPT:
{transcript}

Return a JSON object with exactly these fields:
{{
  "contacts_mentioned": ["Full Name"],
  "extractions": [
    {{
      "category": "action_item" | "decision" | "follow_up",
      "content": "Clear one-sentence description",
      "owner": "Person name if assigned (optional)"
    }}
  ],
  "is_casual": true | false
}}

Rules:
- is_casual=true for: greetings, definitions, general questions, factual answers, summaries with no commitments
- is_casual=false only when: specific action items, decisions made, or follow-ups committed to
- contacts_mentioned: only real people by name (not "the team", "everyone", "the client")
- Keep extractions specific and actionable — vague statements are not extractions
- Return valid JSON only, no markdown"""
ACTION_ITEMS_PROMPT = """Extract action items from this meeting transcript.
Identify every task, commitment, follow-up, or to-do mentioned. Be specific — "send the proposal" is better than "follow up."
Only include forward-looking work or business commitments that still need to be done AFTER the meeting ends. Exclude personal or social errands (e.g. saying goodbye, returning home, travel logistics), small talk, and anything that was already completed during the meeting itself.
For each action item:
- Clear, actionable description of what needs to be done
- Owner: person responsible (or "Unassigned" if not specified)
- Due date or timeframe if mentioned
- Status: pending
No artificial limit on count. Zero acceptable if none found.
IMPORTANT: Return ONLY a valid JSON array with objects using exactly these fields:
"action","owner","dueDate","status".
Example: [{{"action":"Send proposal to client","owner":"John","dueDate":"2026-02-20","status":"pending"}}]

TRANSCRIPT:
{transcript}"""
PUNCT_RE = re.compile(r"[^\w\s-]+", re.UNICODE)
SPACE_RE = re.compile(r"\s+")
TOKEN_RE = re.compile(r"[a-z0-9]+")
CONTROL_RE = re.compile(r"[\x00-\x1f]")
WEEKDAY_TO_INDEX = {
    "monday": 0,
    "tuesday": 1,
    "wednesday": 2,
    "thursday": 3,
    "friday": 4,
    "saturday": 5,
    "sunday": 6,
}
STOPWORDS = {
    "a",
    "an",
    "and",
    "at",
    "by",
    "for",
    "from",
    "i",
    "in",
    "it",
    "let",
    "me",
    "of",
    "on",
    "our",
    "the",
    "to",
    "we",
    "with",
    "you",
}
VAGUE_ACTION_PREFIXES = (
    "consider",
    "considering",
    "explore",
    "exploring",
    "figure out",
    "improve",
    "investigate",
    "look into",
    "think about",
    "work on",
)
# Fleet rule: Marcos Santa Ana is a hard-no — must never become a task or ping.
SUPPRESSED_NAMES = ("marcos", "santa ana")
# Owner strings that are not a concrete named person — never inbound-worthy.
GENERIC_OWNERS = {"", "unassigned", "team", "the team", "everyone", "client", "we", "they"}
COUNTERPARTY_RE = re.compile(
    r"\b(?:call|email|text|send|share|follow up with|ask|tell|schedule with|meet with)\s+([A-Z][A-Za-z0-9&.-]*(?:\s+[A-Z][A-Za-z0-9&.-]*){0,3})\b"
    r"|\b(?:to|with|for)\s+([A-Z][A-Za-z0-9&.-]*(?:\s+[A-Z][A-Za-z0-9&.-]*){0,3})\b"
)

Urlopen = Callable[..., Any]


@dataclass(frozen=True)
class ExtractedItem:
    action: str
    owner: str
    due_date: str
    status: str


@dataclass(frozen=True)
class RefinedCommitment:
    id: str
    text: str
    source: str
    source_ref: str
    direction: str


def now_utc_iso() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def collapse_ws(value: str) -> str:
    return SPACE_RE.sub(" ", value).strip()


def normalize_action(value: str) -> str:
    normalized = unicodedata.normalize("NFC", value)
    normalized = PUNCT_RE.sub(" ", normalized.lower())
    normalized = collapse_ws(normalized)
    return normalized


def action_hash(value: str) -> str:
    return hashlib.sha256(normalize_action(value).encode("utf-8")).hexdigest()[:12]


def commitment_id(meeting_id: str, action: str) -> str:
    return f"ff_{meeting_id}_{action_hash(action)}"


def directional_commitment_id(meeting_id: str, action: str, direction: str) -> str:
    if direction == "inbound":
        return f"ffin_{meeting_id}_{action_hash(action)}"
    return commitment_id(meeting_id, action)


def normalize_json_text(value: str) -> str:
    return CONTROL_RE.sub("", value.replace("```json", "").replace("```", "")).strip()


def parse_json_payload(value: str) -> Any:
    cleaned = normalize_json_text(value)
    return json.loads(cleaned)


def parse_extracted_items(value: str) -> list[ExtractedItem]:
    payload = parse_json_payload(value)
    if not isinstance(payload, list):
        return []
    items: list[ExtractedItem] = []
    for item in payload:
        if not isinstance(item, dict):
            continue
        action = collapse_ws(str(item.get("action") or ""))
        owner = collapse_ws(str(item.get("owner") or ""))
        due_date = collapse_ws(str(item.get("dueDate") or ""))
        status = collapse_ws(str(item.get("status") or "pending")) or "pending"
        if action:
            items.append(ExtractedItem(action=action, owner=owner, due_date=due_date, status=status))
    return items


def build_transcript_text(sentences: Iterable[dict[str, Any]], *, limit: int) -> str:
    lines: list[str] = []
    size = 0
    for sentence in sentences:
        speaker = collapse_ws(str(sentence.get("speaker_name") or "Unknown"))
        text = collapse_ws(str(sentence.get("text") or sentence.get("raw_text") or ""))
        if not text:
            continue
        line = f"{speaker}: {text}"
        size += len(line) + 1
        if size > limit:
            break
        lines.append(line)
    return "\n".join(lines)


def parse_transcript_datetime(raw_value: Any) -> datetime | None:
    if isinstance(raw_value, (int, float)):
        timestamp = float(raw_value)
        if timestamp > 1_000_000_000_000:
            timestamp = timestamp / 1000.0
        return datetime.fromtimestamp(timestamp, UTC)
    if isinstance(raw_value, str):
        text = raw_value.strip()
        if not text:
            return None
        if text.isdigit():
            return parse_transcript_datetime(int(text))
        try:
            return datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone(UTC)
        except ValueError:
            return None
    return None


def transcript_sort_key(transcript: dict[str, Any]) -> tuple[datetime, str]:
    ts = parse_transcript_datetime(transcript.get("date")) or datetime.fromtimestamp(0, UTC)
    return ts, str(transcript.get("id") or "")


def load_watermark(path: Path) -> tuple[datetime | None, str | None]:
    if not path.exists():
        return None, None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None, None
    if not isinstance(payload, dict):
        return None, None
    timestamp = parse_transcript_datetime(payload.get("timestamp"))
    meeting_id = payload.get("meeting_id")
    return timestamp, str(meeting_id) if isinstance(meeting_id, str) and meeting_id else None


def save_watermark(path: Path, transcript: dict[str, Any]) -> None:
    timestamp = parse_transcript_datetime(transcript.get("date"))
    if timestamp is None:
        return
    payload = {
        "timestamp": timestamp.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "meeting_id": str(transcript.get("id") or ""),
        "updated_at": now_utc_iso(),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        dir=path.parent,
        prefix=f"{path.name}.",
        suffix=".tmp",
        delete=False,
    ) as handle:
        json.dump(payload, handle, indent=2)
        handle.write("\n")
        temp_path = Path(handle.name)
    os.replace(temp_path, path)


def is_newer_than_watermark(
    transcript: dict[str, Any],
    watermark_timestamp: datetime | None,
    watermark_meeting_id: str | None,
) -> bool:
    if watermark_timestamp is None:
        return True
    ts, meeting_id = transcript_sort_key(transcript)
    if ts > watermark_timestamp:
        return True
    if ts < watermark_timestamp:
        return False
    if watermark_meeting_id is None:
        return True
    return meeting_id > watermark_meeting_id


def select_recent_transcripts(
    transcripts: list[dict[str, Any]],
    watermark_timestamp: datetime | None,
    watermark_meeting_id: str | None,
    *,
    limit: int,
) -> list[dict[str, Any]]:
    ordered = sorted(transcripts, key=transcript_sort_key)
    fresh = [
        transcript
        for transcript in ordered
        if is_newer_than_watermark(transcript, watermark_timestamp, watermark_meeting_id)
    ]
    return fresh[:limit]


def fireflies_graphql(
    api_key: str,
    query: str,
    variables: dict[str, Any],
    *,
    urlopen: Urlopen = urllib.request.urlopen,
) -> dict[str, Any]:
    request = urllib.request.Request(
        FIREFLIES_API_URL,
        data=json.dumps({"query": query, "variables": variables}).encode("utf-8"),
        method="POST",
    )
    request.add_header("Content-Type", "application/json")
    request.add_header("Authorization", f"Bearer {api_key}")
    with urlopen(request, timeout=30) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Fireflies response was not an object")
    errors = payload.get("errors")
    if errors:
        raise ValueError(f"Fireflies GraphQL error: {errors}")
    data = payload.get("data")
    if not isinstance(data, dict):
        raise ValueError("Fireflies response missing data")
    return data


def fetch_recent_transcripts(
    api_key: str,
    *,
    limit: int,
    urlopen: Urlopen = urllib.request.urlopen,
) -> list[dict[str, Any]]:
    query = f"query($limit: Int, $skip: Int) {{ transcripts(limit: $limit, skip: $skip) {{ {TRANSCRIPT_FIELDS} }} }}"
    data = fireflies_graphql(api_key, query, {"limit": max(limit, 20), "skip": 0}, urlopen=urlopen)
    transcripts = data.get("transcripts")
    if not isinstance(transcripts, list):
        return []
    return [item for item in transcripts if isinstance(item, dict)]


def anthropic_request(
    api_key: str,
    *,
    model: str,
    prompt: str,
    max_tokens: int,
    urlopen: Urlopen = urllib.request.urlopen,
) -> str:
    body = {
        "model": model,
        "max_tokens": max_tokens,
        "temperature": 0,
        "messages": [{"role": "user", "content": prompt}],
    }
    request = urllib.request.Request(
        ANTHROPIC_API_URL,
        data=json.dumps(body).encode("utf-8"),
        method="POST",
    )
    request.add_header("Content-Type", "application/json")
    request.add_header("x-api-key", api_key)
    request.add_header("anthropic-version", "2023-06-01")
    with urlopen(request, timeout=60) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Anthropic response was not an object")
    content = payload.get("content")
    if not isinstance(content, list):
        raise ValueError("Anthropic response missing content")
    texts = [item.get("text", "") for item in content if isinstance(item, dict) and item.get("type") == "text"]
    return "\n".join(texts).strip()


def is_casual_transcript(
    transcript_text: str,
    *,
    anthropic_api_key: str,
    urlopen: Urlopen = urllib.request.urlopen,
) -> bool:
    response_text = anthropic_request(
        anthropic_api_key,
        model=CLASSIFIER_MODEL,
        prompt=CLASSIFIER_PROMPT.format(transcript=transcript_text),
        max_tokens=1024,
        urlopen=urlopen,
    )
    try:
        payload = parse_json_payload(response_text)
    except ValueError:
        return True
    if not isinstance(payload, dict):
        return True
    return bool(payload.get("is_casual"))


def extract_action_items(
    transcript_text: str,
    *,
    anthropic_api_key: str,
    urlopen: Urlopen = urllib.request.urlopen,
) -> list[ExtractedItem]:
    response_text = anthropic_request(
        anthropic_api_key,
        model=EXTRACTOR_MODEL,
        prompt=ACTION_ITEMS_PROMPT.format(transcript=transcript_text),
        max_tokens=2400,
        urlopen=urlopen,
    )
    try:
        return parse_extracted_items(response_text)
    except ValueError:
        return []


def normalized_tokens(value: str) -> set[str]:
    return {token for token in TOKEN_RE.findall(normalize_action(value)) if token and token not in STOPWORDS}


def is_josh_owner(owner: str) -> bool:
    normalized = normalize_action(owner)
    return normalized in {"josh", "josh weiss", "me", "i", "myself"}


def extract_josh_sentences(transcript: dict[str, Any]) -> list[str]:
    sentences = transcript.get("sentences")
    if not isinstance(sentences, list):
        return []
    collected: list[str] = []
    for sentence in sentences:
        if not isinstance(sentence, dict):
            continue
        speaker = normalize_action(str(sentence.get("speaker_name") or ""))
        if "josh" not in speaker:
            continue
        text = collapse_ws(str(sentence.get("text") or sentence.get("raw_text") or ""))
        if text:
            collected.append(text)
    return collected


def best_support_sentence(action: str, josh_sentences: list[str]) -> str | None:
    action_tokens = normalized_tokens(action)
    if not action_tokens:
        return None
    best_text: str | None = None
    best_score = 0
    for sentence in josh_sentences:
        score = len(action_tokens & normalized_tokens(sentence))
        if score > best_score:
            best_score = score
            best_text = sentence
    if best_score < 2:
        return None
    return best_text


def resolve_due_date(raw_due: str, meeting_day: date) -> str | None:
    due = collapse_ws(raw_due)
    if not due:
        return None
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", due):
        return due
    lowered = due.lower()
    if lowered == "today":
        return meeting_day.isoformat()
    if lowered == "tomorrow":
        return (meeting_day + timedelta(days=1)).isoformat()
    next_match = re.fullmatch(r"next\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)", lowered)
    if next_match:
        target = WEEKDAY_TO_INDEX[next_match.group(1)]
        delta = (target - meeting_day.weekday()) % 7
        delta = 7 if delta == 0 else delta
        return (meeting_day + timedelta(days=delta)).isoformat()
    weekday_match = re.fullmatch(r"(monday|tuesday|wednesday|thursday|friday|saturday|sunday)", lowered)
    if weekday_match:
        target = WEEKDAY_TO_INDEX[weekday_match.group(1)]
        delta = (target - meeting_day.weekday()) % 7
        return (meeting_day + timedelta(days=delta)).isoformat()
    return None


def has_concrete_action(action: str) -> bool:
    normalized = normalize_action(action)
    if not normalized:
        return False
    return not any(normalized.startswith(prefix) for prefix in VAGUE_ACTION_PREFIXES)


HANDLED_DUE_MARKERS = (
    "this meeting",
    "during meeting",
    "during the meeting",
    "in meeting",
    "in the meeting",
    "completed verbally",
    "completed",
    "actioned",
    "already done",
    "immediate",
)


def is_already_handled(raw_due: str) -> bool:
    normalized = normalize_action(raw_due)
    if not normalized:
        return False
    return any(marker in normalized for marker in HANDLED_DUE_MARKERS)


def extract_counterparty(text: str) -> str | None:
    for match in COUNTERPARTY_RE.finditer(text):
        candidate = collapse_ws(match.group(1) or match.group(2) or "")
        if candidate:
            return candidate
    return None


def is_suppressed(owner: str, action: str, counterparty: str | None) -> bool:
    haystacks = [normalize_action(owner), normalize_action(action)]
    if counterparty:
        haystacks.append(normalize_action(counterparty))
    return any(name in haystack for haystack in haystacks for name in SUPPRESSED_NAMES)


def meeting_day_from_transcript(transcript: dict[str, Any]) -> date:
    ts = parse_transcript_datetime(transcript.get("date"))
    if ts is None:
        return datetime.now().astimezone().date()
    return ts.astimezone().date()


def build_commitment_text(action: str, due: str | None) -> str:
    if due:
        return f"{action} (due {due})"
    return action


def refine_outbound_item(
    item: ExtractedItem,
    *,
    meeting_id: str,
    meeting_day: date,
    josh_sentences: list[str],
    source_ref: str,
) -> RefinedCommitment | None:
    if not has_concrete_action(item.action):
        return None
    if is_already_handled(item.due_date):
        return None
    due = resolve_due_date(item.due_date, meeting_day)
    support = best_support_sentence(item.action, josh_sentences)
    counterparty = extract_counterparty(item.action) or (
        extract_counterparty(support) if support else None
    )
    if due is None and counterparty is None:
        return None
    if is_suppressed(item.owner, item.action, counterparty):
        return None
    return RefinedCommitment(
        id=commitment_id(meeting_id, item.action),
        text=build_commitment_text(item.action, due),
        source="ff",
        source_ref=source_ref,
        direction="outbound",
    )


def refine_inbound_item(
    item: ExtractedItem,
    *,
    meeting_id: str,
    meeting_day: date,
    source_ref: str,
) -> RefinedCommitment | None:
    # Conservative inbound gate (client → Josh): concrete named owner only.
    if normalize_action(item.owner) in GENERIC_OWNERS:
        return None
    if not has_concrete_action(item.action):
        return None
    if is_already_handled(item.due_date):
        return None
    due = resolve_due_date(item.due_date, meeting_day)
    counterparty = extract_counterparty(item.action)
    josh_tied = (
        "josh" in normalized_tokens(item.action)
        or (counterparty is not None and "josh" in normalize_action(counterparty))
        or due is not None
    )
    if not josh_tied:
        return None
    if is_suppressed(item.owner, item.action, counterparty):
        return None
    return RefinedCommitment(
        id=directional_commitment_id(meeting_id, item.action, "inbound"),
        text=build_commitment_text(f"[inbound] {item.owner}: {item.action}", due),
        source="ff-inbound",
        source_ref=source_ref,
        direction="inbound",
    )


def refine_items(
    transcript: dict[str, Any],
    extracted_items: list[ExtractedItem],
) -> list[RefinedCommitment]:
    meeting_id = str(transcript.get("id") or "")
    title = collapse_ws(str(transcript.get("title") or "Untitled Meeting"))
    if not meeting_id:
        return []
    josh_sentences = extract_josh_sentences(transcript)
    meeting_day = meeting_day_from_transcript(transcript)
    source_ref = f"{meeting_id} · {title}"
    commitments: list[RefinedCommitment] = []
    seen_ids: set[str] = set()

    for item in extracted_items:
        if is_josh_owner(item.owner):
            commitment = refine_outbound_item(
                item,
                meeting_id=meeting_id,
                meeting_day=meeting_day,
                josh_sentences=josh_sentences,
                source_ref=source_ref,
            )
        else:
            commitment = refine_inbound_item(
                item,
                meeting_id=meeting_id,
                meeting_day=meeting_day,
                source_ref=source_ref,
            )
        if commitment is None or commitment.id in seen_ids:
            continue
        seen_ids.add(commitment.id)
        commitments.append(commitment)
    return commitments


def commitment_payload_entries(commitments: list[RefinedCommitment]) -> list[dict[str, str]]:
    return [
        {
            "id": item.id,
            "text": item.text,
            "direction": item.direction,
            "source": item.source,
            "sourceRef": item.source_ref,
        }
        for item in commitments
    ]


def post_commitments(
    *,
    ingest_url: str,
    ingest_token: str,
    commitments: list[RefinedCommitment],
    urlopen: Urlopen = urllib.request.urlopen,
) -> dict[str, Any]:
    request = urllib.request.Request(
        ingest_url,
        data=json.dumps({"commitments": commitment_payload_entries(commitments)}).encode("utf-8"),
        method="POST",
    )
    request.add_header("Content-Type", "application/json")
    request.add_header("x-api-key", ingest_token)
    with urlopen(request, timeout=30) as response:
        status = getattr(response, "status", 200)
        payload = json.loads(response.read().decode("utf-8"))
    if status != 200:
        raise ValueError(f"ingest endpoint returned {status}")
    if not isinstance(payload, dict):
        raise ValueError("ingest endpoint response was not an object")
    return payload


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ValueError(f"missing required env: {name}")
    return value


def run(
    *,
    limit: int,
    dry_run: bool,
    watermark_path: Path,
    urlopen: Urlopen = urllib.request.urlopen,
) -> int:
    fireflies_api_key = require_env("FIREFLIES_API_KEY")
    anthropic_api_key = require_env("ANTHROPIC_API_KEY")
    # Ingest env is only required on the actual POST path. The SKILL's DEGRADED
    # fallback deliberately invokes --dry-run precisely when these are missing,
    # so dry-run must not fail on them.
    ingest_url = ""
    ingest_token = ""
    if not dry_run:
        ingest_url = require_env("BRIEFS_INGEST_URL")
        ingest_token = require_env("TASKS_INGEST_TOKEN")

    watermark_timestamp, watermark_meeting_id = load_watermark(watermark_path)
    recent = fetch_recent_transcripts(fireflies_api_key, limit=limit, urlopen=urlopen)
    fresh = select_recent_transcripts(recent, watermark_timestamp, watermark_meeting_id, limit=limit)
    if not fresh:
        print(json.dumps({"meetings": 0, "commitments": 0, "posted": False, "dry_run": dry_run, "items": []}))
        return 0

    all_commitments: list[RefinedCommitment] = []
    processed: list[dict[str, Any]] = []
    for transcript in fresh:
        transcript_text = build_transcript_text(transcript.get("sentences", []), limit=CLASSIFIER_MAX_CHARS)
        if not transcript_text:
            processed.append(transcript)
            continue
        if is_casual_transcript(transcript_text, anthropic_api_key=anthropic_api_key, urlopen=urlopen):
            processed.append(transcript)
            continue
        extraction_text = build_transcript_text(transcript.get("sentences", []), limit=EXTRACTOR_MAX_CHARS)
        extracted = extract_action_items(extraction_text, anthropic_api_key=anthropic_api_key, urlopen=urlopen)
        all_commitments.extend(refine_items(transcript, extracted))
        processed.append(transcript)

    items = commitment_payload_entries(all_commitments)
    payload = {"commitments": items}
    if dry_run:
        print(json.dumps({"dry_run": True, "items": items, "payload": payload}, indent=2))
        return 0

    if payload["commitments"]:
        result = post_commitments(
            ingest_url=ingest_url,
            ingest_token=ingest_token,
            commitments=all_commitments,
            urlopen=urlopen,
        )
        print(
            json.dumps(
                {
                    "meetings": len(processed),
                    "commitments": len(all_commitments),
                    "posted": True,
                    "result": result,
                    "items": items,
                }
            )
        )
    else:
        print(json.dumps({"meetings": len(processed), "commitments": 0, "posted": False, "noop": True, "items": items}))

    newest = max(processed, key=transcript_sort_key)
    save_watermark(watermark_path, newest)
    return 0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Extract Fireflies commitments into the briefs tasks board")
    parser.add_argument("--dry-run", action="store_true", help="Print the would-be ingest payload without POSTing")
    parser.add_argument("--limit", type=int, default=DEFAULT_TRANSCRIPT_LIMIT)
    parser.add_argument("--watermark-path", default=str(DEFAULT_WATERMARK_PATH))
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    args = parse_args(argv)
    try:
        return run(
            limit=max(1, args.limit),
            dry_run=args.dry_run,
            watermark_path=Path(args.watermark_path),
        )
    except (ValueError, urllib.error.URLError, urllib.error.HTTPError, OSError, json.JSONDecodeError) as exc:
        LOGGER.error("ff-extractor failed: %s", exc)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
