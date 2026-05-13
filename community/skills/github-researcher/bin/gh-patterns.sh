#!/usr/bin/env bash
# gh-patterns.sh — pattern detection across top-K repos for a search.
# Identifies shared topics, common license, language distribution, push-cadence cohort.
#
# Usage: gh-patterns.sh "<query>" [--limit N] [--deep]
#   --deep: also fetch package.json / pyproject.toml / Cargo.toml and look for shared deps (slow, more API calls)
set -uo pipefail
LIMIT=20
DEEP=0
QUERY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --limit) LIMIT="$2"; shift 2 ;;
    --deep)  DEEP=1; shift ;;
    *) QUERY="$1"; shift ;;
  esac
done
[ -z "$QUERY" ] && { echo '{"verdict":"error","error":"query required"}' >&2; exit 2; }

GH=/opt/homebrew/bin/gh
if "$GH" auth status -h github.com >/dev/null 2>&1; then
  search=$("$GH" api -X GET search/repositories -f q="$QUERY" -F per_page="$LIMIT" -f sort=stars -f order=desc 2>&1)
else
  search=$(curl -s -m 15 -G "https://api.github.com/search/repositories" \
           --data-urlencode "q=$QUERY" --data-urlencode "per_page=$LIMIT" \
           --data-urlencode "sort=stars" --data-urlencode "order=desc")
fi

python3 - "$search" "$DEEP" <<'PYEOF'
import json, sys, urllib.request
from collections import Counter
from datetime import datetime, timezone
data = json.loads(sys.argv[1])
deep = sys.argv[2] == "1"
items = data.get("items", [])
if not items:
    print(json.dumps({"verdict": "error", "error": data.get("message") or "no items"}), file=sys.stderr); sys.exit(3)

topics = Counter(); langs = Counter(); licenses = Counter()
push_ages_days = []
now = datetime.now(timezone.utc)
for r in items:
    for t in r.get("topics") or []: topics[t] += 1
    if r.get("language"): langs[r["language"]] += 1
    lic = (r.get("license") or {}).get("spdx_id")
    if lic: licenses[lic] += 1
    if r.get("pushed_at"):
        try:
            pa = datetime.fromisoformat(r["pushed_at"].replace("Z","+00:00"))
            push_ages_days.append((now - pa).days)
        except Exception: pass

push_ages_days.sort()
out = {
    "verdict": "ok",
    "query": "(from input)",
    "n_repos": len(items),
    "top_repos": [{"full_name": r["full_name"], "stars": r.get("stargazers_count", 0)} for r in items[:10]],
    "shared_topics": dict(topics.most_common(15)),
    "language_distribution": dict(langs),
    "license_distribution": dict(licenses),
    "push_cadence": {
        "median_age_days": push_ages_days[len(push_ages_days)//2] if push_ages_days else None,
        "active_under_30d": sum(1 for d in push_ages_days if d < 30),
        "stale_over_180d": sum(1 for d in push_ages_days if d > 180),
    },
}

if deep:
    # Sample package.json / pyproject.toml / Cargo.toml from top 5 repos
    dep_counter = Counter()
    for r in items[:5]:
        for manifest, key in [("package.json", "dependencies"), ("pyproject.toml", None), ("Cargo.toml", "dependencies")]:
            url = f"https://raw.githubusercontent.com/{r['full_name']}/{r.get('default_branch','main')}/{manifest}"
            try:
                with urllib.request.urlopen(url, timeout=8) as resp:
                    content = resp.read().decode("utf-8", errors="ignore")
                    if manifest == "package.json":
                        deps = json.loads(content).get("dependencies", {}) or {}
                        for d in deps: dep_counter[f"npm:{d}"] += 1
                    elif manifest == "pyproject.toml":
                        for line in content.splitlines():
                            if "=" in line and not line.strip().startswith("#"):
                                k = line.split("=")[0].strip().strip('"')
                                if k and " " not in k and "/" not in k and k != "python":
                                    dep_counter[f"py:{k}"] += 1
                    elif manifest == "Cargo.toml":
                        for line in content.splitlines():
                            if line.strip().startswith("[dependencies]"): continue
                            if "=" in line and not line.strip().startswith("#"):
                                k = line.split("=")[0].strip()
                                if k: dep_counter[f"crate:{k}"] += 1
            except Exception: pass
    out["deep_shared_deps"] = dict(dep_counter.most_common(20))

print(json.dumps(out, indent=2))
PYEOF
