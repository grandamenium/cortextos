#!/usr/bin/env bash
# MEMORY-04: Update working-context.md with current bus task state.
# Called by: vault-working-context cron (every 30min)
# Derives active projects from in-progress tasks and updates topic sections.

set -euo pipefail

VAULT="${CTX_FRAMEWORK_ROOT:-/Users/arndt/cortextos}/obsidian-vault"
AGENT="${CTX_AGENT_NAME:-cortextos-improver}"
WC_FILE="$VAULT/$AGENT/working-context.md"
TODAY=$(date -u +%Y-%m-%d)
NOW=$(date -u +%H:%M)

# Get in-progress tasks for this agent from bus
IN_PROGRESS=$(cortextos bus list-tasks --format json 2>/dev/null | \
  python3 -c "
import sys, json
tasks = json.load(sys.stdin)
agent = '${AGENT}'
active = [t for t in tasks if t.get('status') == 'in_progress' and t.get('assigned_to') == agent]
for t in active[:5]:
    print(t['id'] + '|' + (t.get('title') or '')[:60])
" 2>/dev/null || echo "")

# Build active projects section
PROJECTS_SECTION="## Active Projects (auto-updated by MEMORY-04 cron)
"
if [ -z "$IN_PROGRESS" ]; then
  PROJECTS_SECTION+="*No in-progress tasks for $AGENT*
"
else
  while IFS='|' read -r tid title; do
    [ -z "$tid" ] && continue
    PROJECTS_SECTION+="- **$tid**: $title
"
  done <<< "$IN_PROGRESS"
fi

# If working-context.md doesn't exist, create it
if [ ! -f "$WC_FILE" ]; then
  cat > "$WC_FILE" << TEMPLATE
---
type: working-context
agent: $AGENT
tags: [$AGENT, working-context, state, quality, guardrails, patterns]
created: $TODAY
modified: $TODAY
---

# $AGENT — Working Context
**Current task:** (idle)
**Last checkpoint:** $NOW UTC
**Next action:** Check inbox + run crons
TEMPLATE
fi

# Update modified date in frontmatter
python3 << PYEOF
from pathlib import Path
import re

wc = Path("$WC_FILE")
content = wc.read_text()

# Update modified date
content = re.sub(r'^modified:.*$', f'modified: $TODAY', content, flags=re.M)

# Remove stale "Active Projects" section if exists, re-add it
content = re.sub(r'\n## Active Projects.*?(?=\n## |\Z)', '', content, flags=re.DOTALL)

# Append updated section
if not content.endswith('\n'):
    content += '\n'
content += '''\n${PROJECTS_SECTION}'''

wc.write_text(content)
print("working-context.md updated")
PYEOF
