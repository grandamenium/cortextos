#!/usr/bin/env bash
# dispatch-marker.sh — deterministic SA→FE/BA auto-dispatcher.
# Reassigns tasks whose TITLE carries an explicit "[PRE-DISPATCH-READY:<role>]" marker
# to <role>, rewrites the marker to "[DISPATCHED:<role>]" (idempotent), audits + notifies.
# Opt-in: only explicitly :role-tagged tasks are touched; markerless stays PD-gated.
# Drift-safe: standalone launchd script, no src/ build, no pm2 restart.
# Clone of assignee-reconcile.sh technique, hardened: atomic write, stale-claim skip,
# saturation gate, marker-vs-prose conflict guard.
#
# Env:
#   CTX_ROOT (default ~/.cortextos/default), CTX_ORG (default phytomedic)
#   DISPATCH_TASK_DIR  — override task dir (tests)
#   DISPATCH_DRY_RUN=1 — log only, no writes
#   DISPATCH_NO_BUS=1  — skip cortextos bus notify/log-event (tests)
#   DISPATCH_CAP_BA (default 45), DISPATCH_CAP_FE (default 30)
set -uo pipefail

TASK_DIR="${DISPATCH_TASK_DIR:-${CTX_ROOT:-$HOME/.cortextos/default}/orgs/${CTX_ORG:-phytomedic}/tasks}"
DRY="${DISPATCH_DRY_RUN:-0}"
NO_BUS="${DISPATCH_NO_BUS:-0}"
CAP_BA="${DISPATCH_CAP_BA:-45}"
CAP_FE="${DISPATCH_CAP_FE:-30}"
LOG_PREFIX="[dispatch-marker $(date -u +%Y-%m-%dT%H:%M:%SZ)]"
VALID_AGENTS="backend-architect frontend-dev systems-analyst platform-director cannametrics-data integrations-routing cortextos-improver devops-monitor product-owner user-proxy"

[ -d "$TASK_DIR" ] || { echo "$LOG_PREFIX TASK_DIR not found: $TASK_DIR" >&2; exit 1; }

# Core scan/decide/write in one python pass (atomic). Emits machine-readable lines.
OUTPUT=$(TASK_DIR="$TASK_DIR" DRY="$DRY" VALID="$VALID_AGENTS" CAP_BA="$CAP_BA" CAP_FE="$CAP_FE" \
  NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)" python3 - <<'PY'
import json, os, re, glob, sys

TASK_DIR = os.environ['TASK_DIR']
DRY = os.environ['DRY'] == '1'
VALID = set(os.environ['VALID'].split())
NOW = os.environ['NOW']
CAPS = {'backend-architect': int(os.environ['CAP_BA']), 'frontend-dev': int(os.environ['CAP_FE'])}
AUDIT_DIR = os.path.join(TASK_DIR, 'audit')
CLAIMS_DIR = os.path.join(TASK_DIR, '.claims')
MARKER = re.compile(r'^\[PRE-DISPATCH-READY:([a-z][a-z0-9-]+)\]')
PROSE = re.compile(r'(?:^|\.\s+)Assignee:\s+([a-z][a-z0-9-]+)(?=[\s.,;]|$)', re.MULTILINE)

def load(p):
    try:
        with open(p) as f: return json.load(f)
    except Exception: return None

def atomic_write(p, d):
    if DRY: return
    tmp = p + '.tmp'
    with open(tmp, 'w') as f: json.dump(d, f, indent=2, ensure_ascii=False)
    os.replace(tmp, p)

def audit(tid, frm, to):
    if DRY or not os.path.isdir(AUDIT_DIR): return
    rec = {'event': 'marker_dispatch', 'from': frm, 'to': to,
           'reason': '[PRE-DISPATCH-READY:role] auto-dispatch', 'timestamp': NOW, 'by': 'marker-dispatcher'}
    with open(os.path.join(AUDIT_DIR, tid + '.jsonl'), 'a') as f:
        f.write(json.dumps(rec, ensure_ascii=False) + '\n')

if not DRY:
    os.makedirs(AUDIT_DIR, exist_ok=True)  # C5: never silently skip the audit trail

# pending-count per role (for saturation gate), computed once
pending = {}
docs = {}
for p in glob.glob(os.path.join(TASK_DIR, 'task_*.json')):
    d = load(p)
    if not d: continue
    docs[p] = d
    if d.get('status') == 'pending' and not d.get('archived', False):
        pending[d.get('assigned_to', '')] = pending.get(d.get('assigned_to', ''), 0) + 1

