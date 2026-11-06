#!/usr/bin/env python3
"""Remember what the user likes and hates, so the next video starts from their taste.

  taste.py ban 412 --why "too boomy under voice"     # id from search.py, or a path fragment
  taste.py love "Woosh 3"
  taste.py unban 412
  taste.py list
  taste.py clear

Bans are hidden from search and auto-pick; loved sounds are ranked first (and pass the name guards of the picker).
A ban or a love covers every copy of the recording (the same dup_key). Stored by file path in taste.json next to the
skill, so it survives re-indexing.
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from picker import TASTE_PATH, find, load_index, load_taste, twins_of


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("action", choices=["ban", "unban", "love", "unlove", "list", "clear"])
    ap.add_argument("ref", nargs="?")
    ap.add_argument("--why", default="")
    a = ap.parse_args()
    t = load_taste()

    if a.action == "list":
        for k in ("ban", "love"):
            print(f"{k} ({len(t[k])}):")
            for p in t[k]:
                note = t["notes"].get(p, "")
                print("  " + Path(p).name + (f"   // {note}" if note else "") + f"   [{p}]")
        return
    if a.action == "clear":
        TASTE_PATH.write_text(json.dumps({"ban": [], "love": [], "notes": {}}), encoding="utf-8")
        print("taste cleared")
        return
    if not a.ref:
        sys.exit("need an id or a path fragment")
    index = load_index()
    s = find(index, a.ref)
    if not s:
        sys.exit(f"not found in the index: {a.ref}")
    p = s["path"]
    group = sorted(twins_of([p], index))           # every copy of the recording
    ban, love = a.action in ("ban", "unban"), a.action in ("love", "unlove")
    key = "ban" if ban else "love"
    if a.action in ("ban", "love"):
        other = "love" if key == "ban" else "ban"
        for q in group:
            if q in t[other]:
                t[other].remove(q)
            if q not in t[key]:
                t[key].append(q)
        if a.why:
            t["notes"][p] = a.why
    else:
        for q in group:
            if q in t[key]:
                t[key].remove(q)
        t["notes"].pop(p, None)
    TASTE_PATH.write_text(json.dumps(t, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{a.action}: {s['library']}/{s['folder']}/{s['name']}" + (f" (+{len(group) - 1} copies of the recording)" if len(group) > 1 else ""))


if __name__ == "__main__":
    main()
