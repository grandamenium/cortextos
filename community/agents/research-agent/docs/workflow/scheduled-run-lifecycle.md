# Scheduled Run Lifecycle

Each research cycle follows this sequence:

```
1. Cron fires
2. Agent reads config.json and research/sources.json
3. Ensures research/db/signals.db exists (creates on first run)
4. Creates output folder: research/output/YYYY-MM-DD/ (or research/output/YYYY-MM-DD-HH/ for multiple daily runs)

5. source-collection skill runs
   - Fetches all configured sources (YouTube RSS, Reddit, GitHub, HN, arXiv, RSS feeds,
     custom URLs, Apify social)
   - Normalizes each item to the common signal format
   - Upserts into research/db/signals.db: new items inserted, existing items update last_seen_at
     and append a metric snapshot to metric_snapshots
   - Writes fetch summary to research/output/YYYY-MM-DD/run.log

6. signal-scoring skill runs
   - Queries signals seen in the last signal_window_hours (default 24h)
   - Suppresses items delivered within suppress_delivered_hours (default 72h)
   - Scores each candidate (base engagement + content fit + velocity + bonuses)
   - Deduplicates by topic key
   - Filters below minimum_score_threshold
   - Selects top N
   - Writes research/output/YYYY-MM-DD/signals-selected.json
   - Does NOT mark delivered_at yet

7. brief-generation skill runs
   - Reads research/output/YYYY-MM-DD/signals-selected.json
   - Writes one brief per selected signal to research/output/YYYY-MM-DD/briefs/SLUG.md
   - Writes research/output/YYYY-MM-DD/summary.md

8. delivery-routing skill runs
   - Checks research.delivery.requires_approval
   - If approval required: creates a cortextOS approval, writes research/output/YYYY-MM-DD/PENDING-APPROVAL.md, and stops
   - If no approval required: sends summary to configured destination
     - Retries up to 3 times on failure
     - On all retries failed: copies to research/output/YYYY-MM-DD/DELIVERY-FAILED-summary.md
   - On successful delivery: calls mark_delivered() to set delivered_at on selected items

9. Appends run completion stats to research/output/YYYY-MM-DD/run.log
10. Agent returns to idle, waits for next cron
```

## Run IDs

Each run is identified by `YYYY-MM-DD` (daily) or `YYYY-MM-DD-HH` (multiple daily).
All artifacts from a run share the same folder under `research/output/`.

## Multiple Daily Runs

If configured with multiple crons (e.g. 9am and 6pm), each run writes to its own
dated-hour folder so artifacts do not overwrite each other.

## Failure Recovery

If a run crashes mid-cycle, the next cron fires a fresh run from step 1.
Partial output from the failed run remains in its folder for inspection.
The SQLite database is the source of truth for seen/delivered state -- it is
written atomically per upsert, so a mid-run crash does not corrupt prior state.
Items that were collected but not delivered will be re-eligible in the next run
(within the suppress_delivered_hours window).
