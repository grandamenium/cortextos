#!/usr/bin/env bash
# reddit.sh — Reddit OAuth API client.
# Loads REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET + REDDIT_USERNAME + REDDIT_PASSWORD
# from secrets.env, gets a bearer token (cached 50min), executes endpoint.

set -uo pipefail

# Load secrets from common paths
for f in \
    "$HOME/.cortextos/default/secrets.env" \
    "/Users/subbu_ai_assistant/cortextos/orgs/subbu-ops/secrets.env" \
    "${CTX_FRAMEWORK_ROOT:-/Users/subbu_ai_assistant/cortextos}/orgs/${CTX_ORG:-subbu-ops}/secrets.env"; do
  [ -f "$f" ] && . "$f"
done

USER_AGENT="${REDDIT_USER_AGENT:-harpal-research/0.1}"
CACHE="${TMPDIR:-/tmp}/reddit-token-${UID:-0}"

usage() {
  cat <<EOF
Usage:
  reddit.sh search <query> [--sub <name>] [--limit N]
  reddit.sh top <subreddit> [--time hour|day|week|month|year|all] [--limit N]
  reddit.sh hot <subreddit> [--limit N]
  reddit.sh post <subreddit> <post-id>
  reddit.sh user <username> [--limit N]
  reddit.sh subreddit-about <name>

Env: REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USERNAME, REDDIT_PASSWORD, REDDIT_USER_AGENT
EOF
  exit 2
}