dispatched = held = skipped = 0
for p, d in docs.items():
    if d.get('status') != 'pending' or d.get('archived', False):
        continue
    title = d.get('title', '')
    m = MARKER.match(title)
    if not m:
        continue  # markerless → PD territory
    role = m.group(1)
    tid = d.get('id', '')
    cur = d.get('assigned_to', '')
    if role not in VALID:
        print(f"SKIP\tbad-role:{role}\t{tid}"); skipped += 1; continue
    if role == cur:
        print(f"SKIP\talready:{role}\t{tid}"); skipped += 1; continue
    # marker-vs-prose conflict guard (avoid flip-flop war with assignee-reconcile)
    prose = [x for x in PROSE.findall(d.get('description', '')) if x in VALID]
    if prose and prose[-1] != role:
        print(f"SKIP\tprose-conflict:{prose[-1]}!={role}\t{tid}"); skipped += 1; continue
    # stale-claim guard
    claim = os.path.join(CLAIMS_DIR, tid + '.claim')
    if os.path.exists(claim):
        try: owner = open(claim).read().split('\t')[0].strip()
        except Exception: owner = '?'
        if owner != role:
            print(f"SKIP\tstale-claim:{owner}\t{tid}"); skipped += 1; continue
    # saturation gate
    cap = CAPS.get(role)
    if cap is not None and pending.get(role, 0) > cap:
        print(f"HOLD\t{role}:{pending.get(role,0)}>{cap}\t{tid}"); held += 1; continue
    # C2: CAS re-read right before write — skip if another writer (e.g. assignee-reconcile
    # cron, which does a non-atomic in-place write) changed this task since the snapshot.
    fresh = load(p)
    if (not fresh or fresh.get('status') != 'pending' or fresh.get('archived', False)
            or fresh.get('assigned_to') != cur or not MARKER.match(fresh.get('title', ''))):
        print(f"SKIP\tchanged-concurrently\t{tid}"); skipped += 1; continue
    # write: reassign + rewrite marker → [DISPATCHED:role] (idempotent) + bump updated_at
    fresh['assigned_to'] = role
    fresh['title'] = MARKER.sub(f'[DISPATCHED:{role}]', fresh['title'], count=1)
    fresh['updated_at'] = NOW
    try:
        atomic_write(p, fresh)  # C3: a single unwritable file must not abort the whole run
    except Exception as e:
        print(f"SKIP\twrite-failed:{type(e).__name__}\t{tid}"); skipped += 1; continue
    audit(tid, cur, role)
    pending[role] = pending.get(role, 0) + 1  # count it toward the gate for subsequent tasks
    safe_tid = tid.replace('\t', ' ')  # C1
    safe_title = fresh['title'].replace('\t', ' ').replace('\n', ' ').replace('\r', ' ')[:80]  # C4
    print(f"DISPATCH\t{safe_tid}\t{role}\t{safe_title}")
    dispatched += 1

print(f"SUMMARY\t{dispatched}\t{held}\t{skipped}")
PY
)

echo "$OUTPUT" | grep -vE '^SUMMARY' | while IFS=$'\t' read -r kind a b c; do
  case "$kind" in
    DISPATCH) echo "$LOG_PREFIX DISPATCH $a -> $b  ($c)";;
    HOLD)     echo "$LOG_PREFIX HOLD $b ($a saturated)";;
    SKIP)     echo "$LOG_PREFIX skip $b ($a)";;
  esac
done

SUMMARY=$(echo "$OUTPUT" | grep -E '^SUMMARY' | head -1)
D=$(echo "$SUMMARY" | cut -f2); H=$(echo "$SUMMARY" | cut -f3); S=$(echo "$SUMMARY" | cut -f4)
echo "$LOG_PREFIX Done: ${D:-0} dispatched, ${H:-0} held(saturated), ${S:-0} skipped.$([ "$DRY" = 1 ] && echo ' (DRY-RUN)')"

# Notify assignees + log bus event (skipped in tests / dry-run)
if [ "$NO_BUS" != 1 ] && [ "$DRY" != 1 ]; then
  echo "$OUTPUT" | grep -E '^DISPATCH' | while IFS=$'\t' read -r _ tid role title; do
    cortextos bus send-message "$role" normal "Task $tid auto-dispatched to you: $title" 2>/dev/null || true
  done
  cortextos bus log-event action marker_dispatch info \
    --meta "{\"dispatched\":${D:-0},\"held\":${H:-0},\"skipped\":${S:-0}}" 2>/dev/null || true
fi
