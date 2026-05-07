#!/usr/bin/env bash
# plan-review-gate.sh — Enforce the Plan-First Review rule at git push time.
#
# Invoked by scripts/hooks/pre-push BEFORE build + tests run. Looks for a
# `.claude/plan-reviews/<branch-slug>-plan.md` file containing either:
#   - a `QUORUM: PASS (N/10)` line with N >= 8 AND mandatory personas
#     (Security + DataIntegrity) present and not marked FAIL/REJECT, OR
#   - a `TRIVIAL-TASK-EXEMPT: <one-sentence reason>` line for tiny work
#     (typo, doc tweak, single-line fix). Telemetry-logged for post-hoc.
#
# Spec source: SOUL.md "Plan-First Review (Logan directive 2026-04-22, from
# Bradley Banner)" section, codified fleet-wide via PR #216. This script is
# the tool-level gate that closes the W9b follow-up (the rule was previously
# enforced by convention only).
#
# Environment overrides:
#   PLAN_REVIEW_BYPASS=true       skip the gate entirely (documented escape)
#   PLAN_REVIEW_BRANCH=<name>     override branch detection (test seam)
#   PLAN_REVIEW_DIR=<path>        override .claude/plan-reviews location
#   PLAN_REVIEW_PROTECTED_REGEX   default: ^(main|master|develop|HEAD)$
#
# Exit codes:
#   0 = PASS (gate satisfied OR skipped because branch is protected/bypassed)
#   1 = BLOCK (plan file missing, malformed, or panel verdict insufficient)
#
# macOS bash 3.2 compatible. No mapfile / readarray.

set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "[plan-review-gate] Not inside a git repository — skipping." >&2
  exit 0
}

BRANCH="${PLAN_REVIEW_BRANCH:-}"
if [[ -z "$BRANCH" ]]; then
  BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
fi

if [[ -z "$BRANCH" ]]; then
  echo "[plan-review-gate] Could not determine branch (detached HEAD?). Skipping gate." >&2
  exit 0
fi

PROTECTED_REGEX="${PLAN_REVIEW_PROTECTED_REGEX:-^(main|master|develop|HEAD)$}"
if [[ "$BRANCH" =~ $PROTECTED_REGEX ]]; then
  echo "[plan-review-gate] On protected branch '$BRANCH' — skipping gate."
  exit 0
fi

if [[ "${PLAN_REVIEW_BYPASS:-}" == "true" ]]; then
  echo "[plan-review-gate] PLAN_REVIEW_BYPASS=true — gate bypassed for branch '$BRANCH'." >&2
  # Best-effort telemetry so bypass usage is visible on the dashboard.
  if command -v cortextos >/dev/null 2>&1; then
    cortextos bus log-event action plan_review_bypassed info \
      --meta "$(printf '{"branch":"%s","reason":"PLAN_REVIEW_BYPASS env var"}' "$BRANCH")" \
      >/dev/null 2>&1 || true
  fi
  exit 0
fi

PLAN_DIR="${PLAN_REVIEW_DIR:-$REPO_ROOT/.claude/plan-reviews}"
# Branch names can contain "/" (e.g. feat/foo). Translate to "-" for the
# filename so we don't fight nested-dir creation in the plan-reviews tree.
SLUG="${BRANCH//\//-}"
PLAN_FILE="$PLAN_DIR/${SLUG}-plan.md"

if [[ ! -f "$PLAN_FILE" ]]; then
  cat >&2 <<EOF
[plan-review-gate] BLOCKED: Plan-First Review file is missing.

