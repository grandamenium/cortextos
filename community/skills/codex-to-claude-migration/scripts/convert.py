#!/usr/bin/env python3
"""
convert.py — CONVERT stage of the Codex->Claude agent migration.

Overlays a codex-app-server agent's customizations onto a claude-code skeleton that
was already laid down by `cortextos add-agent <target> --template agent`. Performs
ONLY the deterministic transforms; flags every judgment step for the human.

NON-DESTRUCTIVE on the source: it reads the source (and ~/.codex/config.toml) and
writes the TARGET only. There is no cutover mode — the source agent is never
modified, disabled or stopped. Dry-run by default; pass --apply to write.

Prereq (caller runs first):
  cortextos add-agent <target> --template agent --org <org>

Usage:
  convert.py --manifest <manifest.json> --src-dir <src> --target-dir <tgt>
             --target-agent <name> --ctx-root <CTX_ROOT> [--apply]
             [--model <claude-id>] [--bot-mode none|new] [--new-bot-token <t>]
             [--boot now|no] [--org <org>] [--instance <id>]
             [--disable-crons] [--include-large]

Secrets contract: no MCP secret value is ever read into output, written to
.mcp.json, or written to any file. MCP env/header/arg values become ${VAR}
references and the report lists which VARs to set in orgs/<org>/secrets.env.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import detect  # noqa: E402  (shared MCP planning + constants)

CODEX_SKILLS_PATH = "plugins/cortextos-agent-skills/skills"
CLAUDE_SKILLS_PATH = ".claude/skills"
# Ordered: the long plugins path first so the bare `.agents/skills` rewrite never
# touches a substring of it.
REF_REWRITES = (
    (CODEX_SKILLS_PATH, CLAUDE_SKILLS_PATH),
    (".agents/skills", CLAUDE_SKILLS_PATH),
)
# Carried history is a record, not instructions: its codex paths are left as written.
HISTORY_DIRS = {"memory", "handoffs", "logs", "tmp", "deliverables", "outputs", "docs",
                "research", "archive", "telegram-images", "experiments", "reports"}
TEXT_EXT = (
    ".md",
    ".sh",
    ".txt",
    ".json",
    ".py",
    ".js",
    ".ts",
    ".yaml",
    ".yml",
    ".toml",
)

# Boot-state continuity carried so the claude agent does NOT cold-onboard. Codex
# session files (codex-app-server-thread.json / -process.json) are deliberately
# absent: they are meaningless to Claude and the target starts a fresh session.
# The copy runs ALONGSIDE the still-live source, so only identity-of-history state is
# carried. Delivery/scheduling state (.telegram-offset, .message-dedup-hashes,
# cron-state.json, pending-reminders.json) stays with the source: carried, it would
# make the copy re-fire the source's reminders or skip messages it never saw.
STATE_CONTINUITY_FILES = (
    ".onboarded",
    ".crash_alert_dedup.json",
    ".ctx-circuit.json",
)
STATE_NOT_CARRIED = ("heartbeat.json", ".telegram-offset", ".message-dedup-hashes", "cron-state.json",
                     "pending-reminders.json")
STATE_CONTINUITY_DIRS = ("handoffs",)

# Source config keys that never carry: identity/runtime fields the migration sets
# itself, crons (migrated separately), and codex-only knobs.
CONFIG_NO_CARRY = {
    "agent_name",
    "runtime",
    "model",
    "enabled",
    "crons",
    "working_directory",
    "codex_context_cap",
    "reasoning_effort",
    "model_reasoning_effort",
}

INSTRUCTION_OVERLAYS = ("AGENTS.md", "IDENTITY.md", "SOUL.md", "GUARDRAILS.md",
                        "HEARTBEAT.md", "USER.md", "SYSTEM.md", "MEMORY.md", "GOALS.md",
                        "goals.json", "TOOLS.md", "ONBOARDING.md")

# config.json cron keys the daemon accepts (CRON_ENTRY_KEY_MAP in
# src/daemon/cron-migration.ts); a disabled cron is `type: "disabled"`.
CRON_CONFIG_KEYS = {"name", "type", "interval", "cron", "fire_at", "prompt"}

LARGE_ITEM_BYTES = 256 * 1024
BINARY_SCRATCH_EXT = (
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".mp4",
    ".mov",
    ".webm",
    ".zip",
    ".tar",
    ".gz",
    ".tgz",
    ".log",
    ".bin",
    ".pdf",
    ".sqlite",
    ".db",
)


def log(actions, msg):
    actions.append(msg)
    print(f"  {msg}", file=sys.stderr)


def _load_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return None


def _write_json(path, data, apply):
    if apply:
        with open(path, "w") as f:
            json.dump(data, f, indent=2)
            f.write("\n")


def copy_tree(src, dst, apply, actions, label):
    if apply:
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if os.path.isdir(src):
            if os.path.exists(dst):
                shutil.rmtree(dst)
            # symlinks=True: keep links as links (a followed link can pull a whole
            # shared tree or a host path into the copy).
            shutil.copytree(src, dst, symlinks=True)
        else:
            shutil.copy2(src, dst)
    log(actions, label)


def surface_large_or_binary(name, src, actions):
    size = detect._tree_size(src)
    ext = os.path.splitext(name)[1].lower()
    is_binary = os.path.isfile(src) and ext in BINARY_SCRATCH_EXT
    if size >= LARGE_ITEM_BYTES or is_binary:
        kind = "binary/scratch" if is_binary else "large"
        log(
            actions,
            f"REPORT: carried {kind} item '{name}' ({size / 1024:.0f} KB) — "
            f"confirm it belongs in the claude agent",
        )


# --------------------------------------------------------------------------- model


def list_claude_models(runner=None):
    """Return ([(tier, id)], error) from `cortextos bus list-models claude-code`.
    Output lines look like `best      claude-opus-5-5`. The model list is host-wide,
    so the call strips per-instance env: under an isolated instance with no daemon
    of its own the command would otherwise fail ("Daemon is not running")."""
    def _default():
        env = {k: v for k, v in os.environ.items()
               if k not in ("CTX_INSTANCE_ID", "CTX_ROOT")}
        return subprocess.run(["cortextos", "bus", "list-models", "claude-code"],
                              capture_output=True, text=True, timeout=60, env=env)
    try:
        r = (runner or _default)()
    except Exception as e:
        return [], str(e)
    if getattr(r, "returncode", 1) != 0:
        return [], ((r.stderr or r.stdout or "").strip().splitlines() or ["exit != 0"])[-1]
    out = []
    for line in (r.stdout or "").splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[0] in ("best", "strong", "fast", "legacy"):
            out.append((parts[0], parts[1]))
    return out, None


def resolve_model(param, models, actions):
    """--model wins (warned if the harness does not list it). Default is Opus (owner
    decision): the first full `claude-opus-*` id list-models reports, best tier
    first. Without one, fall back to the first best-tier `claude-*` id and flag it.
    None => leave unset (harness default)."""
    ids = [m for _, m in models]
    if param:
        if ids and param not in ids:
            log(actions, f"WARNING: --model '{param}' is not in `cortextos bus list-models "
                         f"claude-code` — using it anyway; confirm the id")
        return param
    opus = [m for t, m in models if t == "best" and m.startswith("claude-opus-")] or \
        [m for _, m in models if m.startswith("claude-opus-")]
    if opus:
        log(actions, f"model: resolved '{opus[0]}' (default Opus id from list-models; "
                     f"override with --model)")
        return opus[0]
    for tier, mid in models:
        if tier == "best" and mid.startswith("claude-"):
            log(actions, f"NEEDS-HUMAN: list-models reports no claude-opus-* id — fell back "
                         f"to '{mid}' (first best-tier Claude id); confirm or pass --model")
            return mid
    log(actions, "NEEDS-HUMAN: `cortextos bus list-models claude-code` returned no models — "
                 "model left unset (Claude Code default); pass --model")
    return None


# -------------------------------------------------------------------------- config


def transform_config(
    src_dir, target_dir, target_agent, model, manifest, apply, actions, bus_only=False
):
    src_cfg = _load_json(os.path.join(src_dir, "config.json")) or {}
    tgt_path = os.path.join(target_dir, "config.json")
    tgt_cfg = _load_json(tgt_path) or {}
    carried = []
    for k, v in src_cfg.items():
        if k not in CONFIG_NO_CARRY:
            tgt_cfg[k] = v
            carried.append(k)
    dropped = [
        k
        for k in ("codex_context_cap", "reasoning_effort", "model_reasoning_effort")
        if k in src_cfg
    ]
    src_wd = (src_cfg.get("working_directory") or "").strip()
    src_abs = os.path.abspath(src_dir)
    if src_wd and not (
        os.path.abspath(src_wd) == src_abs
        or os.path.abspath(src_wd).startswith(src_abs + os.sep)
    ):
        tgt_cfg["working_directory"] = src_wd
        log(
            actions,
            f"working_directory='{src_wd}' carried (external). NOTE: Claude keys "
            f"session history by launch path — any other Claude agent launched "
            f"there shares ~/.claude/projects state",
        )
    else:
        tgt_cfg["working_directory"] = ""
    tgt_cfg["agent_name"] = target_agent
    tgt_cfg["runtime"] = "claude-code"
    if model:
        tgt_cfg["model"] = model
    else:
        tgt_cfg.pop("model", None)
    tgt_cfg["enabled"] = False
    if bus_only:
        # No BOT_TOKEN carried: the copy is bus-only. Without this flag the daemon
        # and `cortextos enable` treat the missing token as a misconfiguration.
        tgt_cfg["telegram_polling"] = False
        log(actions, "config.json: telegram_polling=false (bus-only; no BOT_TOKEN carried)")
    _write_json(tgt_path, tgt_cfg, apply)
    log(
        actions,
        f"config.json: runtime codex-app-server -> claude-code, model "
        f"{src_cfg.get('model')!r} -> {model!r}, dropped codex-only {dropped}, "
        f"carried {sorted(carried)}, enabled=false",
    )


def migrate_crons(
    src_dir,
    target_dir,
    source_agent,
    target_agent,
    ctx_root,
    apply,
    actions,
    disable_all=False,
):
    """UNION of source config.json crons[] and the live registry
    ($CTX_ROOT/.cortextOS/state/agents/<src>/crons.json), deduped by name, config
    winning on conflict. Disabled-state survives (disabled in EITHER = type
    "disabled"). Output uses only the daemon's config cron schema.
    Prompts get the skills path and the agents/<source> workspace segment
    translated. --disable-crons carries every recurring cron as type "disabled" (test copies)."""
    src_cfg = _load_json(os.path.join(src_dir, "config.json")) or {}
    config_crons = src_cfg.get("crons") or []
    reg_path = os.path.join(
        ctx_root, ".cortextOS", "state", "agents", source_agent, "crons.json"
    )
    reg = _load_json(reg_path)
    registry_crons = (reg or {}).get("crons") or [] if isinstance(reg, dict) else []
    if reg is None:
        log(
            actions,
            f"note: no live cron registry at {reg_path} — config.json crons only",
        )

    merged, order = {}, []
    disabled_names = set()
    for c in registry_crons:
        nm = c.get("name")
        if not nm:
            continue
        norm = {"name": nm, "type": "recurring", "prompt": c.get("prompt", "")}
        sched = c.get("schedule")
        if isinstance(sched, str) and (" " in sched or "*" in sched):
            norm["cron"] = sched
        elif sched:
            norm["interval"] = sched
        if c.get("enabled") is False:
            disabled_names.add(nm)
        merged[nm] = norm
        order.append(nm)
    for c in config_crons:
        nm = c.get("name")
        if not nm:
            continue
        if nm not in merged:
            order.append(nm)
        if c.get("enabled") is False or c.get("type") == "disabled":
            disabled_names.add(nm)
        merged[nm] = dict(c)

    seg_re = re.compile(r"agents/" + re.escape(source_agent) + r"(?![\w-])")
    out = []
    for nm in order:
        c = dict(merged[nm])
        # the daemon's config cron schema (src/daemon/cron-migration.ts) REFUSES any
        # other key, e.g. `enabled`; a crontab lives in `cron`, never `crontab`.
        if "crontab" in c and "cron" not in c:
            c["cron"] = c.pop("crontab")
        extra = sorted(k for k in c if k not in CRON_CONFIG_KEYS)
        for k in extra:
            c.pop(k)
        if [k for k in extra if k != "enabled"]:
            log(actions, f"cron '{nm}': dropped keys outside the daemon cron schema "
                         f"{[k for k in extra if k != 'enabled']}")
        p = c.get("prompt", "")
        notes = []
        for old, new in REF_REWRITES:
            if old in p:
                notes.append(f"skills path x{p.count(old)}")
                p = p.replace(old, new)
        if seg_re.search(p):
            notes.append(f"agents/{source_agent}->agents/{target_agent}")
            p = seg_re.sub(f"agents/{target_agent}", p)
        if re.search(r"(?<![\w$])\$[a-z][\w-]+", p):
            log(actions, f"NEEDS-HUMAN: cron '{nm}' prompt uses codex `$skill` invocation "
                         f"syntax — Claude invokes skills by name or /skill")
        c["prompt"] = p
        if c.get("type") == "once" or c.get("fire_at"):
            log(actions, f"ONCE-CRON: '{nm}' (fire_at {c.get('fire_at')}) carried as a "
                         f"record; the daemon drops a past fire_at and cannot fire a "
                         f"future one — re-arm it on the target if still wanted")
        elif disable_all or nm in disabled_names:
            c["type"] = "disabled"  # the schema's only way to carry a disabled cron
        out.append(c)
        if notes:
            log(actions, f"cron '{nm}': translated {', '.join(notes)}")
    tgt_path = os.path.join(target_dir, "config.json")
    tcfg = _load_json(tgt_path)
    if isinstance(tcfg, dict):
        tcfg["crons"] = out
        _write_json(tgt_path, tcfg, apply)
    log(
        actions,
        f"crons migrated: {len(out)} (UNION of {len(config_crons)} config + "
        f"{len(registry_crons)} registry)"
        + ("; ALL carried DISABLED (--disable-crons)" if disable_all else ""),
    )
    return out


# ---------------------------------------------------------------- instructions


def write_claude_md(src_dir, target_dir, apply, actions):
    """Shared-instructions pattern: AGENTS.md stays the source; CLAUDE.md is a one-line
    import so both runtimes read the same contract."""
    if apply:
        with open(os.path.join(target_dir, "CLAUDE.md"), "w") as f:
            f.write("@AGENTS.md\n")
    log(
        actions,
        "CLAUDE.md -> one-line '@AGENTS.md' import (AGENTS.md is the shared source)",
    )
    if os.path.isfile(os.path.join(src_dir, "CLAUDE.md")):
        log(
            actions,
            "NEEDS-HUMAN: source has a stale CLAUDE.md (pre-codex residue) — not "
            "carried; fold anything still wanted into AGENTS.md",
        )


def flag_codex_wording(manifest, actions):
    for fn, lines in (
        manifest.get("instructions", {}).get("codex_wording_lines") or {}
    ).items():
        log(
            actions,
            f"NEEDS-HUMAN: {fn} lines {lines} describe the agent as a codex "
            f"agent — edit for Claude (prose is not auto-rewritten)",
        )


def rewrite_refs_in_file(path, apply):
    try:
        if os.path.islink(path) or os.path.getsize(path) > 2 * 1024 * 1024:
            return 0
        with open(path, errors="strict") as f:
            content = f.read()
    except Exception:
        return 0
    n = 0
    new = content
    for old, rep in REF_REWRITES:
        if old in new:
            n += new.count(old)
            new = new.replace(old, rep)
    if n and apply:
        with open(path, "w") as f:
            f.write(new)
    return n


def rewrite_all_refs(roots, apply, actions):
    """Rewrite codex skill-path refs in every text file under roots. On --apply roots
    is the target dir; on a dry-run it is the source paths that WOULD be carried, so
    the reported count is real rather than a scan of a target that does not exist."""
    total, files = 0, 0
    for root in roots:
        if os.path.basename(os.path.normpath(root)) in HISTORY_DIRS:
            continue
        walk = [(os.path.dirname(root), [], [os.path.basename(root)])] \
            if os.path.isfile(root) else os.walk(root)
        for dp, dn, fns in walk:
            dn[:] = [d for d in dn if d not in ("node_modules", ".git")
                     and not detect.VENV_RE.match(d)
                     and not (dp == root and d in HISTORY_DIRS)]
            for fn in fns:
                if fn.endswith(TEXT_EXT):
                    n = rewrite_refs_in_file(os.path.join(dp, fn), apply)
                    if n:
                        total += n
                        files += 1
    log(actions, f"ref-rewrite sweep: {total} codex skill-path ref(s) -> .claude/skills "
                 f"in {files} file(s); history dirs left as written: "
                 f"{sorted(HISTORY_DIRS)}")
    return total


# ---------------------------------------------------------------------- skills


def copy_custom_skills(src_dir, target_dir, manifest, apply, actions):
    tgt_root = os.path.join(target_dir, ".claude", "skills")
    copied = []
    for d in manifest.get("skills", {}).get("data_only", []):
        copy_tree(os.path.join(src_dir, d["path"]), os.path.join(tgt_root, d["name"]),
                  apply, actions, f"skill dir '{d['name']}' (NO SKILL.md — carried as "
                  f"data, not a working skill)")
    for s in manifest.get("skills", {}).get("custom", []):
        name = s["name"]
        if s["disposition"] == "needs_human":
            log(
                actions,
                f"custom skill '{name}' has codex behavioral leakage "
                f"{list(s['leakage_behavioral'])} — NOT copied; rewrite for Claude",
            )
            continue
        dst = os.path.join(tgt_root, name)
        if os.path.isdir(dst) and not os.path.islink(dst):
            log(
                actions,
                f"WARNING: target already has .claude/skills/{name} — overwritten "
                f"by the source's custom copy",
            )
        copy_tree(
            os.path.join(src_dir, s["path"]),
            dst,
            apply,
            actions,
            f"custom skill '{name}'",
        )
        copied.append(name)
    bundled = manifest.get("skills", {}).get("bundled_present", [])
    log(
        actions,
        f"skills: {len(bundled)} bundled come from the claude skeleton; "
        f"{len(copied)} custom copied into .claude/skills: {copied}",
    )
    flag_depth_anchors(tgt_root, copied, actions)
    return copied


def flag_depth_anchors(skills_root, names, actions):
    """Reverse of the codex migration's defect 7: codex skills sit at depth 4
    (plugins/cortextos-agent-skills/skills/<x>); .claude/skills/<x> is depth 3. A
    script that anchors workspace paths via a fixed depth-4 `__file__` hop now lands
    one level ABOVE the agent dir. Surface them; never auto-edit code."""
    anchor = re.compile(r"parents\[4\]|(?:\.\./){4}")
    hits = []
    for name in names:
        root = os.path.join(skills_root, name)
        for dp, dn, fns in os.walk(root):
            dn[:] = [d for d in dn if d not in ("node_modules", ".git")]
            for fn in fns:
                if fn.endswith((".py", ".sh", ".js", ".ts")):
                    fp = os.path.join(dp, fn)
                    try:
                        with open(fp, errors="ignore") as f:
                            txt = f.read()
                    except Exception:
                        continue
                    if anchor.search(txt):
                        hits.append(os.path.relpath(fp, skills_root))
    if hits:
        log(
            actions,
            f"NEEDS-HUMAN: depth-4 path anchors (codex layout) in {hits} resolve "
            f"one level too high under .claude/skills — fix by hand",
        )


# ------------------------------------------------------------------------- MCP


def emit_mcp_json(manifest, target_dir, apply, actions):
    """Write target .mcp.json from the manifest's MCP plans. Plans hold ONLY ${VAR}
    references (detect.plan_mcp_server never copies an inline value). Enables the
    project servers in the target .claude/settings.json so the unattended session
    does not stall on the approval prompt. Returns the env-var list."""
    plans = [
        p
        for p in manifest.get("mcp", {}).get("servers", [])
        if p["action"] == "migrate"
    ]
    for p in manifest.get("mcp", {}).get("servers", []):
        if p["action"] != "migrate":
            log(actions, f"MCP '{p['name']}': {p['action']} ({'; '.join(p['notes'])})")
    if not plans:
        log(actions, "MCP: no host codex servers to migrate")
        return []
    servers = {p["name"]: p["entry"] for p in plans}
    path = os.path.join(target_dir, ".mcp.json")
    existing = _load_json(path) or {}
    merged = dict(existing.get("mcpServers") or {})
    merged.update(servers)
    if apply:
        with open(path, "w") as f:
            json.dump({"mcpServers": merged}, f, indent=2)
            f.write("\n")
    settings_path = os.path.join(target_dir, ".claude", "settings.json")
    settings = _load_json(settings_path)
    if isinstance(settings, dict) and not settings.get("enableAllProjectMcpServers"):
        settings["enableAllProjectMcpServers"] = True
        _write_json(settings_path, settings, apply)
    env_vars = []
    for p in plans:
        for d in p.get("dropped_keys") or []:
            log(
                actions,
                f"MCP '{p['name']}': codex key '{d}' has no .mcp.json equivalent "
                f"(dropped)",
            )
        env_vars.extend(p["env_vars"])
    log(
        actions,
        f"MCP: {'wrote' if apply else 'would write'} {len(servers)} server(s) to .mcp.json with env-var "
        f"references only: {sorted(servers)}; enableAllProjectMcpServers=true",
    )
    for f in manifest.get("mcp", {}).get("inline_secrets", []):
        log(
            actions, f"FINDING: inline secret in codex config at {f} — value NOT copied"
        )
    return env_vars


def env_var_status(env_vars, target_dir):
    """Which referenced vars are already defined (by NAME) in org secrets.env or the
    target .env. Reads key names only."""
    names = set()
    org_secrets = os.path.join(
        os.path.dirname(os.path.dirname(os.path.normpath(target_dir))), "secrets.env"
    )
    for p in (org_secrets, os.path.join(target_dir, ".env")):
        if os.path.isfile(p):
            with open(p, errors="ignore") as f:
                for line in f:
                    t = line.strip()
                    if t and not t.startswith("#") and "=" in t:
                        names.add(t.split("=", 1)[0].strip())
    return [dict(v, defined=v["var"] in names) for v in env_vars]


# ------------------------------------------------------------- env / state / reg


def carry_env(src_dir, target_dir, bot_mode, new_bot_token, apply, actions):
    src = os.path.join(src_dir, ".env")
    if not os.path.isfile(src):
        return
    out = []
    with open(src, errors="ignore") as f:
        for line in f:
            if line.strip().startswith("BOT_TOKEN="):
                continue
            out.append(line.rstrip("\n"))
    if bot_mode == "new":
        out.append("BOT_TOKEN=" + (new_bot_token or "REPLACE_ME_WITH_NEW_BOT_TOKEN"))
    else:
        # Explicitly EMPTY, not absent: the daemon loads orgs/<org>/secrets.env first
        # and the agent .env overrides it, so an absent key would let the copy inherit
        # an org-level BOT_TOKEN and message the principal through the org bot.
        out.append("BOT_TOKEN=")
    dst = os.path.join(target_dir, ".env")
    if apply:
        with open(dst, "w") as f:
            f.write("\n".join(out).rstrip("\n") + "\n")
        os.chmod(dst, 0o600)
    if bot_mode == "new":
        log(
            actions,
            ".env carried (0600) with a NEW BOT_TOKEN"
            + ("" if new_bot_token else " PLACEHOLDER — paste a real token"),
        )
    else:
        log(
            actions,
            ".env carried (0600) WITHOUT BOT_TOKEN — the source still polls that "
            "bot; Telegram allows one poller per bot (--bot-mode new to add one)",
        )


def carry_state(ctx_root, source_agent, target_agent, apply, actions, target_ctx_root=None):
    src_state = os.path.join(ctx_root, "state", source_agent)
    tgt_state = os.path.join(target_ctx_root or ctx_root, "state", target_agent)
    carried = []
    if os.path.isdir(src_state):
        if apply:
            os.makedirs(tgt_state, exist_ok=True)
        for fn in STATE_CONTINUITY_FILES:
            sp = os.path.join(src_state, fn)
            if os.path.isfile(sp):
                if apply:
                    shutil.copy2(sp, os.path.join(tgt_state, fn))
                carried.append(fn)
        for dn in STATE_CONTINUITY_DIRS:
            sp = os.path.join(src_state, dn)
            if os.path.isdir(sp):
                if apply:
                    dp = os.path.join(tgt_state, dn)
                    if os.path.exists(dp):
                        shutil.rmtree(dp)
                    shutil.copytree(sp, dp, symlinks=True)
                carried.append(dn + "/")
    if apply:
        os.makedirs(tgt_state, exist_ok=True)
        open(os.path.join(tgt_state, ".force-fresh"), "w").close()
    log(
        actions,
        f"state carried into state/{target_agent}/: {carried or '(none)'}; "
        f"codex thread/session files excluded; .force-fresh marker written; NOT "
        f"carried (stay with the live source): {list(STATE_NOT_CARRIED)}",
    )


def set_registry_enabled(ctx_root, agent, enabled, apply, actions):
    reg_path = os.path.join(ctx_root, "config", "enabled-agents.json")
    reg = _load_json(reg_path)
    if not isinstance(reg, dict) or reg.get(agent) is None:
        if not apply:
            log(actions, f"registry (dry-run): '{agent}' not registered yet — expected "
                         f"before add-agent; --apply sets it enabled={enabled}")
            return
    if not isinstance(reg, dict):
        log(actions, f"WARNING: {reg_path} missing/unparseable — registry not modified")
        return
    entry = reg.get(agent)
    if entry is None:
        log(
            actions,
            f"WARNING: '{agent}' absent from enabled-agents.json (add-agent not "
            f"run for this instance?)",
        )
        return
    if isinstance(entry, dict):
        entry["enabled"] = enabled
    else:
        reg[agent] = {"enabled": enabled}
    _write_json(reg_path, reg, apply)
    log(
        actions,
        f"registry: enabled-agents.json['{agent}'].enabled -> {enabled} (merge)",
    )


def boot_claude(target_dir, target_agent, ctx_root, org, instance, apply, actions):
    cfg_path = os.path.join(target_dir, "config.json")
    cfg = _load_json(cfg_path) or {}
    cfg["enabled"] = True
    _write_json(cfg_path, cfg, apply)
    set_registry_enabled(ctx_root, target_agent, True, apply, actions)
    cmd = ["cortextos", "enable", target_agent, "--instance", instance]
    if org:
        cmd += ["--org", org]
    if not apply:
        log(actions, f"boot (dry-run): would run `{' '.join(cmd)}`")
        return 0
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except Exception as e:
        log(actions, f"WARNING: `{' '.join(cmd)}` could not run ({e})")
        return None
    log(actions, f"boot: ran `{' '.join(cmd)}` -> exit {r.returncode}")
    return r.returncode


def remove_codex_cruft(target_dir, apply, actions):
    for name in sorted(detect.CODEX_ONLY_ENTRIES):
        p = os.path.join(target_dir, name)
        if os.path.lexists(p):
            if apply:
                shutil.rmtree(p) if os.path.isdir(p) and not os.path.islink(
                    p
                ) else os.remove(p)
            log(actions, f"removed codex-only '{name}' from target")


# ------------------------------------------------------------------------- main


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--src-dir", required=True)
    ap.add_argument("--target-dir", required=True)
    ap.add_argument("--target-agent", required=True)
    ap.add_argument("--ctx-root", required=True, help="source instance CTX_ROOT (read)")
    ap.add_argument("--target-ctx-root", default=None,
                    help="target instance CTX_ROOT (state + registry writes); default --ctx-root")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument(
        "--model",
        default=None,
        help="Claude model id (default: the claude-opus-* id from "
        "`cortextos bus list-models claude-code`)",
    )
    ap.add_argument(
        "--bot-mode",
        choices=["none", "new"],
        default="none",
        help="none (default): BOT_TOKEN not carried; new: write --new-bot-token",
    )
    ap.add_argument("--new-bot-token", default=None)
    ap.add_argument("--boot", choices=["now", "no"], default="no")
    ap.add_argument("--org", default=None)
    ap.add_argument("--instance", default="default")
    ap.add_argument(
        "--disable-crons",
        action="store_true",
        help='carry every recurring cron as type "disabled" (test copies)',
    )
    ap.add_argument(
        "--include-large",
        action="store_true",
        help="also copy items over the 100 MB default limit",
    )
    args = ap.parse_args()

    manifest = _load_json(args.manifest)
    if manifest is None:
        print(f"ERROR: cannot read manifest {args.manifest}", file=sys.stderr)
        sys.exit(1)
    if manifest.get("hard_stops"):
        print("REFUSING: hard stops present:", file=sys.stderr)
        for h in manifest["hard_stops"]:
            print(f"  - {h}", file=sys.stderr)
        sys.exit(2)
    if os.path.abspath(args.target_dir) == os.path.abspath(args.src_dir):
        print(
            "ERROR: target dir == source dir; this skill never converts in place",
            file=sys.stderr,
        )
        sys.exit(2)
    if not os.path.isfile(os.path.join(args.target_dir, ".claude", "settings.json")):
        msg = (f"{args.target_dir} has no .claude/settings.json — lay the claude skeleton "
               f"first: `cortextos add-agent {args.target_agent} --template agent "
               f"--org {args.org or '<org>'} --instance {args.instance}` (for an isolated "
               f"instance also set CTX_FRAMEWORK_ROOT/CTX_INSTANCE_ID; see SKILL.md)")
        if args.apply:
            print(f"ERROR: {msg}", file=sys.stderr)
            sys.exit(1)
        # dry-run plans against the missing skeleton so the full diff can be reviewed
        # before anything (even add-agent) is created.
        print(f"NOTE (dry-run): {msg}", file=sys.stderr)

    mode = "APPLY" if args.apply else "DRY-RUN"
    source_agent = manifest["source_agent"]
    print(
        f"=== convert {source_agent} -> {args.target_agent} [{mode}] ===",
        file=sys.stderr,
    )
    actions = []

    for fn in INSTRUCTION_OVERLAYS:
        src = os.path.join(args.src_dir, fn)
        if os.path.isfile(src):
            copy_tree(
                src,
                os.path.join(args.target_dir, fn),
                args.apply,
                actions,
                f"overlay {fn}",
            )
    for name in manifest["buckets"].get("port_verbatim", []):
        src = os.path.join(args.src_dir, name)
        if os.path.lexists(src):
            copy_tree(
                src,
                os.path.join(args.target_dir, name),
                args.apply,
                actions,
                f"port-verbatim {name}",
            )
            surface_large_or_binary(name, src, actions)
            if name == "auth" or name.endswith("auth"):
                log(
                    actions,
                    f"REPORT: '{name}/' carried — credential-bearing; review "
                    f"before enable",
                )
    for nc in manifest["buckets"].get("not_carried", []):
        if args.include_large and "bytes" in nc:
            copy_tree(
                os.path.join(args.src_dir, nc["name"]),
                os.path.join(args.target_dir, nc["name"]),
                args.apply,
                actions,
                f"port-verbatim (--include-large) {nc['name']}",
            )
        else:
            log(actions, f"NOT CARRIED: {nc['name']} — {nc['reason']}")

    for rel, n in sorted((manifest.get("carried_token_shapes") or {}).items()):
        log(actions, f"WARNING: carried file '{rel}' holds {n} credential-shaped "
                     f"string(s) — copied verbatim; redact in source and target (value not shown)")
    carry_env(
        args.src_dir,
        args.target_dir,
        args.bot_mode,
        args.new_bot_token,
        args.apply,
        actions,
    )
    models, models_err = list_claude_models()
    if models_err:
        log(actions, f"WARNING: `cortextos bus list-models claude-code` failed: {models_err}")
    model = resolve_model(args.model, models, actions)
    transform_config(
        args.src_dir,
        args.target_dir,
        args.target_agent,
        model,
        manifest,
        args.apply,
        actions,
        bus_only=args.bot_mode == "none",
    )
    migrate_crons(
        args.src_dir,
        args.target_dir,
        source_agent,
        args.target_agent,
        args.ctx_root,
        args.apply,
        actions,
        disable_all=args.disable_crons,
    )
    write_claude_md(args.src_dir, args.target_dir, args.apply, actions)
    flag_codex_wording(manifest, actions)
    copy_custom_skills(args.src_dir, args.target_dir, manifest, args.apply, actions)
    for name in manifest.get("skills", {}).get("bundled_customized", []):
        log(
            actions,
            f"NEEDS-HUMAN: bundled skill '{name}' differs from the codex template "
            f"in the source — the claude skeleton's stock copy is used",
        )
    remove_codex_cruft(args.target_dir, args.apply, actions)
    if args.apply:
        ref_roots = [args.target_dir]
    else:
        carried = list(INSTRUCTION_OVERLAYS) + manifest["buckets"].get("port_verbatim", [])
        carried += [s["path"] for s in manifest.get("skills", {}).get("custom", [])
                    if s["disposition"] != "needs_human"]
        ref_roots = [os.path.join(args.src_dir, c) for c in carried
                     if os.path.exists(os.path.join(args.src_dir, c))]
    rewrite_all_refs(ref_roots, args.apply, actions)
    env_vars = env_var_status(
        emit_mcp_json(manifest, args.target_dir, args.apply, actions), args.target_dir
    )
    for v in env_vars:
        log(
            actions,
            f"ENV VAR NEEDED: {v['var']} ({'secret' if v['secret'] else 'config'}; "
            f"from {v['source']}) — "
            f"{'already defined' if v['defined'] else 'NOT SET: add to orgs/<org>/secrets.env'}",
        )
    tgt_ctx = args.target_ctx_root or args.ctx_root
    carry_state(args.ctx_root, source_agent, args.target_agent, args.apply, actions,
                target_ctx_root=tgt_ctx)
    set_registry_enabled(tgt_ctx, args.target_agent, False, args.apply, actions)

    end_state = "disabled"
    if args.boot == "now":
        rc = boot_claude(
            args.target_dir,
            args.target_agent,
            tgt_ctx,
            args.org,
            args.instance,
            args.apply,
            actions,
        )
        end_state = "live" if rc == 0 else "boot-failed"

    print(
        f"\n=== {len(actions)} actions ({mode}); end_state={end_state} ===",
        file=sys.stderr,
    )
    json.dump(
        {
            "mode": mode,
            "end_state": end_state,
            "model": model,
            "env_vars": env_vars,
            "actions": actions,
        },
        sys.stdout,
        indent=2,
    )
    sys.stdout.write("\n")
    sys.exit(0 if end_state != "boot-failed" else 1)


if __name__ == "__main__":
    main()
