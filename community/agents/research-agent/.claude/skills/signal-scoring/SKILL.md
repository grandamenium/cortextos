---
name: signal-scoring
description: "Score, deduplicate, rank, and select fresh research signals from SQLite using the configured rubric."
---

# Signal Scoring

Score, rank, and select signals from the local SQLite database. Produces the
shortlist that gets passed to brief-generation.

---

## When to Use

After source-collection completes, before brief-generation.

---

## Input

- `research/db/signals.db` -- signal database populated by source-collection
- `research/scoring-rubric.json` (copy from scoring-rubric.example.json, tune weights)
- `config.json` (for runtime paths and window settings)

## Output

- `research/output/YYYY-MM-DD/signals-selected.json` -- shortlisted items with scores, ready for brief-generation
- Score summary appended to `research/output/YYYY-MM-DD/run.log`

**Note:** `delivered_at` is NOT set here. It is set by delivery-routing after successful delivery.

---

## Scoring Process

### Step 1: Fetch candidates from DB

Pull items seen in the configured recent window. Suppress items delivered within
`research.suppress_delivered_hours` (default 72). Use a subquery to get only the
latest metric row per item.

```python
import sqlite3, datetime as dt, json

def open_db(db_path):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn

def recent_candidates(conn, window_hours=24, suppress_delivered_hours=72):
    seen_cutoff = (dt.datetime.utcnow() - dt.timedelta(hours=window_hours)).isoformat()
    delivered_cutoff = (dt.datetime.utcnow() - dt.timedelta(hours=suppress_delivered_hours)).isoformat()
    return conn.execute("""
        SELECT i.*,
               m.stars, m.score, m.comments, m.views, m.likes, m.forks,
               m.shares, m.saves, m.bookmarks, m.reposts, m.quotes
        FROM items i
        LEFT JOIN metric_snapshots m ON m.id = (
            SELECT id FROM metric_snapshots
            WHERE item_id = i.id
            ORDER BY collected_at DESC LIMIT 1
        )
        WHERE i.last_seen_at >= ?
          AND (i.delivered_at IS NULL OR i.delivered_at < ?)
        ORDER BY i.last_seen_at DESC
    """, (seen_cutoff, delivered_cutoff)).fetchall()
```

### Step 2: Load rubric

```python
def load_rubric(rubric_path):
    with open(rubric_path) as f:
        return json.load(f)
```

Expected flat keys (from scoring-rubric.json):
- `base_weight`, `fit_weight`, `velocity_weight`
- `niche_bonus`, `tutorial_bonus`, `platform_bonus`
- `engagement_normalization` (dict with per-platform scale factors)
- `keyword_boosts.keywords` (list of niche keywords for bonus scoring)

### Step 3: Score each item

```python
def score_item(item, conn, rubric):
    """
    rubric: dict loaded from research/scoring-rubric.json.
    """
    text = " ".join(str(item[k] or "") for k in ["title", "summary", "text", "source_name"]).lower()

    base = normalize_engagement(item, rubric)
    fit = compute_fit(text, rubric.get("niche_terms", []), rubric.get("tutorial_terms", []))
    velocity = compute_velocity(item["id"], conn)

    bonus = 0
    if any(t in text for t in rubric.get("niche_terms", [])):
        bonus += rubric.get("niche_bonus", 1.5)
    if any(t in text for t in rubric.get("tutorial_terms", [])):
        bonus += rubric.get("tutorial_bonus", 1.0)
    if item["platform"] in rubric.get("high_value_platforms", []):
        bonus += rubric.get("platform_bonus", 0.5)
    bonus += rubric.get("source_type_bonuses", {}).get(item["platform"], 0)

    # keyword_boosts from rubric (up to +2)
    kw_matches = sum(1 for kw in rubric.get("keyword_boosts", {}).get("keywords", []) if kw in text)
    bonus += min(kw_matches, 2)

    return (
        base * rubric.get("base_weight", 1.0)
        + fit * rubric.get("fit_weight", 0.3)
        + velocity * rubric.get("velocity_weight", 0.2)
        + bonus
    )

def normalize_engagement(item, rubric):
    norm = rubric.get("engagement_normalization", {})
    platform = item["platform"] or ""
    if platform == "github":
        return min((item["stars"] or 0) / norm.get("github_stars_per_10", 500), 10)
    elif platform == "reddit":
        return min((item["score"] or 0) / norm.get("reddit_score_per_10", 100), 10)
    elif platform == "hacker_news":
        return min((item["score"] or 0) / norm.get("hn_score_per_10", 50), 10)
    elif platform in ("youtube", "x", "instagram", "tiktok"):
        views = item["views"] or item["likes"] or 0
        return min(views / norm.get("social_views_per_10", 10000), 10)
    elif platform == "arxiv":
        return 6   # academic papers: moderate default
    else:
        return 3   # rss / unknown

def compute_fit(text, niche_terms, tutorial_terms):
    fit = 0
    if any(t in text for t in niche_terms):
        fit += 5
    if any(t in text for t in tutorial_terms):
        fit += 3
    return min(fit, 10)

def compute_velocity(item_id, conn):
    rows = conn.execute(
        """SELECT stars, score, views, likes, comments, collected_at
           FROM metric_snapshots
           WHERE item_id = ?
           ORDER BY collected_at""",
        (item_id,)
    ).fetchall()
    if len(rows) < 2:
        return 0
    earliest, latest = rows[0], rows[-1]
    delta = (
        ((latest["stars"] or 0) - (earliest["stars"] or 0)) +
        ((latest["score"] or 0) - (earliest["score"] or 0)) +
        ((latest["views"] or 0) - (earliest["views"] or 0))
    )
    return min(delta / 100, 10)
```

