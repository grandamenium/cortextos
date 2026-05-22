#!/usr/bin/env python3
"""Search the local agentic CRM.

Usage:
  python3 crm/query.py "name, email, company, tag, or keyword"
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def load_contacts() -> list[dict]:
    path = ROOT / "contacts.json"
    if not path.exists():
        return []
    data = json.loads(path.read_text())
    return data.get("contacts", [])


def haystack(contact: dict) -> str:
    values: list[str] = []
    for key in [
        "id",
        "type",
        "name",
        "category",
        "priority",
        "context",
        "company",
        "role",
        "location",
        "notes",
    ]:
        value = contact.get(key)
        if value:
            values.append(str(value))
    for key in ["tags", "aliases", "emails", "phones"]:
        values.extend(str(v) for v in contact.get(key, []) if v)
    values.extend(str(v) for v in contact.get("handles", {}).values() if v)
    return "\n".join(values).lower()


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: python3 crm/query.py <query>", file=sys.stderr)
        return 2
    query = " ".join(sys.argv[1:]).lower()
    matches = [contact for contact in load_contacts() if query in haystack(contact)]
    print(json.dumps(matches, indent=2))
    return 0 if matches else 1


if __name__ == "__main__":
    raise SystemExit(main())
