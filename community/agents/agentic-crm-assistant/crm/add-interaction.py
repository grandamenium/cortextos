#!/usr/bin/env python3
"""Append an interaction to the local CRM interaction log."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--contact-id", required=True)
    parser.add_argument("--type", required=True, choices=["email", "meeting", "call", "message", "social", "manual", "task"])
    parser.add_argument("--summary", required=True)
    parser.add_argument("--source-ref", default=None)
    parser.add_argument("--sentiment", default="unknown", choices=["positive", "neutral", "negative", "unknown"])
    args = parser.parse_args()

    record = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "contact_id": args.contact_id,
        "type": args.type,
        "summary": args.summary,
        "sentiment": args.sentiment,
        "commitments": [],
        "followups_created": [],
        "source_ref": args.source_ref,
    }

    path = ROOT / "interactions.jsonl"
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record) + "\n")
    print(json.dumps(record, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
