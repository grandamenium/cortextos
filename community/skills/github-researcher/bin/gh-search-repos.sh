#!/usr/bin/env bash
# gh-search-repos.sh — repo search via GitHub API; works authed or unauthed.
#
# Usage:
#   gh-search-repos.sh "language:rust topic:async stars:>1000" [--limit N]
#
# Output: JSON array of repos, each with name/full_name/description/stars/language/topics/license/pushed_at/html_url + cluster tag.

set -uo pipefail
LIMIT=20

# Parse args (first positional = query; remaining can include --limit)
QUERY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --limit) LIMIT="$2"; shift 2 ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# *//'; exit 0 ;;
    *) QUERY="$1"; shift ;;
  esac
done
[ -z "$QUERY" ] && { echo '{"verdict":"error","error":"query required"}' >&2; exit 2; }

# Use gh if authed, else fall back to public REST
GH=/opt/homebrew/bin/gh
if "$GH" auth status -h github.com >/dev/null 2>&1; then
  raw=$("$GH" api -X GET search/repositories \
        -f q="$QUERY" -F per_page="$LIMIT" -f sort=stars -f order=desc 2>&1)
else
  raw=$(curl -s -m 15 -G "https://api.github.com/search/repositories" \
        --data-urlencode "q=$QUERY" \
        --data-urlencode "per_page=$LIMIT" \
        --data-urlencode "sort=stars" \
        --data-urlencode "order=desc")
fi

python3 - "$raw" <<'PYEOF'
import json, sys
from collections import Counter
data = json.loads(sys.argv[1])
items = data.get("items", [])
if not items and "message" in data:
    print(json.dumps({"verdict": "error", "error": data["message"]}), file=sys.stderr); sys.exit(3)

# auto-cluster by primary topic overlap
topic_counter = Counter()
for r in items:
    for t in r.get("topics", []) or []:
        topic_counter[t] += 1
top_topics = [t for t, c in topic_counter.most_common(8) if c >= 2]

def cluster_of(r):
    rt = set(r.get("topics", []) or [])
    for t in top_topics:
        if t in rt: return t
    return "other"

out = []
for r in items:
    out.append({
        "name": r.get("name"),
        "full_name": r.get("full_name"),
        "description": (r.get("description") or "")[:200],
        "stars": r.get("stargazers_count", 0),
        "language": r.get("language"),
        "topics": r.get("topics") or [],
        "license": (r.get("license") or {}).get("spdx_id"),
        "pushed_at": r.get("pushed_at"),
        "html_url": r.get("html_url"),
        "cluster": cluster_of(r),
    })
print(json.dumps({"verdict": "ok", "total": data.get("total_count", 0), "items": out, "clusters": dict(topic_counter)}, indent=2))
PYEOF