Branch:    $BRANCH
Expected:  ${PLAN_FILE#$REPO_ROOT/}

The Plan-First Review rule (codified fleet-wide via PR #216, originally from
Bradley Banner) requires every non-trivial branch to carry a 10-persona
reviewer panel decision in the repo BEFORE the push.

Create the plan file by copying the template:
  cp .claude/plan-reviews/TEMPLATE-plan.md "${PLAN_FILE#$REPO_ROOT/}"
  # then fill in the panel verdicts and commit.

For genuinely trivial work (typo, doc tweak, 1-line config), the file may
contain a single line:
  TRIVIAL-TASK-EXEMPT: <one-sentence reason>

Override (last resort, telemetry-logged): PLAN_REVIEW_BYPASS=true git push.
Reference: SOUL.md "Plan-First Review" section.
EOF
  exit 1
fi

# ── Trivial-task exemption path ──────────────────────────────────────────────
if grep -qE "^TRIVIAL-TASK-EXEMPT:" "$PLAN_FILE"; then
  REASON="$(grep -E "^TRIVIAL-TASK-EXEMPT:" "$PLAN_FILE" | head -n 1 | sed 's/^TRIVIAL-TASK-EXEMPT:[[:space:]]*//')"
  if [[ -z "$REASON" ]]; then
    echo "[plan-review-gate] BLOCKED: TRIVIAL-TASK-EXEMPT requires a one-sentence reason after the colon." >&2
    echo "[plan-review-gate] Edit '${PLAN_FILE#$REPO_ROOT/}' and add the reason." >&2
    exit 1
  fi
  echo "[plan-review-gate] PASS (trivial-task-exempt): $REASON"
  if command -v cortextos >/dev/null 2>&1; then
    cortextos bus log-event action plan_review_trivial_exempt info \
      --meta "$(printf '{"branch":"%s","reason":"%s"}' "$BRANCH" "${REASON//\"/\\\"}")" \
      >/dev/null 2>&1 || true
  fi
  exit 0
fi

# ── Full-panel path: QUORUM line check ───────────────────────────────────────
QUORUM_LINE="$(grep -E "^QUORUM:[[:space:]]*PASS" "$PLAN_FILE" | head -n 1 || true)"
if [[ -z "$QUORUM_LINE" ]]; then
  cat >&2 <<EOF
[plan-review-gate] BLOCKED: '${PLAN_FILE#$REPO_ROOT/}' has no 'QUORUM: PASS' line.

Run the 10-persona reviewer panel on the plan and add the verdict line to
the file. Format (after the panel table):
  QUORUM: PASS (8/10)

The line must start with 'QUORUM: PASS'. Optional trailing '(N/10)' where
N is the count of personas who voted PASS. Minimum N is 8.
EOF
  exit 1
fi

# Extract N/10 if present and enforce >= 8.
RATIO="$(echo "$QUORUM_LINE" | grep -oE '[0-9]+/10' | head -n 1 || true)"
if [[ -n "$RATIO" ]]; then
  PASS_COUNT="${RATIO%/10}"
  if [[ "$PASS_COUNT" -lt 8 ]]; then
    echo "[plan-review-gate] BLOCKED: panel quorum is $RATIO; minimum is 8/10." >&2
    echo "[plan-review-gate] Address the dissenting personas and re-run the panel." >&2
    exit 1
  fi
fi

# ── Mandatory persona check: Security + DataIntegrity ────────────────────────
# Both personas must be present in the file AND their row must not contain a
# verdict word like FAIL / REJECT / BLOCK (and common inflections). Match
# either a markdown table row ("| Security | PASS | ...") or a heading
# ("## Security PASS ...") so authors aren't locked into one format.
#
# Word-boundary matching (grep -w) is critical: prose words like "failure",
# "blocking", "non-blocking", "unblocking", "rejection" are perfectly normal
# in plan-review notes and should NOT trip the gate. The previous substring
# match (`grep -iE "FAIL|REJECT|BLOCK"`) false-positived on those, forcing
# authors to rewrite legitimate prose. See task_1777093291910_415 + PR #248.
PERSONA_VERDICT_PATTERN='FAIL|FAILED|FAILS|REJECT|REJECTED|REJECTS|BLOCK|BLOCKED|BLOCKS'
for persona in Security DataIntegrity; do
  PERSONA_LINE="$(grep -iE "(^|\\|)[[:space:]]*${persona}\\b" "$PLAN_FILE" | head -n 1 || true)"
  if [[ -z "$PERSONA_LINE" ]]; then
    echo "[plan-review-gate] BLOCKED: mandatory persona '$persona' is missing from '${PLAN_FILE#$REPO_ROOT/}'." >&2
    echo "[plan-review-gate] Both Security and DataIntegrity reviewers are required, regardless of quorum." >&2
    exit 1
  fi
  if echo "$PERSONA_LINE" | grep -wqiE "$PERSONA_VERDICT_PATTERN"; then
    echo "[plan-review-gate] BLOCKED: mandatory persona '$persona' verdict is not PASS in '${PLAN_FILE#$REPO_ROOT/}'." >&2
    echo "[plan-review-gate] Address $persona's concerns before the push." >&2
    exit 1
  fi
done

echo "[plan-review-gate] PASS: $QUORUM_LINE (Security + DataIntegrity verified)"
if command -v cortextos >/dev/null 2>&1; then
  cortextos bus log-event action plan_review_passed info \
    --meta "$(printf '{"branch":"%s","quorum":"%s"}' "$BRANCH" "${QUORUM_LINE//\"/\\\"}")" \
    >/dev/null 2>&1 || true
fi
exit 0