[ $# -eq 0 ] && usage

# Token cache (50 min TTL — reddit tokens are 1h)
get_token() {
  if [ -f "$CACHE" ] && [ $(($(date +%s) - $(stat -f %m "$CACHE" 2>/dev/null || echo 0))) -lt 3000 ]; then
    cat "$CACHE"; return
  fi
  if [ -z "${REDDIT_CLIENT_ID:-}" ] || [ -z "${REDDIT_CLIENT_SECRET:-}" ] || \
     [ -z "${REDDIT_USERNAME:-}" ]    || [ -z "${REDDIT_PASSWORD:-}" ]; then
    echo '{"verdict":"error","error":"missing REDDIT_CLIENT_ID/SECRET/USERNAME/PASSWORD in env or secrets.env"}' >&2
    exit 3
  fi
  resp=$(curl -s -m 15 -A "$USER_AGENT" \
    -u "${REDDIT_CLIENT_ID}:${REDDIT_CLIENT_SECRET}" \
    --data-urlencode "grant_type=password" \
    --data-urlencode "username=${REDDIT_USERNAME}" \
    --data-urlencode "password=${REDDIT_PASSWORD}" \
    https://www.reddit.com/api/v1/access_token)
  tok=$(printf '%s' "$resp" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('access_token',''))")
  if [ -z "$tok" ]; then
    echo "{\"verdict\":\"error\",\"error\":\"oauth token request failed\",\"raw\":$(printf '%s' "$resp" | head -c 400 | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')}" >&2
    exit 4
  fi
  printf '%s' "$tok" > "$CACHE"; chmod 600 "$CACHE"
  printf '%s' "$tok"
}

api() {
  # api <path> [extra-query-args...]
  local path="$1"; shift
  TOKEN=$(get_token)
  curl -s -m 20 -A "$USER_AGENT" \
    -H "Authorization: bearer $TOKEN" \
    "https://oauth.reddit.com$path" "$@"
}

# Shape a listing JSON into our envelope
shape_listing() {
  python3 -c '
import json, sys
d = json.load(sys.stdin)
children = d.get("data", {}).get("children", [])
items = []
for c in children:
    p = c.get("data", {})
    items.append({
        "subreddit": p.get("subreddit"),
        "title": p.get("title"),
        "author": p.get("author"),
        "score": p.get("score", 0),
        "num_comments": p.get("num_comments", 0),
        "url": p.get("url"),
        "permalink": f"https://reddit.com{p.get(chr(112)+chr(101)+chr(114)+chr(109)+chr(97)+chr(108)+chr(105)+chr(110)+chr(107),chr(34)+chr(34))}",
        "created_utc": p.get("created_utc"),
        "selftext": (p.get("selftext") or "")[:500],
        "is_self": p.get("is_self", False),
        "id": p.get("id"),
    })
print(json.dumps({"verdict": "ok", "n_results": len(items), "items": items}, indent=2))
'
}

cmd="$1"; shift
case "$cmd" in
  search)
    [ $# -eq 0 ] && usage
    q="$1"; shift
    SUB=""; LIMIT=25
    while [ $# -gt 0 ]; do
      case "$1" in --sub) SUB="$2"; shift 2 ;; --limit) LIMIT="$2"; shift 2 ;; *) shift ;; esac
    done
    path="/search?q=$(python3 -c "import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1]))" "$q")&limit=$LIMIT&type=link"
    [ -n "$SUB" ] && path="/r/$SUB$path&restrict_sr=on"
    api "$path" | shape_listing
    ;;

  top|hot)
    [ $# -eq 0 ] && usage
    SUB="$1"; shift
    TIME="day"; LIMIT=25
    while [ $# -gt 0 ]; do
      case "$1" in --time) TIME="$2"; shift 2 ;; --limit) LIMIT="$2"; shift 2 ;; *) shift ;; esac
    done
    if [ "$cmd" = "top" ]; then
      api "/r/$SUB/top?t=$TIME&limit=$LIMIT" | shape_listing
    else
      api "/r/$SUB/hot?limit=$LIMIT" | shape_listing
    fi
    ;;

  post)
    [ $# -lt 2 ] && usage
    SUB="$1"; PID="$2"
    api "/r/$SUB/comments/$PID" | python3 -c '
import json, sys
d = json.load(sys.stdin)
# d is [post_listing, comment_listing]
post = d[0]["data"]["children"][0]["data"] if d and isinstance(d, list) else {}
comments_raw = d[1]["data"]["children"] if len(d) > 1 else []

def shape_comment(c, depth=0):
    p = c.get("data", {})
    if c.get("kind") == "more": return None
    out = {
        "author": p.get("author"),
        "score": p.get("score", 0),
        "body": (p.get("body") or "")[:1000],
        "created_utc": p.get("created_utc"),
    }
    replies = p.get("replies")
    if isinstance(replies, dict) and depth < 3:
        kids = replies.get("data", {}).get("children", [])
        out["replies"] = [shape_comment(k, depth+1) for k in kids[:8]]
        out["replies"] = [r for r in out["replies"] if r]
    return out

shaped = [shape_comment(c) for c in comments_raw[:15]]
shaped = [s for s in shaped if s]
print(json.dumps({
    "verdict": "ok",
    "post": {
        "subreddit": post.get("subreddit"),
        "title": post.get("title"),
        "author": post.get("author"),
        "score": post.get("score", 0),
        "num_comments": post.get("num_comments", 0),
        "url": post.get("url"),
        "selftext": (post.get("selftext") or "")[:3000],
        "id": post.get("id"),
        "created_utc": post.get("created_utc"),
    },
    "comments": shaped,
}, indent=2))
'
    ;;

  user)
    [ $# -eq 0 ] && usage
    USER="$1"; shift
    LIMIT=25
    while [ $# -gt 0 ]; do
      case "$1" in --limit) LIMIT="$2"; shift 2 ;; *) shift ;; esac
    done
    api "/user/$USER/overview?limit=$LIMIT" | shape_listing
    ;;

  subreddit-about)
    [ $# -eq 0 ] && usage
    SUB="$1"
    api "/r/$SUB/about" | python3 -c '
import json, sys
d = json.load(sys.stdin).get("data", {})
print(json.dumps({
    "verdict": "ok",
    "subreddit": d.get("display_name"),
    "title": d.get("title"),
    "subscribers": d.get("subscribers"),
    "active_user_count": d.get("active_user_count"),
    "public_description": d.get("public_description"),
    "description": (d.get("description") or "")[:2000],
    "created_utc": d.get("created_utc"),
    "over18": d.get("over18", False),
}, indent=2))
'
    ;;

  -h|--help) usage ;;
  *) echo "unknown command: $cmd" >&2; usage ;;
esac
