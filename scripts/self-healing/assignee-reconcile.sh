#!/usr/bin/env bash
# Reconciles tasks where description has "Assignee: X" but assigned_to != X.
# Safety-net for audit-finding workflow that writes Assignee: in prose
# but may not pass --assignee to create-task. Incident: 2026-05-30 (29 tasks).
# Run by: cortextos-improver via 4h cron (assignee-reconcile-4h).

set -euo pipefail

TASK_DIR="${HOME}/.cortextos/default/orgs/${CTX_ORG:-phytomedic}/tasks"
AUDIT_DIR="${TASK_DIR}/audit"
LOG_PREFIX="[assignee-reconcile $(date -u +%Y-%m-%dT%H:%M:%SZ)]"

# Known valid agent names — only reroute to agents in this list
VALID_AGENTS="backend-architect frontend-dev systems-analyst platform-director cannametrics-data integrations-routing cortextos-improver devops-monitor product-owner user-proxy"

mkdir -p "$AUDIT_DIR"

reassigned=0
skipped=0

for f in "$TASK_DIR"/task_*.json; do
  [ -f "$f" ] || continue

  # Skip archived/completed tasks
  status=$(python3 -c "import json; d=json.load(open('$f')); print(d.get('status',''))" 2>/dev/null)
  if [[ "$status" == "completed" || "$status" == "cancelled" ]]; then
    ((skipped++)) || true
    continue
  fi

  archived=$(python3 -c "import json; d=json.load(open('$f')); print(d.get('archived', False))" 2>/dev/null)
  if [[ "$archived" == "True" ]]; then
    ((skipped++)) || true
    continue
  fi

  # Extract "Assignee: X" from description.
  # Only match line-start occurrences (standalone label, not embedded in prose/quotes).
  # Only match known agent names to avoid placeholders like "Assignee: X" or "Assignee: backend-architect (etc.)".
  desc_assignee=$(python3 -c "
import json, re
d = json.load(open('$f'))
desc = d.get('description', '')
valid = set('$VALID_AGENTS'.split())
# Only match 'Assignee: agent-name' at line start OR after '. ' (end of sentence),
# and where the agent name is the entire word (not inside quotes or parens).
# Pattern: start of line or sentence end, then 'Assignee: <agent>.' or 'Assignee: <agent> ' or EOL.
matches = re.findall(r'(?:^|\.\s+)Assignee:\s+([a-z][a-z0-9-]+)(?=[\s.,;]|\$)', desc, re.MULTILINE)
result = next((m for m in reversed(matches) if m in valid), '')
print(result)
" 2>/dev/null)

  [ -z "$desc_assignee" ] && continue

  # Extract current assigned_to and task metadata using env var to avoid injection
  read -r current_assignee task_id task_title < <(TASK_FILE="$f" python3 - <<'PY'
import json, os
d = json.load(open(os.environ['TASK_FILE']))
print(d.get('assigned_to',''), d.get('id',''), d.get('title','')[:80])
PY
  ) 2>/dev/null

  [ -z "$task_id" ] && continue

  if [[ "$current_assignee" == "$desc_assignee" ]]; then
    continue
  fi

  # Validate task_id as safe filename component (alphanumeric, underscore, hyphen only)
  if ! [[ "$task_id" =~ ^[A-Za-z0-9_-]+$ ]]; then
    echo "$LOG_PREFIX Skipping unsafe task_id: $task_id" >&2
    continue
  fi

  echo "$LOG_PREFIX Rerouting $task_id: $current_assignee -> $desc_assignee ($task_title)"

  # Update assigned_to in-place — pass new value via env, not string interpolation
  TASK_FILE="$f" NEW_ASSIGNEE="$desc_assignee" python3 - <<'PY' 2>/dev/null
import json, os
path = os.environ['TASK_FILE']
with open(path) as fh:
    d = json.load(fh)
d['assigned_to'] = os.environ['NEW_ASSIGNEE']
with open(path, 'w') as fh:
    json.dump(d, fh)
PY

  # Append audit record — all values via env vars, no string interpolation into Python source
  audit_file="$AUDIT_DIR/${task_id}.jsonl"
  AUDIT_FILE="$audit_file" \
  CURRENT_ASSIGNEE="$current_assignee" \
  DESC_ASSIGNEE="$desc_assignee" \
  BY_AGENT="${CTX_AGENT_NAME:-cortextos-improver}" \
  python3 - <<'PY' 2>/dev/null
import json, os
from datetime import datetime
record = {
  'event': 'assignee_reconcile',
  'from': os.environ['CURRENT_ASSIGNEE'],
  'to': os.environ['DESC_ASSIGNEE'],
  'reason': 'Assignee: line in description did not match assigned_to — auto-corrected by assignee-reconcile cron',
  'timestamp': datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'),
  'by': os.environ['BY_AGENT'],
}
with open(os.environ['AUDIT_FILE'], 'a') as f:
    f.write(json.dumps(record) + '\n')
PY

  ((reassigned++)) || true
done

echo "$LOG_PREFIX Done: $reassigned rerouted, $skipped completed/archived skipped."

# Log to cortextos event bus
cortextos bus log-event action assignee_reconcile info \
  --meta "{\"reassigned\":$reassigned,\"skipped\":$skipped}" 2>/dev/null || true
