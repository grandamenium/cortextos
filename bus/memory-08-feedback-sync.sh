#!/usr/bin/env bash
# MEMORY-08 Phase 1: Sync GitHub CI + Greptile reviews to Obsidian vault feedback/.
# Runs every 15 minutes. Only processes new PRs since last-mined-pr.

set -euo pipefail

VAULT="/Users/arndt/cortextos/obsidian-vault/cortextos-improver"
REPO="syntasticstudios/phytomedic-saas"
LAST_MINED_FILE="/Users/arndt/phytomedic-saas/tests/quality/.last-mined-pr"
TODAY=$(date -u +%Y-%m-%d)

LAST=$(cat "$LAST_MINED_FILE" 2>/dev/null || echo 0)
LATEST=$(gh pr list --repo "$REPO" --state all --limit 1 --json number --jq '.[0].number' 2>/dev/null || echo "$LAST")

if [ "$LATEST" -le "$LAST" ]; then
  echo "memory-08-feedback-sync: no new PRs (last=$LAST)"
  exit 0
fi

mkdir -p "$VAULT/feedback/greptile" "$VAULT/feedback/ci"

for pr in $(seq $((LAST+1)) $LATEST); do
  PR_DATA=$(gh pr view "$pr" --repo "$REPO" \
    --json number,title,mergedAt,statusCheckRollup,comments \
    2>/dev/null) || continue

  python3 - <<PYEOF
import json, re
from pathlib import Path
from datetime import datetime, timezone

pr_data = json.loads('''$PR_DATA'''.replace("'", "'\\''"))
pr_num = pr_data.get('number', 0)
today = '$TODAY'
vault = Path('$VAULT')

# Greptile sync
reviews = [c for c in pr_data.get('comments', [])
           if c.get('author', {}).get('login', '').startswith('greptile')]
body = reviews[-1].get('body', '') if reviews else ''
m = re.search(r'(\d)/5', body)
score = int(m.group(1)) if m else None
findings = list(set(re.findall(r'\b(?:P0|P1|P2)-\d+\b', body)))
gate = 'ready' if score and score >= 4 else ('blocked' if score else 'unknown')

greptile_md = f"""---
type: feedback
agent: cortextos-improver
tags: [cortextos-improver, feedback, greptile]
pr_number: {pr_num}
greptile_score: {score if score is not None else 'null'}
gate_status: {gate}
state: {('merged' if pr_data.get('mergedAt') else 'open')}
created: {today}
modified: {today}
---

# Greptile — PR #{pr_num}

**Score:** {f'{score}/5' if score else 'pending'}  
**Gate:** {gate}  
**Findings:** {', '.join(findings) if findings else 'none'}  

## Review (excerpt)

{body[:1500]}
"""
(vault / f'feedback/greptile/pr-{pr_num}.md').write_text(greptile_md)

# CI sync
checks = pr_data.get('statusCheckRollup') or []
failed = sum(1 for c in checks if c.get('conclusion') in ('FAILURE', 'ERROR', 'TIMED_OUT'))
ci_status = 'green' if checks and failed == 0 else ('red' if failed > 0 else 'unknown')

ci_md = f"""---
type: feedback
agent: cortextos-improver
tags: [cortextos-improver, feedback, ci]
pr_number: {pr_num}
ci_status: {ci_status}
checks_total: {len(checks)}
checks_failed: {failed}
state: {('merged' if pr_data.get('mergedAt') else 'open')}
merged_at: {(pr_data.get('mergedAt') or '')[:10]}
created: {today}
modified: {today}
---

# CI — PR #{pr_num}

**Status:** {ci_status} {'✅' if ci_status == 'green' else '🔴' if ci_status == 'red' else '⏳'}  
**Checks:** {len(checks) - failed}/{len(checks)} passed  

## Checks

{''.join(f"- **{c.get('name','?')}**: {c.get('conclusion') or c.get('status','?')}  \\n" for c in checks[:20])}
"""
(vault / f'feedback/ci/pr-{pr_num}.md').write_text(ci_md)
print(f'synced PR {pr_num}: greptile={score}/5 ci={ci_status}')
PYEOF

done

echo "memory-08-feedback-sync: synced PRs $((LAST+1))..$LATEST"
