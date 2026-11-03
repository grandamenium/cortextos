#!/usr/bin/env python3
"""Surface known script-language candidates without deciding intent or rewriting supplied text.

python3 <skill>/scripts/scan_script.py script.md --out output/script-language-review.json
Optional --reviews is a JSON list of {id, sha256, reason} model/human dispositions for printed IDs.
Exit 0: no unresolved known candidates (not proof of semantic quality); 2: review needed; 1: input error.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys

# These are lexical floors for the patterns named in the skill, not semantic classifiers.
PATTERNS = (
    ("meet", re.compile(r"\bMeet\s+\w+", re.I)),
    ("introducing", re.compile(r"\bIntroducing\b", re.I)),
    ("not-just", re.compile(r"\bNot just\b[^\n.!?]{0,160}\b(?:it['’]s|it is)\b", re.I)),
)


def scan(text: str) -> list[dict]:
    findings = []
    for number, line in enumerate(text.splitlines(), 1):
        for kind, pattern in PATTERNS:
            for hit in pattern.finditer(line):
                findings.append({"id": f"{kind}:{number}:{hit.start() + 1}", "line": number,
                                 "column": hit.start() + 1, "kind": kind, "excerpt": line.strip()})
    return sorted(findings, key=lambda f: (f["line"], f["column"], f["kind"]))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("script", type=Path)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--reviews", type=Path)
    args = ap.parse_args()
    findings = scan(args.script.read_text(encoding="utf-8"))
    for finding in findings:
        finding["sha256"] = hashlib.sha256(args.script.read_bytes() + finding["id"].encode()).hexdigest()
    decisions = {}
    if args.reviews:
        raw = json.loads(args.reviews.read_text(encoding="utf-8"))
        if not isinstance(raw, list):
            raise ValueError("--reviews must contain a list of {id, sha256, reason}")
        for item in raw:
            if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not isinstance(item.get("reason"), str) or not item["reason"].strip():
                raise ValueError("each review needs string id and a nonempty reason")
            if item["id"] in decisions:
                raise ValueError(f"duplicate review id: {item['id']}")
            if not isinstance(item.get("sha256"), str):
                raise ValueError("each review requires the current printed sha256")
            decisions[item["id"]] = (item["sha256"], item["reason"].strip())
    for f in findings:
        f["status"] = "reviewed" if decisions.get(f["id"], (None,))[0] == f["sha256"] else "review_required"
        if decisions.get(f["id"], (None,))[0] == f["sha256"]:
            f["reason"] = decisions[f["id"]][1]
        print(f"{f['status'].upper()} {f['id']} sha256={f['sha256']}: {f['excerpt']}" + (f" ({f['reason']})" if f.get("reason") else ""))
    pending = sum(f["status"] == "review_required" for f in findings)
    report = {"input": str(args.script.resolve()), "status": "review_required" if pending else "known_candidates_reviewed",
              "coverage": "known lexical patterns only; parallel fragments, rhetoric and supplied-script authority require manual review",
              "findings": findings}
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"{pending} known candidate(s) need review; no wording changed. A zero result does not clear meaning or style.")
    return 2 if pending else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, TypeError, KeyError, AttributeError) as exc:
        print(f"ERROR: invalid or unreadable script/reviews: {exc}", file=sys.stderr)
        raise SystemExit(1)
