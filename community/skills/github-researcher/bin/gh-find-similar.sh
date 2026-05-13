#!/usr/bin/env bash
# gh-find-similar.sh — "more like this" using topic overlap + language + stars.
#
# Usage: gh-find-similar.sh <owner/repo> [--limit N]
set -uo pipefail
LIMIT=15
REPO=""
while [ $# -gt 0 ]; do
  case "$1" in
    --limit) LIMIT="$2"; shift 2 ;;
    *) REPO="$1"; shift ;;
  esac
done
[ -z "$REPO" ] && { echo '{"verdict":"error","error":"owner/repo required"}' >&2; exit 2; }

GH=/opt/homebrew/bin/gh
get() {
  if "$GH" auth status -h github.com >/dev/null 2>&1; then
    "$GH" api "$@"
  else
    curl -s -m 15 "https://api.github.com$1" | python3 -c "import sys,json; print(json.dumps(json.loads(sys.stdin.read())))"
  fi
}

src=$(get "/repos/$REPO")
python3 - "$src" "$REPO" "$LIMIT" <<'PYEOF'
import json, sys, urllib.request, urllib.parse
src = json.loads(sys.argv[1])
repo = sys.argv[2]; limit = int(sys.argv[3])

topics = src.get("topics") or []
lang = src.get("language")
stars = src.get("stargazers_count", 0)

# Query: topics OR language + similar star tier (within 1 OOM)
if not topics and not lang:
    print(json.dumps({"verdict": "no_signal", "error": "source repo has no topics/language to anchor"}), file=sys.stderr); sys.exit(3)

lo = max(stars // 10, 10)
hi = stars * 10
topic_clauses = " ".join(f"topic:{t}" for t in topics[:3])
q = f"{topic_clauses} stars:{lo}..{hi}"
if lang: q += f" language:{lang}"

url = f"https://api.github.com/search/repositories?q={urllib.parse.quote(q)}&per_page={limit+1}&sort=stars&order=desc"
with urllib.request.urlopen(url, timeout=15) as r:
    res = json.loads(r.read())

items = [i for i in res.get("items", []) if i.get("full_name") != repo][:limit]
out = []
for r in items:
    rt = set(r.get("topics") or [])
    overlap = len(rt & set(topics))
    out.append({
        "full_name": r.get("full_name"),
        "description": (r.get("description") or "")[:150],
        "stars": r.get("stargazers_count", 0),
        "language": r.get("language"),
        "topics": r.get("topics") or [],
        "topic_overlap": overlap,
        "html_url": r.get("html_url"),
    })
out.sort(key=lambda x: (-x["topic_overlap"], -x["stars"]))
print(json.dumps({
    "verdict": "ok",
    "source": {"full_name": repo, "stars": stars, "language": lang, "topics": topics},
    "query": q,
    "matches": out,
}, indent=2))
PYEOF
