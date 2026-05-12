#!/usr/bin/env python3
"""Create or update a contact in crm/contacts.json."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


CRM_DIR = Path(__file__).resolve().parent
CONTACTS_PATH = CRM_DIR / "contacts.json"


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.strip().lower()).strip("-")
    return slug or "contact"


def load_contacts() -> dict:
    if not CONTACTS_PATH.exists():
        return {"version": "1.0.0", "contacts": []}
    return json.loads(CONTACTS_PATH.read_text())


def merge_unique(existing: list, additions: list) -> list:
    seen = set()
    merged = []
    for item in [*existing, *additions]:
        if item and item not in seen:
            seen.add(item)
            merged.append(item)
    return merged


def main() -> int:
    parser = argparse.ArgumentParser(description="Create or update a CRM contact")
    parser.add_argument("--id", dest="contact_id")
    parser.add_argument("--name", required=True)
    parser.add_argument("--type", default="person", choices=["person", "company"])
    parser.add_argument("--category", default="other")
    parser.add_argument("--priority", default="normal")
    parser.add_argument("--email", action="append", default=[])
    parser.add_argument("--phone", action="append", default=[])
    parser.add_argument("--tag", action="append", default=[])
    parser.add_argument("--alias", action="append", default=[])
    parser.add_argument("--company")
    parser.add_argument("--role")
    parser.add_argument("--location")
    parser.add_argument("--context", default="")
    parser.add_argument("--notes", default="")
    parser.add_argument("--source-ref", action="append", default=[])
    args = parser.parse_args()

    data = load_contacts()
    contacts = data.setdefault("contacts", [])
    contact_id = args.contact_id or slugify(args.name)

    contact = next((item for item in contacts if item.get("id") == contact_id), None)
    if contact is None:
        contact = {
            "id": contact_id,
            "type": args.type,
            "name": args.name,
            "category": args.category,
            "priority": args.priority,
            "relationship_strength": None,
            "tags": [],
            "aliases": [],
            "emails": [],
            "phones": [],
            "handles": {},
            "company": None,
            "role": None,
            "location": None,
            "context": "",
            "preferences": {},
            "important_dates": [],
            "last_meaningful_contact": None,
            "followup_cadence_days": None,
            "notes": "",
            "source_refs": [],
        }
        contacts.append(contact)

    contact.update(
        {
            "type": args.type,
            "name": args.name,
            "category": args.category,
            "priority": args.priority,
            "company": args.company if args.company is not None else contact.get("company"),
            "role": args.role if args.role is not None else contact.get("role"),
            "location": args.location if args.location is not None else contact.get("location"),
        }
    )
    if args.context:
        contact["context"] = args.context
    if args.notes:
        contact["notes"] = args.notes

    contact["emails"] = merge_unique(contact.get("emails", []), args.email)
    contact["phones"] = merge_unique(contact.get("phones", []), args.phone)
    contact["tags"] = merge_unique(contact.get("tags", []), args.tag)
    contact["aliases"] = merge_unique(contact.get("aliases", []), args.alias)
    contact["source_refs"] = merge_unique(contact.get("source_refs", []), args.source_ref)

    CONTACTS_PATH.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
    print(contact_id)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