### Step 4: Deduplicate by topic

If two items cover the same announcement, keep the higher-scoring one.

```python
import re

def topic_key(item):
    text = re.sub(r"[^a-z0-9]+", " ", (item["title"] or "").lower())
    words = [w for w in text.split() if len(w) > 3][:8]
    return f"{item['platform'] or 'web'}:{'-'.join(words)}"

def dedup_by_topic(scored_items):
    best = {}
    for score, item in scored_items:
        key = topic_key(item)
        if key not in best or score > best[key][0]:
            best[key] = (score, item)
    return list(best.values())
```

### Step 5: Apply threshold and select top N

```python
def select_top(conn, rubric, runtime_config, out_path, run_date):
    research_config = runtime_config.get("research", {})
    window_hours = research_config.get("signal_window_hours", 24)
    suppress_hours = research_config.get("suppress_delivered_hours", 72)
    top_n = rubric.get("top_n", 8)
    threshold = rubric.get("minimum_score_threshold", 5.0)

    candidates = recent_candidates(conn, window_hours, suppress_hours)
    scored = [(score_item(row, conn, rubric), row) for row in candidates]
    scored = [(s, i) for s, i in scored if s >= threshold]
    scored = dedup_by_topic(scored)
    scored.sort(key=lambda x: x[0], reverse=True)
    selected = scored[:top_n]

    # Write selected items to disk -- do NOT mark delivered_at here
    output = []
    for rank, (score, item) in enumerate(selected, 1):
        output.append({
            "rank": rank,
            "platform": item["platform"],
            "canonical_key": item["canonical_key"],
            "title": item["title"],
            "url": item["url"],
            "author": item["author"],
            "source_name": item["source_name"],
            "published_at": item["published_at"],
            "summary": item["summary"],
            "score": round(score, 2),
            "score_components": {
                "note": "base + fit + velocity + configured bonuses; keep detailed components when your implementation exposes them"
            }
        })

    with open(out_path, "w") as f:
        json.dump(output, f, indent=2)

    filtered = len(candidates) - len([s for s, _ in scored if s >= threshold])
    log_line = f"Scoring: {len(candidates)} candidates, {len(selected)} selected, {filtered} below threshold"
    print(log_line)
    return output
```

### Step 6: Mark delivered_at (AFTER delivery succeeds)

`delivered_at` is set by delivery-routing, not here. This separation ensures items are
not suppressed if delivery fails.

```python
# Called by delivery-routing after successful send:
def mark_delivered(conn, selected_items):
    now = dt.datetime.utcnow().isoformat()
    for item in selected_items:
        conn.execute(
            "UPDATE items SET delivered_at=? WHERE canonical_key=?",
            (now, item["canonical_key"])
        )
    conn.commit()
```

---

## Scoring Notes

- Tune `niche_terms` in `research/scoring-rubric.json` first -- highest-leverage lever.
- For GitHub: star velocity is the best novelty signal for new vs. established repos.
- For arXiv: skip velocity (papers don't accumulate metrics fast). Use base 6 default.
- When uncertain between two items, prefer the more specific title.
- If fewer than `top_n` pass threshold, brief only those. Do not pad.
