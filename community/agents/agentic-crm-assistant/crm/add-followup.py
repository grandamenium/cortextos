#!/usr/bin/env python3
"""Append an open follow-up to crm/followups.jsonl."""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path


CRM_DIR = Path(__file__).resolve().parent
FOLLOWUPS_PATH = CRM_DIR / "followups.jsonl"


def main() -> int:
    parser = argparse.ArgumentParser(description="Create a CRM follow-up")
    parser.add_argument("--contact-id", required=True)
    parser.add_argument("--due-date", required=True, help="YYYY-MM-DD")
    parser.add_argument("--reason", required=True)
    parser.add_argument("--suggested-action", default="")
    parser.add_argument("--priority", default="normal")
    parser.add_argument("--source-ref", default="manual")
    args = parser.parse_args()

    seed = f"{args.contact_id}|{args.due_date}|{args.reason}|{args.source_ref}"
    digest = hashlib.sha1(seed.encode("utf-8")).hexdigest()[:10]
    record = {
        "id": f"followup-{args.contact_id}-{args.due_date}-{digest}",
        "contact_id": args.contact_id,
        "due_date": args.due_date,
        "priority": args.priority,
        "reason": args.reason,
        "suggested_action": args.suggested_action,
        "status": "open",
        "source_ref": args.source_ref,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }

    with FOLLOWUPS_PATH.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, sort_keys=True) + "\n")
    print(record["id"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
