#!/usr/bin/env bash
# cron-durability-lint.sh — re-clone-durability backstop for agent crons.
#
# Flags any cron whose helper script violates the durable-cron convention, so the
# one-time durability cleanup (PRs #87 devops-monitor / #90 systems-analyst) can't
# silently re-rot as agents add new crons over time.
#
# A cron is re-clone/re-provision-survivable only if ALL hold:
#   1. PATH    — script referenced as "$CTX_FRAMEWORK_ROOT/<rel>", not a worktree-absolute /Users/... path
#   2. TRACKED — the script is git-tracked in origin/main (git cat-file -e passes)
#   3. UNIGNORED — the script is not under a gitignored path (.gitignore 'orgs/*/agents/*' agent-dir zone)
#   4. IN-CONFIG — the cron def lives in config.json, not only in the live crons.json registry
#
# Classifications per cron:
#   PASS          — all checks clean
#   FAIL          — a re-clone would break this cron (abs path / untracked / ignored / config-orphan)
#   PENDING-SYNC  — source (config.json) is durable+portable, but the LIVE crons.json copy still
#                   carries an abs path (expected transient while the framework-root worktree
#                   hasn't yet merged the relocate PR — NOT a durability break)
#
# Exit: 0 if no FAIL, 1 if any FAIL. PENDING-SYNC does not fail the lint.
#
# Run:  bash "$CTX_FRAMEWORK_ROOT/scripts/self-healing/cron-durability-lint.sh"
set -euo pipefail

FWROOT="${CTX_FRAMEWORK_ROOT:?CTX_FRAMEWORK_ROOT not set}"
CTXROOT="${CTX_ROOT:-$HOME/.cortextos/default}"

FWROOT="$FWROOT" CTXROOT="$CTXROOT" python3 - "$@" <<'PYEOF'
import json, os, re, subprocess, sys, glob

FWROOT = os.environ["FWROOT"]
CTXROOT = os.environ["CTXROOT"]
STATE = os.path.join(CTXROOT, ".cortextOS", "state", "agents")

def git(*a):
    return subprocess.run(["git", "-C", FWROOT, *a], capture_output=True, text=True)

def tracked_main(rel):
    return git("cat-file", "-e", f"origin/main:{rel}").returncode == 0

def ignored(rel):
    return git("check-ignore", rel).returncode == 0

# Only EXECUTED scripts are in scope: a path is durability-relevant only if it is
# actually run (bash/sh/source/. /python3/node). Paths merely read with a graceful
# fallback (e.g. `cat .../state.json 2>/dev/null`) are per-machine runtime STATE,
# legitimately gitignored, and must NOT be flagged (false-positive guard — confirmed
# benign for improver/upstream-watch's upstream-notified.js dedup ledger).
EXEC = r'(?:bash|sh|source|\.|python3|node)\s+["\']?'
ABS_RE  = re.compile(EXEC + r'(/Users/[^\s"\']*?\.(?:sh|js|py))')
PORT_RE = re.compile(EXEC + r'\$(?:CTX_FRAMEWORK_ROOT|\{CTX_FRAMEWORK_ROOT\})/([^\s"\']*?\.(?:sh|js|py))')

def rel_of_abs(p):
    # worktree-absolute -> repo-relative (best effort)
    for marker in ("objective-mclaren/", "/cortextos/"):
        if marker in p:
            return p.split(marker)[-1]
    return p

def config_crons(agent):
    for cf in glob.glob(os.path.join(FWROOT, "orgs", "*", "agents", agent, "config.json")):
        try:
            return {c["name"]: c for c in json.load(open(cf)).get("crons", [])}
        except Exception:
            return {}
    return {}

def registered_crons(agent):
    cj = os.path.join(STATE, agent, "crons.json")
    if not os.path.exists(cj):
        return {}
    try:
        d = json.load(open(cj))
        crons = d if isinstance(d, list) else d.get("crons", [])
        return {c["name"]: c for c in crons if "name" in c}
    except Exception:
        return {}

agents = sorted(os.listdir(STATE)) if os.path.isdir(STATE) else []
results = []  # (agent, cron, status, detail)

for agent in agents:
    cfg = config_crons(agent)
    reg = registered_crons(agent)
    for name in sorted(set(cfg) | set(reg)):
        cfg_c, reg_c = cfg.get(name), reg.get(name)

        # config-orphan: live but absent from source config
        if reg_c and not cfg_c:
            results.append((agent, name, "FAIL", "config-orphan: in crons.json but not config.json (dropped by re-clone / migrate --force)"))
            continue

        cfg_prompt = (cfg_c or {}).get("prompt", "")
        reg_prompt = (reg_c or {}).get("prompt", "")

        # collect script refs from the config (source-of-truth) prompt
        cfg_abs  = set(ABS_RE.findall(cfg_prompt))
        cfg_port = set(PORT_RE.findall(cfg_prompt))

        fail = []
        # source abs-path antipattern
        for p in cfg_abs:
            rel = rel_of_abs(p)
            fail.append(f"config uses worktree-abs path ({rel}) instead of $CTX_FRAMEWORK_ROOT-relative")
        # portable refs must be tracked + unignored
        for rel in cfg_port:
            if not tracked_main(rel):
                fail.append(f"script not tracked in origin/main: {rel}")
            elif ignored(rel):
                fail.append(f"script under gitignored path: {rel}")

        if fail:
            results.append((agent, name, "FAIL", "; ".join(fail)))
            continue

        # source clean — is the LIVE copy lagging (abs path still present)?
        if cfg_port and ABS_RE.search(reg_prompt):
            results.append((agent, name, "PENDING-SYNC", "config portable+tracked; live crons.json still abs (awaiting worktree main-sync, no live gap)"))
        else:
            results.append((agent, name, "PASS", ""))

fails   = [r for r in results if r[2] == "FAIL"]
pending = [r for r in results if r[2] == "PENDING-SYNC"]

print("=== cron-durability-lint ===")
for a, c, s, d in results:
    if s == "PASS":
        continue
    print(f"  [{s}] {a}/{c}: {d}")
total = len(results)
print(f"\n{total} crons scanned | {total - len(fails) - len(pending)} PASS | {len(pending)} PENDING-SYNC | {len(fails)} FAIL")
if fails:
    print("DURABILITY FAIL — these crons would break on re-clone/re-provision.")
    sys.exit(1)
print("OK — no re-clone-durability failures.")
PYEOF
PYEOF_OUTER_GUARD=true
