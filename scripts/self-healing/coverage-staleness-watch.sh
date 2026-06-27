#!/usr/bin/env bash
# coverage-staleness-watch.sh — SYS-COVERAGE-STALENESS-01 (silent-stall → signal)
#
# WHY: per-field coverage telemetry (PR #1366/#1367/#1368) is ACTIVITY-TRIGGERED —
# recordFieldCoverageSnapshot writes a fieldCoverageSnapshots row ONLY when a full
# sync pass completes. So a sync STALL makes the whole chain go SILENT, not RED:
# "no new snapshot" reads as healthy when it can mean the monitored sync died.
# During the prod-freshness-probe's dev-blind window (PROD_CONVEX_URL drifted to
# dev opulent-mockingbird-934, 2026-06-16) a real-prod sync stall would have been
# invisible to BOTH the probe (pointed at dev) and the coverage chain (silent).
# This watch turns that silence into a signal — a daily DEFENSE-IN-DEPTH backstop
# to devops' fast freshness probe, reached via the deploy-key --prod path that
# CANNOT drift to a wrong deployment the way a PROD_CONVEX_URL env var can.
#
# WHAT: read the newest fieldCoverageSnapshots row per actively-synced provider
# (cannaleo, higreen — the only two with full-sync crons that write snapshots)
# and check the age of computedAt.
#
# THRESHOLDS (grounded in cadence): both full syncs run 3×/day at 03/11/19 UTC
# (cannaleo "7 3,11,19 * * *", higreen "22 3,11,19 * * *" — ARCH-CONVEX-SYNC PR-1),
# i.e. exactly 8h apart, so a snapshot should land ~every 8h.
#   WARN  >16h = 2 consecutive missed full syncs (+ margin) — surfaced as a soft
#               heads-up, NOT a single-skip false fire.
#   ALERT >24h = 3 consecutive missed full syncs, OR no snapshot at all for an
#               active provider — page PD.
# Lenient by design (aligned to the WARN720/ALERT960 sync-gap re-baseline).
#
# Run:  bash scripts/coverage-staleness-watch.sh   (read-only; convex run --prod)
# Exit: 0 = all providers fresh (<WARN)        — no fire
#       1 = >=1 provider at ALERT (>24h / none) — route ALERT to PD lane
#       3 = WARN-only (>16h, none at ALERT)      — route WARN heads-up to PD lane
#       2 = probe error (empty/unreadable)       — probe-blind, do NOT fire
set -euo pipefail

SAAS_DIR="${PHYTOMEDIC_SAAS_DIR:-/Users/arndt/phytomedic-saas}"

# Actively-synced providers (have a full-sync cron writing fieldCoverageSnapshots).
# cannaflow/wawican/greeners/gruenhorn are V1-dark — no sync cron, never snapshot —
# so they are intentionally excluded (would false-fire as permanently stale).
PROVIDERS=(cannaleo higreen)

WARN_HOURS="${COVERAGE_STALENESS_WARN_HOURS:-16}"
ALERT_HOURS="${COVERAGE_STALENESS_ALERT_HOURS:-24}"

# Collect newest computedAt per provider via the deploy-key --prod path.
# recentCoverageSnapshots is an internalQuery, callable by `convex run` (admin).
# Build "provider=computedAt;" pairs ("" computedAt = no snapshot) for python.
# (Plain string, not an associative array — portable to macOS bash 3.2.)
PAIRS=""
PROBE_ERR=0
for p in "${PROVIDERS[@]}"; do
  RAW="$(cd "$SAAS_DIR" && npx convex run --prod \
    functions/fieldCoverageTelemetry:recentCoverageSnapshots \
    "{\"provider\":\"$p\",\"limit\":1}" 2>/dev/null || true)"
  if [ -z "$RAW" ]; then
    echo "COVERAGE-STALENESS-WATCH: ERROR — empty response for provider=$p (prod auth / network?)" >&2
    PROBE_ERR=1
    continue
  fi
  # Extract newest computedAt (or empty if no rows). Bad JSON -> probe error.
  CA="$(printf '%s' "$RAW" | python3 -c "
import json,sys
try:
    rows=json.load(sys.stdin)
except Exception:
    sys.exit(3)
print(rows[0]['computedAt'] if rows else '')
" 2>/dev/null)" || { echo "COVERAGE-STALENESS-WATCH: ERROR — unparseable response for provider=$p" >&2; PROBE_ERR=1; continue; }
  PAIRS+="$p=$CA;"
done

# If ANY provider probe failed to return readable data, exit probe-blind (2) rather
# than risk a false ALERT — same fail-safe posture as coverage-floor-watch.sh.
if [ "$PROBE_ERR" -ne 0 ]; then
  echo "COVERAGE-STALENESS-WATCH: aborting probe-blind (>=1 provider unreadable) — NOT firing." >&2
  exit 2
fi

WARN_HOURS="$WARN_HOURS" ALERT_HOURS="$ALERT_HOURS" PAIRS="$PAIRS" python3 - <<'PY'
import json, os, sys, time

warn_h = float(os.environ["WARN_HOURS"])
alert_h = float(os.environ["ALERT_HOURS"])
now_ms = time.time() * 1000.0  # wall-clock now; snapshots store computedAt = Date.now() (ms)

pairs = [x for x in os.environ["PAIRS"].split(";") if x]
alerts, warns, lines = [], [], []
for pair in pairs:
    prov, _, ca = pair.partition("=")
    if not ca:
        lines.append(f"  {prov}: NO SNAPSHOT (active provider, chain silent) -> ALERT")
        alerts.append({"provider": prov, "ageHours": None, "reason": "no_snapshot_for_active_provider",
                       "threshold": alert_h})
        continue
    age_h = (now_ms - float(ca)) / 3_600_000.0
    if age_h > alert_h:
        status, bucket = "ALERT", alerts
    elif age_h > warn_h:
        status, bucket = "WARN", warns
    else:
        status, bucket = "OK", None
    lines.append(f"  {prov}: newest snapshot {age_h:.1f}h old "
                 f"(WARN>{warn_h:.0f}h, ALERT>{alert_h:.0f}h) -> {status}")
    if bucket is not None:
        bucket.append({"provider": prov, "ageHours": round(age_h, 1),
                       "reason": f"snapshot_stale_{status.lower()}",
                       "threshold": alert_h if status == "ALERT" else warn_h})

print("COVERAGE-STALENESS-WATCH (fieldCoverageSnapshots recency, prod=majestic-bison-443):")
print("\n".join(lines))

if alerts:
    print("\nALERT — route to PD lane (active-provider coverage snapshot stale >24h "
          "= sync chain silently stalled, telemetry blind):")
    print(json.dumps(alerts, indent=2))
    sys.exit(1)
if warns:
    print("\nWARN — soft heads-up to PD lane (snapshot >16h = 2 missed full syncs; "
          "watch for escalation to ALERT):")
    print(json.dumps(warns, indent=2))
    sys.exit(3)
print("\nAll active providers fresh (<16h) — sync→snapshot chain healthy.")
sys.exit(0)
PY
