#!/usr/bin/env bash
# 2026-05 cost & context optimization — fleet activation.
#
# Idempotently flips every existing orgs/<org>/agents/<agent>/.env and
# config.json under the framework root to the post-optimization defaults
# from docs_sb/issues/ok-so-we-want-snazzy-garden.md PR-A.
#
# Safe to run repeatedly. Re-applies missing keys; does not overwrite values
# the operator has intentionally set higher (e.g. ctx_handoff_threshold > 80
# stays put; opus model on engineer stays put). Removes thresholds < 70/80
# only when they match the legacy 42/50 1M-tier defaults.
#
# Usage:
#   bash scripts/migrations/2026-05-cost-context-optimization.sh         # dry-run
#   bash scripts/migrations/2026-05-cost-context-optimization.sh --apply # write changes
#   bash scripts/migrations/2026-05-cost-context-optimization.sh --apply --role engineer  # single role
#
# After --apply, restart the daemon (pm2 restart cortextos) — daemon-side
# fields (max_session_seconds, model) require daemon restart, not just
# per-agent restart. See .claude/rules/code-quality/daemon-side-config-requires-daemon-restart.md.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MODE="dry-run"
ROLE_FILTER=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) MODE="apply"; shift;;
    --role)  ROLE_FILTER="$2"; shift 2;;
    -h|--help)
      sed -n '2,20p' "$0"; exit 0;;
    *) echo "unknown arg: $1" >&2; exit 1;;
  esac
done

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

# ---- map role -> model (engineer is sole Opus) -------------------------
# Assumption: agent role is inferred from the directory name under
# orgs/<org>/agents/. Orgs that use non-canonical names (e.g. "code-bot"
# instead of "engineer") silently default to sonnet — adjust per-agent
# config.json post-migration if those agents need the Opus override.
model_for_role() {
  case "$1" in
    engineer) echo "opus";;
    *)        echo "sonnet";;
  esac
}

# ---- patch a single config.json ---------------------------------------
patch_config() {
  local cfg="$1" role="$2"
  [[ -f "$cfg" ]] || return 0
  local desired_model
  desired_model="$(model_for_role "$role")"

  python3 - "$cfg" "$desired_model" "$MODE" <<'PY'
import json, sys, os
cfg_path, desired_model, mode = sys.argv[1], sys.argv[2], sys.argv[3]
with open(cfg_path) as f:
    cfg = json.load(f)
changes = []

# model — set if missing or legacy 1M variant; never downgrade explicit opus on engineer
current_model = cfg.get("model")
if current_model is None or current_model.endswith("[1m]"):
    if current_model != desired_model:
        changes.append(("model", current_model, desired_model))
        cfg["model"] = desired_model

# max_session_seconds — 28800 unless operator already set a tighter value
target = 28800
if cfg.get("max_session_seconds", 0) > target:
    changes.append(("max_session_seconds", cfg.get("max_session_seconds"), target))
    cfg["max_session_seconds"] = target
elif "max_session_seconds" not in cfg:
    changes.append(("max_session_seconds", None, target))
    cfg["max_session_seconds"] = target

# thresholds — bump 1M-tier defaults to 200K-tier; add if missing.
# Per-key legacy-set so operators who intentionally cross-set (e.g.
# ctx_warning=50 as a tighter custom value) aren't silently bumped.
# Legacy 1M-opus defaults were warning=42, handoff=50 — strict, per-key.
for key, want, legacy in (
    ("ctx_warning_threshold", 70, {42}),
    ("ctx_handoff_threshold", 80, {50}),
):
    cur = cfg.get(key)
    if cur is None or cur in legacy:
        if cur != want:
            changes.append((key, cur, want))
            cfg[key] = want

if not changes:
    print(f"  [skip] {cfg_path} — already at target")
    sys.exit(0)

for k, old, new in changes:
    print(f"  [{mode}] {cfg_path} :: {k}: {old} -> {new}")

if mode == "apply":
    with open(cfg_path, "w") as f:
        json.dump(cfg, f, indent=2)
        f.write("\n")
PY
}

# ---- patch a single .env -----------------------------------------------
# Ensure CLAUDE_CODE_DISABLE_1M_CONTEXT=true is present and uncommented.
patch_env() {
  local env_file="$1"
  [[ -f "$env_file" ]] || return 0
  if grep -qE '^CLAUDE_CODE_DISABLE_1M_CONTEXT=true' "$env_file"; then
    log "  [skip] $env_file — already disabled"
    return 0
  fi
  log "  [$MODE] $env_file :: enable CLAUDE_CODE_DISABLE_1M_CONTEXT=true"
  [[ "$MODE" == "apply" ]] || return 0

  if grep -qE '^# *CLAUDE_CODE_DISABLE_1M_CONTEXT=true' "$env_file"; then
    # uncomment in-place
    sed -i.bak -E 's|^# *(CLAUDE_CODE_DISABLE_1M_CONTEXT=true)|\1|' "$env_file"
    rm -f "${env_file}.bak"
  elif grep -qE '^CLAUDE_CODE_DISABLE_1M_CONTEXT=' "$env_file"; then
    # overwrite existing different value
    sed -i.bak -E 's|^CLAUDE_CODE_DISABLE_1M_CONTEXT=.*|CLAUDE_CODE_DISABLE_1M_CONTEXT=true|' "$env_file"
    rm -f "${env_file}.bak"
  else
    printf '\nCLAUDE_CODE_DISABLE_1M_CONTEXT=true\n' >> "$env_file"
  fi
}

# ---- walk orgs/*/agents/* ----------------------------------------------
log "mode=$MODE  filter=${ROLE_FILTER:-<all>}  root=$REPO_ROOT"
shopt -s nullglob
found=0
for agent_dir in "$REPO_ROOT"/orgs/*/agents/*/; do
  agent_name="$(basename "$agent_dir")"
  if [[ -n "$ROLE_FILTER" && "$agent_name" != "$ROLE_FILTER" ]]; then continue; fi
  found=$((found+1))
  log "agent: $agent_name  ($agent_dir)"
  patch_config "$agent_dir/config.json" "$agent_name"
  patch_env    "$agent_dir/.env"
done

if [[ $found -eq 0 ]]; then
  log "no agents matched (filter=${ROLE_FILTER:-<all>}). Nothing to do."
fi

log "done. mode=$MODE"
if [[ "$MODE" != "apply" ]]; then
  log "Re-run with --apply to write changes."
else
  log "Restart daemon to activate daemon-side fields:  pm2 restart cortextos"
fi
