#!/usr/bin/env bash
# project-state-writer.sh — refreshes a MANAGED auto-block inside
# obsidian-vault/agent-shared/project-state.md from the live task store, on a 6h
# launchd schedule. Self-healing for the VaultLivenessWatchdog (alerts when this
# file's mtime is >24h old). Preserves all human-authored content outside the block.
set -uo pipefail

CTX_ROOT="${CTX_ROOT:-$HOME/.cortextos/default}"
CTX_ORG="${CTX_ORG:-phytomedic}"
export TASK_DIR="$CTX_ROOT/orgs/$CTX_ORG/tasks"
export OUT="${CTX_PROJECT_STATE_PATH:-$HOME/cortextos/obsidian-vault/agent-shared/project-state.md}"
export NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

[ -d "$TASK_DIR" ] || { echo "[project-state-writer] TASK_DIR missing: $TASK_DIR" >&2; exit 1; }

python3 - <<'PY'
import json, os, glob, re, time
from datetime import datetime
TASK_DIR=os.environ['TASK_DIR']; OUT=os.environ['OUT']; NOW=os.environ['NOW']
START="<!-- PSW:AUTO START — managed by project-state-writer.sh, do not edit inside -->"
END="<!-- PSW:AUTO END -->"
now=time.time()
tasks=[]
for p in glob.glob(os.path.join(TASK_DIR,'task_*.json')):
    try:
        d=json.load(open(p))
        if not d.get('archived'): tasks.append(d)
    except Exception: pass
def st(s): return [t for t in tasks if t.get('status')==s]
pend,inprog,blocked=st('pending'),st('in_progress'),st('blocked')
comp24=[]
for t in tasks:
    c=t.get('completed_at')
    if t.get('status')=='completed' and c:
        try:
            if now-datetime.fromisoformat(c.replace('Z','+00:00')).timestamp()<=86400: comp24.append(t)
        except Exception: pass
byrole={}
for t in inprog: byrole.setdefault(t.get('assigned_to','?'),[]).append(t)
bund={}
for t in tasks:
    b=t.get('bundle_id')
    if b: bund.setdefault(b,[]).append(t)
L=[START]
L.append(f"_Heartbeat: auto-generated {NOW} by project-state-writer (every 6h from the live task store)._")
L.append("")
L.append(f"**Fleet snapshot — {NOW}**")
L.append(f"- Open: {len(pend)+len(inprog)+len(blocked)} (pending {len(pend)}, in_progress {len(inprog)}, blocked {len(blocked)}) · Completed last 24h: {len(comp24)}")
L.append("")
L.append("**In progress (who is on what):**")
if byrole:
    for role in sorted(byrole):
        for t in byrole[role][:4]: L.append(f"- `{role}` — {t.get('title','')[:70]}")
else: L.append("- (none in progress)")
if bund:
    L.append("")
    L.append("**Active bundles (coordinated work):**")
    for b in sorted(bund):
        ts=bund[b]; done=len([x for x in ts if x.get('status')=='completed'])
        L.append(f"- {b} — {done}/{len(ts)} done")
if comp24:
    L.append("")
    L.append("**Recently completed (24h):**")
    for t in comp24[:8]: L.append(f"- {t.get('title','')[:75]}")
L.append(END)
block="\n".join(L)

existing=""
if os.path.exists(OUT):
    existing=open(OUT).read()
if START in existing and END in existing:
    new=re.sub(re.escape(START)+r".*?"+re.escape(END), lambda m: block, existing, count=1, flags=re.DOTALL)
elif existing.strip():
    # insert the block right after the first "# Project State" heading, else prepend
    m=re.search(r"^#\s+Project State.*$", existing, flags=re.MULTILINE)
    if m: new=existing[:m.end()]+"\n\n"+block+"\n"+existing[m.end():]
    else: new=block+"\n\n"+existing
else:
    new=("---\ntype: shared\nagent: agent-shared\ntags: [agent-shared, shared, fleet-wide]\n---\n\n# Project State\n\n"+block+"\n")
tmp=OUT+".tmp"
os.makedirs(os.path.dirname(OUT), exist_ok=True)
open(tmp,"w").write(new); os.replace(tmp,OUT)
print(f"[project-state-writer {NOW}] refreshed managed block in {OUT}")
PY
