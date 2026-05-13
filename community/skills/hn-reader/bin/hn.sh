#!/usr/bin/env bash
# hn.sh — Hacker News Firebase + Algolia client. No deps beyond curl + python3.
set -uo pipefail

FB=https://hacker-news.firebaseio.com/v0
ALG=https://hn.algolia.com/api/v1
DEPTH=2

usage() {
  cat <<EOF
Usage:
  hn.sh top [N]         latest N top-stories (default 30)
  hn.sh new [N]         newest stories
  hn.sh ask [N]         latest Ask HN
  hn.sh show [N]        latest Show HN
  hn.sh story <id>      story + comment tree (depth $DEPTH)
  hn.sh search <query>  Algolia search
EOF
  exit 2
}

[ $# -eq 0 ] && usage

cmd="$1"; shift
case "$cmd" in
  top|new|ask|show)
    n="${1:-30}"
    case "$cmd" in
      top)  url=$FB/topstories.json ;;
      new)  url=$FB/newstories.json ;;
      ask)  url=$FB/askstories.json ;;
      show) url=$FB/showstories.json ;;
    esac
    ids=$(curl -s -m 10 "$url" | python3 -c "import sys,json; ids=json.loads(sys.stdin.read())[:int('$n')]; print(' '.join(map(str,ids)))")
    python3 - <<PY
import json, sys, urllib.request
ids = "$ids".split()
out = []
for i in ids:
    try:
        with urllib.request.urlopen(f"$FB/item/{i}.json", timeout=8) as r:
            item = json.loads(r.read())
            out.append({
                "id": item.get("id"),
                "title": item.get("title"),
                "by": item.get("by"),
                "score": item.get("score", 0),
                "descendants": item.get("descendants", 0),
                "time": item.get("time"),
                "url": item.get("url"),
                "hn_url": f"https://news.ycombinator.com/item?id={item.get('id')}",
            })
    except Exception as e:
        out.append({"id": i, "error": str(e)})
print(json.dumps(out, indent=2))
PY
    ;;

  story)
    id="${1:?story id required}"
    python3 - <<PY
import json, urllib.request

FB = "$FB"
DEPTH = $DEPTH

def fetch(i):
    try:
        with urllib.request.urlopen(f"{FB}/item/{i}.json", timeout=8) as r:
            return json.loads(r.read())
    except Exception:
        return None

def shape(item, depth):
    if item is None: return None
    out = {
        "id": item.get("id"),
        "by": item.get("by"),
        "time": item.get("time"),
        "text": item.get("text", "")[:2000],
    }
    if item.get("title"):
        out["title"] = item["title"]
        out["url"] = item.get("url")
        out["score"] = item.get("score")
        out["descendants"] = item.get("descendants", 0)
    kids = item.get("kids") or []
    if kids and depth > 0:
        out["kids"] = [shape(fetch(k), depth-1) for k in kids[:15]]
        out["kids"] = [k for k in out["kids"] if k]
    return out

print(json.dumps(shape(fetch("$id"), DEPTH), indent=2))
PY
    ;;

  search)
    q="${1:?query required}"
    curl -s -m 10 --data-urlencode "query=$q" -G "$ALG/search" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read())
hits = []
for h in d.get('hits', []):
    hits.append({
        'objectID': h.get('objectID'),
        'title': h.get('title') or h.get('story_title'),
        'author': h.get('author'),
        'points': h.get('points', 0),
        'num_comments': h.get('num_comments', 0),
        'url': h.get('url'),
        'created_at': h.get('created_at'),
        'hn_url': f\"https://news.ycombinator.com/item?id={h.get('objectID')}\",
    })
print(json.dumps({'nbHits': d.get('nbHits', 0), 'hits': hits}, indent=2))
"
    ;;

  -h|--help) usage ;;
  *) echo \"unknown command: $cmd\" >&2; usage ;;
esac
