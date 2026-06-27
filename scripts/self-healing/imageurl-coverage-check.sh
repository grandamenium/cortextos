#!/usr/bin/env bash
# imageurl-coverage-check.sh — SYS-FIELD-COVERAGE-01 (imageUrl drop-detection)
#
# WHY: missingImageUrl=100% is the steady WIP baseline pre-provider-engagement
# (task_1780845376873 T-E). Filing it nightly is noise. But once providers populate
# images and coverage goes non-zero, a subsequent DROP is a real regression —
# images were served, then lost (provider feed change, transformer bug, schema change).
# The per-sync field_coverage_anomaly detector (PR #1366) catches within-sync drops
# but cannot distinguish "never had images" from "had images, now 0%". This watch
# tracks the historically highest non-zero coverage so a later drop fires exactly once.
#
# MECHANISM:
#   - Read imageUrl coverage % from dataQualityReportPublic (auth-free, prod).
#   - If coverage == 0: WIP — update last-checked, stay silent.
#   - If coverage > 0: update the non-zero baseline. If this is LOWER than the prior
#     non-zero baseline by >TOLERANCE pp: ALERT regression. Else CLEAR.
#
# STATE FILE: scripts/imageurl-coverage-baseline.json
#   { "lastNonZeroCoverage": null, "lastNonZeroDate": null,
#     "lastCheckedDate": null, "lastCheckedCoverage": null }
#
# Run:  bash scripts/imageurl-coverage-check.sh
# Exit: 0 = WIP or CLEAR (no alert)
#       1 = ALERT (coverage dropped from known non-zero baseline)
#       2 = probe error (do NOT fire)
set -euo pipefail

SAAS_DIR="${PHYTOMEDIC_SAAS_DIR:-/Users/arndt/phytomedic-saas}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Baseline (regression memory) lives in CTX_ROOT/state (outside the repo) — never next to
# the tracked script, so relocating into scripts/self-healing/ produces zero tracked churn.
BASELINE_FILE="${IMAGEURL_BASELINE_FILE:-${CTX_ROOT:-$HOME/.cortextos/default}/state/imageurl-coverage-baseline.json}"
mkdir -p "$(dirname "$BASELINE_FILE")" 2>/dev/null || true

# Tolerance in percentage points below the last known non-zero coverage.
TOLERANCE="${IMAGEURL_COVERAGE_TOLERANCE:-5.0}"

REPORT_JSON="$(cd "$SAAS_DIR" && npx convex run --prod functions/cannametrics:dataQualityReportPublic '{}' 2>/dev/null)"

if [ -z "$REPORT_JSON" ]; then
  echo "IMAGEURL-COVERAGE-CHECK: ERROR — empty response from dataQualityReportPublic (prod auth / network?)" >&2
  exit 2
fi

TOLERANCE="$TOLERANCE" BASELINE_FILE="$BASELINE_FILE" python3 - "$REPORT_JSON" <<'PY'
import json, os, sys, time

report = json.loads(sys.argv[1])
fc = report.get("fieldCoverage") or {}
total = report.get("totalProducts")
coverage = fc.get("imageUrl")

if coverage is None:
    print("IMAGEURL-COVERAGE-CHECK: ERROR — imageUrl missing from fieldCoverage", file=sys.stderr)
    sys.exit(2)

tolerance = float(os.environ["TOLERANCE"])
baseline_file = os.environ["BASELINE_FILE"]
now_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

# Load baseline (create if absent)
try:
    with open(baseline_file) as f:
        baseline = json.load(f)
except FileNotFoundError:
    baseline = {}
except json.JSONDecodeError as e:
    print(f"IMAGEURL-COVERAGE-CHECK: ERROR — baseline file corrupt: {e}", file=sys.stderr)
    sys.exit(2)

last_non_zero = baseline.get("lastNonZeroCoverage")

# Always update last-checked fields
baseline["lastCheckedDate"] = now_iso
baseline["lastCheckedCoverage"] = coverage
if total is not None:
    baseline["lastCheckedTotal"] = total

if coverage == 0:
    # Steady WIP — coverage never been non-zero or reverted
    tmp = baseline_file + ".tmp"
    with open(tmp, "w") as f:
        json.dump(baseline, f, indent=2)
    os.replace(tmp, baseline_file)
    print(f"IMAGEURL-COVERAGE-CHECK: WIP — imageUrl coverage 0% "
          f"(pre-provider-engagement baseline; {total or '?'} active products). "
          f"Drop-detection suppressed until coverage goes non-zero.")
    sys.exit(0)

# Coverage > 0: check for regression then update baseline
if last_non_zero is not None and coverage < (last_non_zero - tolerance):
    delta = last_non_zero - coverage
    # Still save the new reading (regression documented, don't lose the data)
    baseline["lastNonZeroCoverage"] = coverage
    baseline["lastNonZeroDate"] = now_iso
    tmp = baseline_file + ".tmp"
    with open(tmp, "w") as f:
        json.dump(baseline, f, indent=2)
    os.replace(tmp, baseline_file)
    msg = (
        f"IMAGEURL-COVERAGE-CHECK: ALERT — imageUrl coverage dropped from "
        f"{last_non_zero:.2f}% to {coverage:.2f}% "
        f"(Δ -{delta:.2f}pp, tolerance -{tolerance}pp). "
        f"Total active products: {total or '?'}. "
        f"Possible causes: provider feed no longer sends image_url, "
        f"transformer regression, or schema change. Check cannaleo/higreen "
        f"transformer.ts and provider feed samples."
    )
    print(json.dumps({
        "status": "ALERT",
        "coverage": coverage,
        "prior": last_non_zero,
        "delta": round(last_non_zero - coverage, 2),
        "tolerance": tolerance,
        "totalProducts": total,
        "message": msg,
    }, indent=2))
    sys.exit(1)

# Non-zero, no regression — update baseline
baseline["lastNonZeroCoverage"] = max(coverage, last_non_zero or 0)
baseline["lastNonZeroDate"] = now_iso
tmp = baseline_file + ".tmp"
with open(tmp, "w") as f:
    json.dump(baseline, f, indent=2)
os.replace(tmp, baseline_file)
print(
    f"IMAGEURL-COVERAGE-CHECK: CLEAR — imageUrl coverage {coverage:.2f}% "
    f"(baseline {last_non_zero or 'first-read'}%; {total or '?'} active products). "
    f"No regression detected."
)
sys.exit(0)
PY
