#!/usr/bin/env bash
# coverage-floor-watch.sh — SYS-COVERAGE-CONSUME-01 Part 2 (absolute/chronic floor watch)
#
# WHY: the per-sync field_coverage_anomaly detector (PR #1366) catches full-breaks
# (zero_floor) and large NEW regressions (drop_trend >=30pp). It STRUCTURALLY misses
# the cbd-396 class — a chronic, sub-30pp partial gap on a core field that never hits
# 0% and has no "drop" to trend (cbd sat ~88% chronically during the bug). That class
# is visible only in ABSOLUTE field coverage. dataQualityReportPublic computes exactly
# that (full-catalog, point-in-time). This watch reads it on the SA health-monitoring
# cadence and flags any core V2-gating field below a CALIBRATED floor.
#
# Floors are set with headroom BELOW today's steady-state (2026-06-16) and ABOVE the
# genuine-null floor measured that day (full-catalog cbd-null ~396 = manual ~360 +
# Cannaleo-genuine ~28 + HiGreen 8; genetics ~816 incl ~426 manual cohort). They are
# deliberately loose: this watch pages on a REGRESSION below the known floor, not on
# the legitimate manual-cohort gap. Re-calibrate if the manual cohort grows materially.
#
# Run: bash scripts/coverage-floor-watch.sh   (read-only; convex run --prod)
# Exit: 0 = all core fields above floor; 1 = at least one BREACH (route to PD lane).
set -euo pipefail

SAAS_DIR="${PHYTOMEDIC_SAAS_DIR:-/Users/arndt/phytomedic-saas}"

# Calibrated floors (percent). Core V2-gating fields present in dataQualityReportPublic.
# (category is NOT in dataQualityReportPublic.fieldCoverage — it stays with the per-sync
#  detector only.) Today's steady-state in comments.
FLOOR_cbdPercent=89.0   # today 92.24 — ~3pp headroom over the manual-cohort floor
FLOOR_thcPercent=95.0   # today 98.37
FLOOR_genetics=80.0     # today 84.01 — ~4pp headroom

REPORT_JSON="$(cd "$SAAS_DIR" && npx convex run --prod functions/cannametrics:dataQualityReportPublic '{}' 2>/dev/null)"

if [ -z "$REPORT_JSON" ]; then
  echo "COVERAGE-FLOOR-WATCH: ERROR — empty response from dataQualityReportPublic (prod auth / network?)" >&2
  exit 2
fi

FLOOR_cbdPercent="$FLOOR_cbdPercent" FLOOR_thcPercent="$FLOOR_thcPercent" FLOOR_genetics="$FLOOR_genetics" \
python3 - "$REPORT_JSON" <<'PY'
import json, os, sys
report = json.loads(sys.argv[1])
fc = report.get("fieldCoverage", {}) or {}
total = report.get("totalProducts")
floors = {
    "cbdPercent": float(os.environ["FLOOR_cbdPercent"]),
    "thcPercent": float(os.environ["FLOOR_thcPercent"]),
    "genetics":   float(os.environ["FLOOR_genetics"]),
}
breaches = []
lines = []
for field, floor in floors.items():
    cov = fc.get(field)
    if cov is None:
        lines.append(f"  {field}: MISSING from report (field renamed? investigate)")
        breaches.append({"field": field, "coverage": None, "floor": floor, "reason": "field_absent_from_report"})
        continue
    status = "OK" if cov >= floor else "BREACH"
    lines.append(f"  {field}: {cov}% (floor {floor}%) -> {status}")
    if cov < floor:
        breaches.append({"field": field, "coverage": cov, "floor": floor, "reason": "below_calibrated_floor"})

print(f"COVERAGE-FLOOR-WATCH (totalProducts={total}):")
print("\n".join(lines))
if breaches:
    print("\nBREACH — route to PD lane (chronic core-field coverage below calibrated floor):")
    print(json.dumps(breaches, indent=2))
    sys.exit(1)
print("\nAll core V2-gating fields above calibrated floor.")
sys.exit(0)
PY
