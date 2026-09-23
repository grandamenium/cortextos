#!/usr/bin/env python3
"""
convert.py — CONVERT stage of the Claude->Codex agent migration.

Overlays the source agent's customizations onto a codex skeleton that was already
laid down by `cortextos add-agent --template agent-codex`. Performs ONLY the
deterministic transforms; flags every judgment step for the human (fold review,
leakage adjudication, MCP merge, secrets).

NON-DESTRUCTIVE on the source: it reads the source and writes the TARGET only.
Dry-run by default; pass --apply to write.

Prereq (caller runs first):
  cortextos add-agent <target> --template agent-codex --runtime codex-app-server --org <org>

Usage:
  convert.py --manifest <manifest.json> --src-dir <src> --target-dir <tgt>
             --target-agent <name> --ctx-root <CTX_ROOT> [--apply]
             [--bot-mode reuse|new|none] [--new-bot-token <token>]
             [--boot now|no] [--source-agent <name>] [--org <org>]

Interactive-flow flags (the implementing agent sets these from the user's
answers to Step 2 of SKILL.md). ALL default to the SAFE, non-destructive path:
  --bot-mode  reuse : CUTOVER. Disable the source (config.json + registry),
                      copy the source BOT_TOKEN into the codex .env, imply boot.
              new   : write --new-bot-token into the codex .env (both can run).
              none  : (DEFAULT) no token change, source untouched, codex disabled.
  --boot      now   : enable the codex agent (config.json + registry) and start it
                      via `cortextos enable`.
              no    : (DEFAULT) leave the codex agent disabled.
With NO flags this script behaves EXACTLY as before: source untouched, codex
disabled, no boot. The destructive cutover/boot ONLY happen on explicit flags.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time

REWRITE = (".claude/skills", "plugins/cortextos-agent-skills/skills")
CLAUDE_AUTH_ENV = ("ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN")

# Codex skills live under a different host path than claude's `.claude/skills`.
# A cron prompt that `cd`s into the source workspace and invokes a skill must have
# BOTH legs translated together or the command resolves a non-existent path:
#   - `.claude/skills/<x>` -> `plugins/cortextos-agent-skills/skills/<x>` (skills leg)
#   - `cd .../agents/<source>` -> `cd .../agents/<target>` (workspace leg)
# Translating only one (the prod defect) leaves `cd agents/<source>` referencing a
# plugins/ path that only resolves under agents/<target>.
CRON_SKILLS_REWRITE = REWRITE  # same skills-path rewrite the rest of the tree uses

# INSTANCE-DISCOVERY (public skill: no principal/orchestrator identity is baked in).
# The routing guardrail — "principal-facing sends route THROUGH the orchestrator" —
# is a real cortextOS pattern, but WHO the principal and orchestrator are is
# instance-specific and must be DISCOVERED from the target deployment or passed
# explicitly. When a value is unknown the feature SAFE-DEGRADES (no reroute, flag
# for human) rather than inventing one — a hardcoded chat id / orchestrator name is
# both a leak AND a functional bug for any other user (it would hunt a foreign id
# and rewrite crons to an agent they do not have).


def _looks_numeric_id(v):
    return bool(v) and str(v).strip().isdigit()


def _read_env_value(env_path, *keys):
    """First present non-empty value among keys in an .env file, else None."""
    if not os.path.isfile(env_path):
        return None
    pairs, _ = _read_env(env_path)
    lut = {k: v for k, v in pairs}
    for k in keys:
        if lut.get(k):
            return lut[k].strip()
    return None


def resolve_principal_chat_id(src_dir, param=None):
    """The principal's Telegram chat id, for the literal-reroute leg. Precedence:
    explicit param -> source .env CHAT_ID -> source .env ALLOWED_USER (if numeric)
    -> None. None disables the literal leg (nothing to match — no hunting a foreign
    id). No hardcoded literal anywhere."""
    if param:
        return str(param).strip()
    env = os.path.join(src_dir, ".env")
    v = _read_env_value(env, "CHAT_ID")
    if v:
        return v
    au = _read_env_value(env, "ALLOWED_USER")
    return au if _looks_numeric_id(au) else None


def resolve_principal_name(src_dir, param=None):
    """The principal's NAME, for prose-intent detection/guard text. Precedence:
    explicit param -> source .env ALLOWED_USER (only if NON-numeric, i.e. a name)
    -> None. None disables the prose leg (no name to match — avoids false hits)."""
    if param:
        return str(param).strip()
    au = _read_env_value(os.path.join(src_dir, ".env"), "ALLOWED_USER")
    return au if (au and not _looks_numeric_id(au)) else None


# A migrated cron whose prompt directs a send at the principal in prose (no literal
# chat id) slips the token rewrite; detect it so a routing guard can be injected.
# Built PER-INSTANCE from the discovered principal name (never a baked-in name).
def principal_prose_send_res(principal_name):
    """Two compiled regexes catching '<verb> ... <principal>' and the reversed
    '<principal> ... a reminder/directly/...' phrasings. Returns [] when the
    principal name is unknown (prose leg disabled)."""
    if not principal_name:
        return []
    p = re.escape(principal_name)
    return [
        re.compile(
            r"\b(send|sends|sending|tell|telling|notify|notifying|message|messaging|"
            r"ping|pinging|remind|reminding|reminder\s+to|alert|alerting|dm|email|"
            r"emailing|text|texting)\b[^.\n]{0,40}\b" + p + r"\b", re.IGNORECASE),
        re.compile(
            r"\b" + p + r"\b[^.\n]{0,30}\b(a\s+reminder|directly|right away|immediately|"
            r"a\s+summary|a\s+message|a\s+ping|a\s+heads.?up)\b", re.IGNORECASE),
    ]


def orchestrator_route_re(orchestrator):
    """Recognize a prompt that ALREADY routes through the orchestrator (do not
    double-route). Built per-instance from the discovered orchestrator name."""
    if not orchestrator:
        return None
    o = re.escape(orchestrator)
    return re.compile(
        r"(send-message\s+" + o + r"|through\s+" + o + r"|via\s+" + o +
        r"|route\s+(it\s+)?through\s+" + o + r"|to\s+" + o + r"\b|" + o +
        r"\s+\(route|MIGRATION ROUTING GUARD)", re.IGNORECASE)


# Positive orchestrator signal for auto-discovery (GAP D): a sibling agent must
# ACTIVELY declare the orchestrator role — mere existence (e.g. the lone sibling in
# a 2-agent instance) is NOT enough. config.json persists no role today, so the
# signal is a role/template field IF present OR an explicit self-declaration in the
# agent's identity files. Absent/ambiguous => param-only safe-degrade.
_ORCH_IDENTITY_RE = re.compile(
    r"(?im)^\s*(?:#+\s*)?role\s*[:=]\s*orchestrator\b"
    r"|\b(?:you are|i am)\s+(?:the\s+|an\s+)?orchestrator\b"
    r"|\borchestrator\s+(?:agent|role)\s+for\s+(?:the\s+)?(?:org|fleet)\b")


def _agent_declares_orchestrator(agent_dir):
    cfgp = os.path.join(agent_dir, "config.json")
    if os.path.isfile(cfgp):
        try:
            with open(cfgp) as f:
                cfg = json.load(f)
            for field in ("role", "template", "agentType", "agent_type"):
                if str(cfg.get(field, "")).strip().lower() == "orchestrator":
                    return True
        except Exception:
            pass
    for fn in ("IDENTITY.md", "SOUL.md"):
        fp = os.path.join(agent_dir, fn)
        if os.path.isfile(fp):
            try:
                with open(fp, errors="ignore") as f:
                    if _ORCH_IDENTITY_RE.search(f.read()):
                        return True
            except Exception:
                pass
    return False


def discover_orchestrator(src_dir, source_agent, target_agent, param, actions):
    """Resolve the orchestrator (reroute target). Precedence: explicit --orchestrator
    param -> best-effort auto-scan of sibling agents for a POSITIVE role signal
    (exactly one candidate) -> None (safe-degrade). Returns (name_or_None, source_str).
    NEVER picks a sibling on existence alone; a single auto-scan hit is SURFACED for
    operator confirmation, not trusted silently."""
    if param:
        return str(param).strip(), "param"
    agents_root = os.path.dirname(os.path.normpath(src_dir))
    if not os.path.isdir(agents_root):
        return None, "no-agents-root"
    candidates = []
    for name in sorted(os.listdir(agents_root)):
        if name in (source_agent, target_agent):
            continue
        d = os.path.join(agents_root, name)
        if os.path.isdir(d) and _agent_declares_orchestrator(d):
            candidates.append(name)
    if len(candidates) == 1:
        log(actions, f"★ ORCHESTRATOR AUTO-DISCOVERED: '{candidates[0]}' (positive role "
                     f"signal in its config/identity). CONFIRM this is your orchestrator "
                     f"before trusting the cron reroute; pass --orchestrator to override.")
        return candidates[0], "auto-scan"
    if len(candidates) > 1:
        log(actions, f"orchestrator auto-scan AMBIGUOUS ({candidates}) — pass "
                     f"--orchestrator <name> to disambiguate; reroute SAFE-DEGRADED.")
    return None, ("ambiguous" if candidates else "no-signal")

# Boot-state continuity markers carried source->target so the migrated agent does
# NOT cold-onboard (the daemon onboarding gate, agent-process.ts ~699-713, runs
# ONBOARDING.md when state/<name>/.onboarded is absent). The stale session
# transcripts are EXCLUDED narrowly (the legitimate reason force_fresh existed):
# a stale codex thread file makes codex attempt a thread/resume that crash-loops.
STATE_CONTINUITY_FILES = (
    ".onboarded", "heartbeat.json", ".telegram-offset", "cron-state.json",
    ".message-dedup-hashes", ".crash_alert_dedup.json", ".ctx-circuit.json",
    "pending-reminders.json",
)
STATE_CONTINUITY_DIRS = ("handoffs",)
# Never carry these from the source state dir: stale session transcripts that
# would cause a stale-session resume crash on the target's first boot.
STATE_EXCLUDE_SUFFIXES = ("thread.json",)  # codex-app-server-thread.json, *thread.json
STATE_EXCLUDE_EXACT = ("codex-app-server-thread.json",)

# Carried items above this size (or with a binary/scratch extension) are surfaced
# in the report rather than silently bulk-copied.
LARGE_ITEM_BYTES = 256 * 1024  # 256 KB
BINARY_SCRATCH_EXT = (
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".mp4", ".mov", ".webm",
    ".zip", ".tar", ".gz", ".tgz", ".log", ".bin", ".pdf", ".sqlite", ".db",
)


def _tree_size(path):
    if os.path.isfile(path):
        try:
            return os.path.getsize(path)
        except OSError:
            return 0
    total = 0
    for dp, dn, fns in os.walk(path):
        dn[:] = [d for d in dn if d not in ("node_modules", ".git")]
        for fn in fns:
            try:
                total += os.path.getsize(os.path.join(dp, fn))
            except OSError:
                pass
    return total


def surface_large_or_binary(name, src, actions):
    """Emit a REPORT line for a carried item that is large or binary/scratch, so
    big PNGs/logs/zips never slip through in a silent bulk copy."""
    size = _tree_size(src)
    ext = os.path.splitext(name)[1].lower()
    is_binary = os.path.isfile(src) and ext in BINARY_SCRATCH_EXT
    if size >= LARGE_ITEM_BYTES or is_binary:
        kb = size / 1024.0
        kind = "binary/scratch" if is_binary else "large"
        log(actions, f"REPORT: carried {kind} item '{name}' ({kb:.0f} KB) — "
                     f"confirm it belongs in the codex agent (not stale scratch)")


def log(actions, msg):
    actions.append(msg)
    print(f"  {msg}", file=sys.stderr)


def rewrite_refs_in_file(path, apply, actions):
    """Rewrite .claude/skills -> plugins path in a single file. Returns hit count."""
    try:
        with open(path, errors="ignore") as f:
            content = f.read()
    except Exception:
        return 0
    if REWRITE[0] not in content:
        return 0
    n = content.count(REWRITE[0])
    if apply:
        with open(path, "w") as f:
            f.write(content.replace(REWRITE[0], REWRITE[1]))
    log(actions, f"rewrote {n} '.claude/skills' ref(s) in {os.path.basename(path)}")
    return n


def copy_tree(src, dst, apply, actions, label):
    if apply:
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if os.path.isdir(src):
            if os.path.exists(dst):
                shutil.rmtree(dst)
            shutil.copytree(src, dst, symlinks=False)
        else:
            shutil.copy2(src, dst)
    log(actions, f"{label}: {os.path.relpath(src)} -> {os.path.relpath(dst)}")


def transform_config(src_dir, target_dir, target_agent, manifest, apply, actions):
    src_cfg_path = os.path.join(src_dir, "config.json")
    tgt_cfg_path = os.path.join(target_dir, "config.json")
    with open(src_cfg_path) as f:
        src_cfg = json.load(f)
    # base on the codex skeleton's config if it exists (keeps codex defaults)
    tgt_cfg = {}
    if os.path.isfile(tgt_cfg_path):
        with open(tgt_cfg_path) as f:
            tgt_cfg = json.load(f)
    # carry runtime-agnostic knobs from source (working_directory handled below)
    # NOTE: `enabled` is deliberately NOT carried here — the source's value is
    # irrelevant; the target is forced enabled=false below (config.json) and in
    # the registry (disable_in_registry). Carrying it would be dead code.
    # NOTE: `crons` is deliberately NOT carried here. The source config.json crons[]
    # can DIVERGE from the live registry (crons.json) — the prod migration dropped
    # 7 of 11 by reading only one source. migrate_crons() (called after this) takes
    # the UNION of config.json + the live registry, translates paths, and re-routes
    # direct-to-principal sends, then writes the result into tgt_cfg["crons"].
    for k in ("timezone", "day_mode_start", "day_mode_end", "communication_style",
              "approval_rules", "startup_delay", "max_session_seconds",
              "max_crashes_per_day", "crash_window",
              "telegram_polling"):
        if k in src_cfg:
            tgt_cfg[k] = src_cfg[k]
    # working_directory: do NOT carry verbatim. If the source pins a launch path,
    # the target inherits it AND the source's ~/.claude/projects/<dashed>/ JSONL
    # key — sharing stale session state and defeating the .force-fresh guard. Only
    # carry it if it points OUTSIDE the source agent dir (a genuine external repo).
    # Default the target to its own dir (empty string => daemon uses the agent dir).
    src_wd = (src_cfg.get("working_directory") or "").strip()
    src_abs = os.path.abspath(src_dir)
    if not src_wd:
        tgt_cfg["working_directory"] = ""
        log(actions, "working_directory: source unset -> target defaults to its own dir")
    else:
        wd_abs = os.path.abspath(src_wd)
        inside_src = wd_abs == src_abs or wd_abs.startswith(src_abs + os.sep)
        if inside_src:
            # collides with the source's JSONL key — refuse to carry it.
            manifest.setdefault("hard_stops", []).append(
                f"source pins working_directory='{src_wd}' inside its own agent dir "
                f"-> would share the source's JSONL session key. Resolve manually "
                f"(repoint to an external path or clear it) before enabling.")
            tgt_cfg["working_directory"] = ""
            log(actions, f"HARD-STOP: source working_directory='{src_wd}' is INSIDE "
                         f"the source agent dir (JSONL-key collision) — NOT carried, "
                         f"target left empty, flagged for human")
        else:
            tgt_cfg["working_directory"] = src_wd
            log(actions, f"working_directory='{src_wd}' carried (external to source dir)")
    # codex-mandatory edits
    tgt_cfg["agent_name"] = target_agent
    tgt_cfg["runtime"] = "codex-app-server"
    tgt_cfg["model"] = tgt_cfg.get("model") or "gpt-5-codex"
    tgt_cfg.pop("dangerously_skip_permissions", None)
    tgt_cfg.pop("ecosystem", None)
    tgt_cfg.setdefault("codex_context_cap", 256000)
    # safety: target starts disabled regardless of source
    tgt_cfg["enabled"] = False
    if apply:
        with open(tgt_cfg_path, "w") as f:
            json.dump(tgt_cfg, f, indent=2)
            f.write("\n")
    log(actions, "config.json: runtime->codex-app-server, model set, "
                 "dangerously_skip_permissions+ecosystem dropped, codex_context_cap added, "
                 "knobs carried, enabled=false")


def _translate_cron_prompt(prompt, source_agent, target_agent, actions, cron_name):
    """Translate a cron prompt so it resolves in the TARGET workspace. Three legs,
    applied together (the prod defect translated only the skills leg, leaving a
    `cd agents/<source>` that referenced a plugins/ path only resolving under
    <target>):
      1. skills path: `.claude/skills/<x>` -> `plugins/cortextos-agent-skills/skills/<x>`
      2. workspace cd: `orgs/<org>/agents/<source>` -> `.../agents/<target>`
      3. hardcoded absolute source-workspace paths (e.g. /…/agents/<source>/…).
    Returns (new_prompt, list_of_change_notes)."""
    notes = []
    new = prompt
    # 1. skills leg
    if CRON_SKILLS_REWRITE[0] in new:
        n = new.count(CRON_SKILLS_REWRITE[0])
        new = new.replace(CRON_SKILLS_REWRITE[0], CRON_SKILLS_REWRITE[1])
        notes.append(f"skills path x{n}")
    # 2 + 3. any `agents/<source>` PATH SEGMENT (covers both the relative `cd
    # orgs/.../agents/<source>` and any hardcoded absolute path ending in
    # /agents/<source>). Bounded to a complete segment via a negative-lookahead on
    # the next name char so `agents/data` does NOT match `agents/database` and a
    # second pass does NOT re-translate the already-rewritten `agents/<src>-codex`.
    seg_re = re.compile(r"agents/" + re.escape(source_agent) + r"(?![\w-])")
    matches = seg_re.findall(new)
    if matches:
        new = seg_re.sub(f"agents/{target_agent}", new)
        notes.append(f"workspace path agents/{source_agent}->agents/{target_agent} x{len(matches)}")
    return new, notes


def _reroute_principal_sends(prompt, cron_name, actions, principal_chat_id,
                             orchestrator, principal_name):
    """Guardrail (defect 6c + 14): a migrated cron that sends DIRECT to the principal
    violates the routing rule (principal-facing sends route THROUGH the orchestrator).

    GATED (GAP C): the ENTIRE reroute is skipped unless an orchestrator is known —
    there is nothing safe to rewrite TO otherwise (a known chat id with an unknown
    orchestrator must NOT be rewritten into a send-into-the-void). WHO the principal
    and orchestrator are is discovered per-instance; nothing is baked in.

    Two detection layers (each additionally gated on its own instance value):
      (a) LITERAL (6c): `send-telegram <principal_chat_id>` / bare id -> rewritten to
          `send-message <orchestrator> normal`. Requires principal_chat_id known.
      (b) PROSE (14): a principal-directed send verb in prose (keyed on the discovered
          principal NAME) with no literal id -> NON-DESTRUCTIVELY append a routing
          guard. Requires principal_name known.
    Returns (new_prompt, rerouted_bool)."""
    new = prompt
    rerouted = False
    if not orchestrator:
        # SAFE-DEGRADE: no orchestrator -> no reroute (never invent one). The caller
        # surfaces principal-facing crons as needs-human instead.
        return new, False
    # (a) LITERAL chat-id rewrite (deterministic, safe) — only if we know the id.
    if principal_chat_id and principal_chat_id in new:
        new = re.sub(
            r"cortextos bus send-telegram\s+" + re.escape(principal_chat_id),
            f"cortextos bus send-message {orchestrator} normal",
            new,
        )
        if principal_chat_id in new:
            new = new.replace(
                principal_chat_id,
                f"{orchestrator} (route through {orchestrator}, do NOT send direct to the principal)")
        log(actions, f"GUARDRAIL: cron '{cron_name}' sent DIRECT to the principal "
                     f"(send-telegram <principal-chat-id>) -> re-routed through "
                     f"'{orchestrator}' per the routing rule")
        rerouted = True
    # (b) PROSE intent (only if not already routing through the orchestrator).
    prose_res = principal_prose_send_res(principal_name)
    route_re = orchestrator_route_re(orchestrator)
    has_prose = any(rx.search(new) for rx in prose_res)
    if has_prose and not (route_re and route_re.search(new)):
        guard = (f"\n\n[MIGRATION ROUTING GUARD]: This cron is principal-facing. Per the "
                 f"routing rule, route every principal-facing send THROUGH the "
                 f"orchestrator '{orchestrator}' "
                 f"(`cortextos bus send-message {orchestrator} normal '<msg>'`) — do NOT "
                 f"send direct to the principal. The orchestrator owns the principal's "
                 f"surface and delivers.")
        new = new + guard
        log(actions, f"GUARDRAIL (defect 14 prose): cron '{cron_name}' has prose "
                     f"direct-to-principal send intent with no orchestrator routing -> "
                     f"appended a routing-guard directive (non-destructive); verify.py "
                     f"asserts the outcome")
        rerouted = True
    return new, rerouted


def _load_registry_crons(ctx_root, source_agent, actions):
    """Read the source's LIVE cron registry. cortextos stores it at
    $CTX_ROOT/.cortextOS/state/agents/<agent>/crons.json (the daemon-loaded
    registry) — the file the daemon actually fires from. Returns a list of cron
    dicts (possibly empty)."""
    reg_path = os.path.join(ctx_root, ".cortextOS", "state", "agents",
                            source_agent, "crons.json")
    if not os.path.isfile(reg_path):
        log(actions, f"note: no live cron registry at {reg_path} — "
                     f"using config.json crons only")
        return []
    try:
        with open(reg_path) as f:
            data = json.load(f)
    except Exception as e:
        log(actions, f"WARNING: could not parse live cron registry {reg_path} ({e}) — "
                     f"using config.json crons only")
        return []
    return data.get("crons", []) or []


def migrate_crons(src_dir, target_dir, source_agent, target_agent, ctx_root,
                  apply, actions, principal_chat_id=None, orchestrator=None,
                  principal_name=None):
    """Migrate ALL crons (defect 5): the UNION of the source config.json crons[]
    AND the source live registry crons.json, deduped by name. Crons present in
    config.json but absent from the live registry (and vice versa) are BOTH kept —
    the prod migration dropped 7 of 11 by reading only the registry. For each cron:
    translate cd/skills/absolute paths to the target workspace (defect 4), and
    re-route any direct-to-principal send through the orchestrator (defect 6c). Writes the union into
    the target config.json crons[]."""
    src_cfg_path = os.path.join(src_dir, "config.json")
    with open(src_cfg_path) as f:
        src_cfg = json.load(f)
    config_crons = src_cfg.get("crons", []) or []
    registry_crons = _load_registry_crons(ctx_root, source_agent, actions)

    # enabled-state must SURVIVE the union. The daemon fires from the registry, so a
    # cron disabled in the LIVE registry (or in config) must NOT come back enabled at
    # the target. The old union dropped `enabled` in registry normalization and let
    # config win, silently re-enabling a live-disabled recurring cron. Capture both
    # sides; the effective enabled is computed per cron in the emit loop below.
    reg_enabled = {c.get("name"): c.get("enabled") for c in registry_crons if c.get("name")}
    cfg_enabled = {c.get("name"): c.get("enabled") for c in config_crons if c.get("name")}

    # defect 11b: one-shot crons. The source stores a once-cron in TWO shapes:
    # config.json carries {type:"once", fire_at:<ISO>} which the daemon SKIPS (no
    # native once/fire_at support => silent drop), while the LIVE registry carries
    # the SAME cron as a dated crontab (e.g. '0 13 16 6 *') which the daemon LOADS
    # and fires (TZ-correct in the agent's tz). So for a once-cron we must PREFER
    # the registry crontab form over the config once-form, else the cron silently
    # vanishes at the target. Identify once-crons from config up front.
    once_names = set()
    for c in config_crons:
        nm = c.get("name")
        if nm and (c.get("type") == "once" or c.get("fire_at") or c.get("fireAt")):
            once_names.add(nm)

    # UNION deduped by name; config.json is the canonical shape (type/interval/
    # crontab), but a registry-only cron is still carried (normalized to a config
    # cron). config.json wins on conflict (it carries the schedule TYPE) — EXCEPT
    # for once-crons that have a daemon-loadable registry form (defect 11b).
    merged = {}
    order = []
    registry_form = {}
    for c in registry_crons:
        nm = c.get("name")
        if not nm:
            continue
        # normalize registry shape (schedule) to config shape; carry `enabled` through
        # so a registry-only cron keeps its live enabled-state (was dropped here).
        norm = {"name": nm, "prompt": c.get("prompt", "")}
        if c.get("enabled") is not None:
            norm["enabled"] = c.get("enabled")
        sched = c.get("schedule")
        if isinstance(sched, str) and (" " in sched or "*" in sched):
            norm["type"] = "crontab"
            norm["crontab"] = sched
        elif sched:
            norm["type"] = "recurring"
            norm["interval"] = sched
        merged[nm] = norm
        order.append(nm)
        registry_form[nm] = norm
    for c in config_crons:
        nm = c.get("name")
        if not nm:
            continue
        if nm not in merged:
            order.append(nm)
            merged[nm] = dict(c)
        elif nm in once_names and registry_form.get(nm, {}).get("type") in ("crontab", "recurring"):
            # defect 11b: KEEP the registry's daemon-loadable form for this
            # once-cron — do NOT let the config once-form override and get dropped.
            merged[nm] = dict(registry_form[nm])
        else:
            merged[nm] = dict(c)  # config.json wins (carries the canonical schedule type)

    out = []
    rerouted = 0
    once_flags = []  # (name, schedule_or_fire_at, kind)
    for nm in order:
        c = dict(merged[nm])
        # defect 11b: a once-cron must end up daemon-loadable, never silently
        # dropped. If it still carries the once-form (no registry crontab existed),
        # it CANNOT be auto-converted safely (deriving a crontab from fire_at would
        # guess the timezone and could fire at the wrong time) — keep it as a record
        # and emit a HARD re-arm flag for the operator instead.
        if nm in once_names:
            if c.get("type") == "once" or c.get("fire_at") or c.get("fireAt"):
                once_flags.append((nm, c.get("fire_at") or c.get("fireAt"), "needs-rearm"))
            else:
                once_flags.append((nm, c.get("crontab") or c.get("interval"), "registry-crontab"))
        prompt = c.get("prompt", "")
        prompt, notes = _translate_cron_prompt(prompt, source_agent, target_agent,
                                               actions, nm)
        prompt, was_rerouted = _reroute_principal_sends(
            prompt, nm, actions, principal_chat_id, orchestrator, principal_name)
        if was_rerouted:
            rerouted += 1
        c["prompt"] = prompt
        # effective enabled: DISABLED if disabled in EITHER source (registry or config),
        # else enabled. Never silently resurrect a live-disabled cron via config-wins.
        eff_enabled = not (reg_enabled.get(nm) is False or cfg_enabled.get(nm) is False)
        c["enabled"] = eff_enabled
        if not eff_enabled:
            log(actions, f"cron '{nm}': carried DISABLED (live-disabled in source; "
                         f"not resurrected at target)")
        out.append(c)
        if notes:
            log(actions, f"cron '{nm}': translated {', '.join(notes)}")

    # defect 11b: flag every once-cron LOUDLY — converted ones carry a re-fire
    # caveat, unconvertible ones get an explicit re-arm instruction. NEVER silent.
    for (nm, sched, kind) in once_flags:
        if kind == "registry-crontab":
            log(actions, f"ONCE-CRON FLAG (defect 11b): '{nm}' was a one-shot; carried "
                         f"as the registry's dated crontab '{sched}' so the daemon "
                         f"LOADS+FIRES it (daemon has no native once/fire_at). CAVEAT: a "
                         f"dated crontab RE-FIRES on the same date each year — confirm the "
                         f"prompt self-destructs after firing, or remove it post-fire. "
                         f"Verify with `cortextos bus list-crons {target_agent}`.")
        else:
            log(actions, f"ONCE-CRON FLAG (defect 11b) NEEDS-REARM: '{nm}' is a one-shot "
                         f"(fire_at '{sched}') with NO daemon-loadable registry form — the "
                         f"daemon will SKIP it (silent drop). It is carried in target "
                         f"config.json as a record only. RE-ARM manually on the target "
                         f"after boot: have '{target_agent}' create a one-shot reminder for "
                         f"'{nm}' at {sched} (orchestrator-routed if principal-facing).")

    # write into the target config.json crons[]
    tgt_cfg_path = os.path.join(target_dir, "config.json")
    if os.path.isfile(tgt_cfg_path):
        with open(tgt_cfg_path) as f:
            tcfg = json.load(f)
        tcfg["crons"] = out
        if apply:
            with open(tgt_cfg_path, "w") as f:
                json.dump(tcfg, f, indent=2)
                f.write("\n")
    log(actions, f"crons migrated: {len(out)} (UNION of {len(config_crons)} config "
                 f"+ {len(registry_crons)} registry, deduped); {rerouted} direct-to-principal "
                 f"send(s) re-routed through the orchestrator; cd/skills paths translated to target")
    return out


def carry_state_continuity(src_dir, ctx_root, source_agent, target_agent, apply, actions):
    """Boot-state continuity (defect 1). The daemon cold-onboards an agent whose
    state/<name>/.onboarded marker is absent. The old force_fresh dropped a marker
    but never carried .onboarded, so a migrated agent re-ran ONBOARDING.md. CARRY
    the boot-state continuity markers source->target (.onboarded, heartbeat.json,
    .telegram-offset, cron-state.json, dedup/circuit files, pending-reminders.json,
    handoffs/). EXCLUDE ONLY the stale session transcript(s) (codex thread file) —
    the narrow, legitimate reason force_fresh existed. NEVER wipe the whole state
    dir."""
    src_state = os.path.join(ctx_root, "state", source_agent)
    tgt_state = os.path.join(ctx_root, "state", target_agent)
    if not os.path.isdir(src_state):
        log(actions, f"note: source state dir {src_state} absent — nothing to carry "
                     f"(target will cold-onboard unless .onboarded is created)")
        return
    if apply:
        os.makedirs(tgt_state, exist_ok=True)
    carried = []
    for fn in STATE_CONTINUITY_FILES:
        sp = os.path.join(src_state, fn)
        if os.path.isfile(sp):
            if apply:
                shutil.copy2(sp, os.path.join(tgt_state, fn))
            carried.append(fn)
    for dn in STATE_CONTINUITY_DIRS:
        sp = os.path.join(src_state, dn)
        if os.path.isdir(sp):
            dp = os.path.join(tgt_state, dn)
            if apply:
                if os.path.exists(dp):
                    shutil.rmtree(dp)
                shutil.copytree(sp, dp, symlinks=False)
            carried.append(dn + "/")
    log(actions, f"state continuity carried into state/{target_agent}/: "
                 f"{', '.join(carried) if carried else '(none present)'} — "
                 f".onboarded carried so the daemon does NOT cold-onboard the target")


def carry_handoff_and_boot_directive(src_dir, target_dir, ctx_root, source_agent,
                                     target_agent, migration_start_ts, apply, actions):
    """Read-side handoff enforcement (defect 3) + DETERMINISTIC carry. The FRESH
    source-generated handoff (produced AFTER migration start by the source's normal
    handoff:create — gated by await_fresh_handoff) is carried into a DETERMINISTIC
    location in the new agent's dir so it is ALWAYS reliably read on boot, not a
    'newest file' guess. 8i FIX: the source handoff is read from the source WORKSPACE
    memory/handoffs/ (not state/<source>/handoffs/). It is then carried into BOTH
    boot-read locations: (1) the daemon boot-state dir state/<target>/handoffs/ and
    (2) the new agent's WORKSPACE memory/handoffs/ (its native handoff:resume dir) —
    so whichever path boot uses, the doc is there. A deterministic boot directive
    (.handoff-doc-path) points the daemon at the exact carried file; the daemon
    (agent-process.ts consumeHandoffBlock) reads it and injects 'read the handoff at
    <path>' as the agent's first action. Returns the carried boot-state path (or None)."""
    src_handoffs = os.path.join(src_dir, "memory", "handoffs")
    fresh = _find_fresh_handoff(src_handoffs, migration_start_ts)
    if not fresh:
        log(actions, "WARNING: no fresh source handoff found in source memory/handoffs/ "
                     "to carry — the read-side boot directive was NOT written "
                     "(await_fresh_handoff should have blocked the cutover before this)")
        return None
    base = os.path.basename(fresh)
    tgt_state = os.path.join(ctx_root, "state", target_agent)
    tgt_state_handoffs = os.path.join(tgt_state, "handoffs")
    tgt_ws_handoffs = os.path.join(target_dir, "memory", "handoffs")
    state_dst = os.path.join(tgt_state_handoffs, base)
    ws_dst = os.path.join(tgt_ws_handoffs, base)
    if apply:
        now = time.time()
        # DETERMINISTIC dual-location carry: land it in BOTH boot-read dirs as NEWEST
        # (copy2 preserves source mtime, which may predate carried older handoffs —
        # bump to now so it sorts newest in each dir; verify.py asserts newest).
        for dst_dir, dst in ((tgt_state_handoffs, state_dst), (tgt_ws_handoffs, ws_dst)):
            os.makedirs(dst_dir, exist_ok=True)
            shutil.copy2(fresh, dst)
            os.utime(dst, (now, now))
        # deterministic boot directive: the daemon reads this marker and injects CONTEXT HANDOFF.
        marker = os.path.join(tgt_state, ".handoff-doc-path")
        with open(marker, "w") as f:
            f.write(os.path.abspath(state_dst) + "\n")
    log(actions, f"read-side: carried fresh handoff '{base}' (from source memory/handoffs/) "
                 f"into BOTH state/{target_agent}/handoffs/ AND target memory/handoffs/ as "
                 f"NEWEST; wrote deterministic .handoff-doc-path boot directive -> daemon "
                 f"injects 'read this handoff first' on the target's first boot")
    return state_dst


def ensure_guardrails(target_dir, apply, actions, orchestrator=None,
                      principal_name=None):
    """Guardrail-into-template (defect 6a/6b), SPLIT into two independent rows:

      - APPROVAL row ('no external action without an explicit per-item go') is
        instance-GENERAL cortextOS safety and is ALWAYS injected.
      - ROUTING row ('principal-facing sends route THROUGH the orchestrator') is
        injected whenever the ORCHESTRATOR is known (F1). The orchestrator is the
        thing the rule routes TO, so it is the only value the row structurally needs.
        The principal NAME is optional decoration: when known the row names the
        principal, when unknown it uses a generic "the principal" — either way the
        rule (route through the orchestrator) is well-defined and safe. This matters
        because the COMMON live case has a numeric ALLOWED_USER, so principal_name is
        None for most instances; gating the whole routing row on the name would drop
        the guardrail for nearly everyone, and verify.py (orchestrator-gated, name-
        independent) would then hard-fail. The reroute's PROSE leg stays name-gated
        (principal_prose_send_res returns [] without a name — no false hits).
        The routing row is omitted ONLY when no orchestrator is known (safe-degrade).

    Idempotent: appends the block only if the marker is absent. Also ensures
    config.json approval_rules gates external-comms (always — general)."""
    ROUTE_MARKER = "MIGRATION GUARDRAILS (inherited via migration)"
    inject_routing = bool(orchestrator)
    principal_ref = (f"the principal ('{principal_name}')" if principal_name
                     else "the principal")
    rows = ""
    if inject_routing:
        rows += (
            f"| Any principal-facing send | \"I'll just message the principal "
            f"directly\" | Route every principal-facing send THROUGH the orchestrator "
            f"'{orchestrator}'. Never send direct to {principal_ref}; send to "
            f"'{orchestrator}' for delivery. |\n")
    rows += (
        "| About to take any external action | \"I have standing authorization\" | "
        "NO external action (post, send, deploy, publish, purchase, delete) without "
        "an EXPLICIT per-item go + approval. No inferred/standing authorization. |\n")
    block = (
        f"\n## MIGRATION GUARDRAILS (inherited via migration)\n\n"
        "| Trigger | Red Flag Thought | Required Action |\n"
        "|---------|-----------------|-----------------|\n"
        + rows
    )
    gp = os.path.join(target_dir, "GUARDRAILS.md")
    present = False
    if os.path.isfile(gp):
        with open(gp, errors="ignore") as f:
            content = f.read()
        present = ROUTE_MARKER in content
        if not present and apply:
            with open(gp, "a") as f:
                f.write(block)
    else:
        content = "# Guardrails\n"
        if apply:
            with open(gp, "w") as f:
                f.write(content + block)
    if present:
        log(actions, "guardrails: migration guardrails already present in target "
                     "GUARDRAILS.md (idempotent no-op)")
    else:
        routing_note = (f"ROUTING (principal-facing sends via '{orchestrator}') + "
                        if inject_routing else
                        "ROUTING row OMITTED (no orchestrator known — "
                        "safe-degrade) + ")
        log(actions, f"guardrails: appended {routing_note}APPROVAL (no external action "
                     f"without explicit per-item go) to target GUARDRAILS.md")
    # config approval_rules: ensure external-comms is gated (always_ask).
    cfg_path = os.path.join(target_dir, "config.json")
    if os.path.isfile(cfg_path):
        with open(cfg_path) as f:
            cfg = json.load(f)
        rules = cfg.setdefault("approval_rules", {})
        always = rules.setdefault("always_ask", [])
        changed = False
        for need in ("external-comms",):
            if need not in always:
                always.append(need)
                changed = True
        if changed and apply:
            with open(cfg_path, "w") as f:
                json.dump(cfg, f, indent=2)
                f.write("\n")
        log(actions, f"guardrails: config approval_rules.always_ask ensures external-comms "
                     f"gated ({'added' if changed else 'already present'})")


def fold_claude_md(src_dir, target_dir, manifest, apply, actions):
    cm = manifest.get("claude_md", {})
    if not cm.get("present"):
        log(actions, "no CLAUDE.md in source")
        return
    src_cm = os.path.join(src_dir, "CLAUDE.md")
    with open(src_cm, errors="ignore") as f:
        body = f.read()
    if cm.get("thin_wrapper"):
        log(actions, "CLAUDE.md is a thin @AGENTS.md wrapper — dropped, no fold needed")
        return
    body = body.replace(REWRITE[0], REWRITE[1])
    tgt_agents = os.path.join(target_dir, "AGENTS.md")
    section = (
        "\n\n<!-- ============================================================ -->\n"
        "<!-- FOLDED FROM SOURCE CLAUDE.md — REVIEW FOR DUPLICATION/CONFLICT -->\n"
        "<!-- ============================================================ -->\n"
        "## Folded from CLAUDE.md (review and de-duplicate)\n\n"
        + body + "\n"
    )
    if apply and os.path.isfile(tgt_agents):
        with open(tgt_agents, "a") as f:
            f.write(section)
    log(actions, "CLAUDE.md content appended to target AGENTS.md under a labeled "
                 "section — HUMAN REVIEW REQUIRED for de-duplication")


def strip_tools_auth(target_dir, apply, actions):
    tp = os.path.join(target_dir, "TOOLS.md")
    if not os.path.isfile(tp):
        return
    with open(tp, errors="ignore") as f:
        content = f.read()
    hit = any(e in content for e in CLAUDE_AUTH_ENV)
    if hit:
        log(actions, "NEEDS-HUMAN: TOOLS.md references Claude auth env (ANTHROPIC_API_KEY/"
                     "CLAUDE_CODE_OAUTH_TOKEN) — codex model auth is host ~/.codex/auth.json; "
                     "FLAGGED for human review/strip (prose not auto-edited)")


def copy_custom_skills(src_dir, target_dir, target_agent, manifest, apply, actions):
    skills = manifest.get("skills", {}).get("custom", [])
    tgt_skills_root = os.path.join(target_dir, "plugins", "cortextos-agent-skills", "skills")
    for s in skills:
        name = s["name"]
        src = os.path.join(src_dir, ".claude", "skills", name)
        dst = os.path.join(tgt_skills_root, name)
        if s["disposition"] == "needs_human":
            log(actions, f"custom skill '{name}' has behavioral leakage "
                         f"{list(s['leakage_behavioral'].keys())} — NOT auto-copied; "
                         f"hand to skill-creator")
            continue
        copy_tree(src, dst, apply, actions, f"custom skill '{name}'")
        # rewrite mechanical refs inside the copied skill
        if apply and os.path.isdir(dst):
            for dp, dn, fns in os.walk(dst):
                dn[:] = [d for d in dn if d != "node_modules"]
                for fn in fns:
                    rewrite_refs_in_file(os.path.join(dp, fn), apply, actions)
    # Symlinks for ALL skills (bundled + custom) are installed by
    # install_all_symlinks(), called separately after this — verify.py asserts a
    # symlink for EVERY skill dir, not just the customs copied here.


def install_all_symlinks(target_dir, target_agent, apply, actions):
    """Replicate add-agent's installCodexSkillSymlinks over EVERY skill dir in
    plugins/cortextos-agent-skills/skills/* (bundled + custom). Idempotent:
    replaces an existing symlink, leaves a real file/dir in place. This guarantees
    the scripted path produces exactly what verify.py checks (which asserts a
    ~/.codex/skills/<agent>__<skill> link for every skill dir, including the 23
    bundled ones whose symlinks would otherwise be an implicit add-agent
    prerequisite that silently no-ops if a non-symlink pre-exists)."""
    skills_root = os.path.join(target_dir, "plugins", "cortextos-agent-skills", "skills")
    codex_skills_dir = os.path.join(os.path.expanduser("~"), ".codex", "skills")
    if not os.path.isdir(skills_root):
        log(actions, "no plugins/.../skills dir in target — no symlinks to install")
        return
    linked = 0
    for name in sorted(os.listdir(skills_root)):
        sp = os.path.join(skills_root, name)
        if not os.path.isdir(sp):
            continue
        link = os.path.join(codex_skills_dir, f"{target_agent}__{name}")
        if apply:
            os.makedirs(codex_skills_dir, exist_ok=True)
            # Replace an existing symlink; never clobber a real file/dir.
            if os.path.islink(link):
                # idempotent: only re-link if it points elsewhere
                if os.path.realpath(link) == os.path.realpath(sp):
                    linked += 1
                    continue
                os.unlink(link)
            elif os.path.exists(link):
                log(actions, f"WARNING: {link} exists and is not a symlink — left untouched")
                continue
            os.symlink(sp, link, target_is_directory=True)
        linked += 1
    log(actions, f"symlink install (bundled+custom): {linked} skill(s) linked into "
                 f"~/.codex/skills/{target_agent}__*")


def create_skill_depth_compat_symlink(target_dir, apply, actions):
    """Defect 7 (skill-depth-delta): codex skills live at
    plugins/cortextos-agent-skills/skills/<x> -- ONE directory deeper than claude's
    .claude/skills/<x>. Skill scripts that anchor workspace output relative to
    __file__ with a FIXED depth -- e.g. OUTPUT_BASE = dirname(__file__)/../../../docs
    or ROOT = Path(__file__).resolve().parents[3]; ROOT/"docs" -- were correct at
    claude depth 3 but resolve to <ws>/plugins/docs at codex depth 4, silently
    mis-writing output one level short of the workspace. (github-trending-feed,
    daily-signal-pipeline, and nightly-topic-briefing all hit this in the
    an observed migration: digests landed in plugins/docs/, not docs/.)
    A single compatibility symlink <ws>/plugins/docs -> ../docs makes every such
    depth-short 'docs' anchor resolve back to the real <ws>/docs. Idempotent; never
    silently clobbers a real dir -- it merges any mis-written contents into <ws>/docs
    first, and refuses (warns) if a name collides so nothing is lost.
    NOTE: this covers the common workspace-DOCS anchor (the observed output class).
    Scripts that anchor NON-docs workspace paths via the same fixed depth (e.g.
    ROOT/".env") are flagged by verify.py's depth-anchor scan for manual review."""
    plugins_dir = os.path.join(target_dir, "plugins")
    if not os.path.isdir(plugins_dir):
        return
    link = os.path.join(plugins_dir, "docs")
    real_docs = os.path.join(target_dir, "docs")
    if os.path.islink(link) and os.path.realpath(link) == os.path.realpath(real_docs):
        log(actions, "skill-depth-compat: plugins/docs -> ../docs already correct")
        return
    if apply:
        os.makedirs(real_docs, exist_ok=True)
        if os.path.isdir(link) and not os.path.islink(link):
            for sub in sorted(os.listdir(link)):
                s = os.path.join(link, sub)
                d = os.path.join(real_docs, sub)
                if not os.path.exists(d):
                    shutil.move(s, d)
                else:
                    log(actions, f"WARNING: docs/{sub} exists in target — left "
                                 f"plugins/docs/{sub} for manual merge")
            try:
                os.rmdir(link)
            except OSError:
                log(actions, f"WARNING: {link} not empty after merge — symlink NOT "
                             f"created, resolve the collision manually")
                return
        elif os.path.islink(link):
            os.unlink(link)
        os.symlink("../docs", link)
    log(actions, "skill-depth-compat: plugins/docs -> ../docs (depth-short __file__ "
                 "anchors now resolve workspace output into <ws>/docs)")


def _sqlite_ok(path):
    """True if `path` is a sound sqlite DB (or a 0-byte placeholder, which carries
    no data to corrupt). False if it fails PRAGMA integrity_check or cannot be
    opened. Read-only open so it never mutates the file it is checking."""
    try:
        if not os.path.isfile(path) or os.path.getsize(path) == 0:
            return True
        import sqlite3
        c = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            row = c.execute("PRAGMA integrity_check;").fetchone()
        finally:
            c.close()
        return bool(row) and row[0] == "ok"
    except Exception:
        return False


def ensure_sqlite_integrity(src_dir, target_dir, apply, actions):
    """Defect 15: skill data is raw file-copied (copy_tree). Copying a LIVE sqlite
    DB while the source daemon holds it open mid-write produces a TORN copy
    (malformed, usually SMALLER than the source) — an agent's daily-signal
    signals.db came over malformed and failed its first nightly run. A raw cp gives
    no consistency guarantee for a live DB.

    PREVENT + ASSERT (self-catching, same class as the cron/routing outcome-
    assertions): walk the TARGET tree for *.db; for each malformed copy, re-copy
    from the corresponding SOURCE via the sqlite backup API (a CONSISTENT snapshot
    even of a live DB), then re-run integrity_check. os.walk does NOT follow
    symlinks, so SHARED symlinked skills are skipped — only the agent's OWN real
    copies are touched. Returns (repaired, ok_list, unrepairable). A non-empty
    `unrepairable` is a HARD migration failure for the caller (default-deny: a
    migration that cannot produce a valid DB copy must NOT report success or tear
    down the source)."""
    import sqlite3
    repaired, ok_list, unrepairable = [], [], []
    for root, _dirs, files in os.walk(target_dir):  # walk does not follow symlinks
        for fn in files:
            if not fn.endswith(".db"):
                continue
            tdb = os.path.join(root, fn)
            rel = os.path.relpath(tdb, target_dir)
            if _sqlite_ok(tdb):
                ok_list.append(rel)
                continue
            # malformed target copy. Map back to the SOURCE db: reverse the
            # skills-path rewrite (plugins/cortextos-agent-skills/skills ->
            # .claude/skills) so the source path resolves under <src_dir>.
            srel = rel.replace(REWRITE[1], REWRITE[0])
            sdb = os.path.join(src_dir, srel)
            if not (os.path.isfile(sdb) and _sqlite_ok(sdb)):
                unrepairable.append(rel)
                log(actions, f"DB-INTEGRITY (defect 15) UNREPAIRABLE: target '{rel}' is "
                             f"malformed AND its source '{sdb}' is missing or also "
                             f"malformed — cannot restore. HARD FAIL.")
                continue
            if apply:
                try:
                    # Remove the torn copy first: the backup API opens the DEST as a
                    # db, and a torn non-db dest fails ("file is not a database").
                    # A fresh dest file lets backup() populate a clean snapshot.
                    try:
                        os.remove(tdb)
                    except OSError:
                        pass
                    s = sqlite3.connect(f"file:{sdb}?mode=ro", uri=True)
                    d = sqlite3.connect(tdb)
                    try:
                        s.backup(d)
                    finally:
                        d.close()
                        s.close()
                except Exception as e:
                    unrepairable.append(rel)
                    log(actions, f"DB-INTEGRITY (defect 15) UNREPAIRABLE: backup-API "
                                 f"re-copy of '{rel}' from source failed ({e}). HARD FAIL.")
                    continue
                if _sqlite_ok(tdb):
                    repaired.append(rel)
                    log(actions, f"DB-INTEGRITY (defect 15): '{rel}' was a torn raw-copy "
                                 f"(malformed); re-copied from source via the sqlite backup "
                                 f"API; integrity_check now ok.")
                else:
                    unrepairable.append(rel)
                    log(actions, f"DB-INTEGRITY (defect 15) UNREPAIRABLE: '{rel}' still "
                                 f"malformed AFTER backup-API re-copy. HARD FAIL.")
            else:
                # dry-run: cannot write, but REPORT what would be repaired (no abort).
                repaired.append(rel)
                log(actions, f"DB-INTEGRITY (defect 15, dry-run): '{rel}' is a torn copy; "
                             f"would re-copy from source '{sdb}' via the backup API on --apply.")
    log(actions, f"DB-INTEGRITY (defect 15): {len(ok_list)} db(s) ok, {len(repaired)} "
                 f"repaired via backup API, {len(unrepairable)} UNREPAIRABLE {unrepairable}. "
                 f"Non-empty unrepairable = HARD cutover-blocking failure.")
    return repaired, ok_list, unrepairable


def rewrite_all_refs(target_dir, apply, actions):
    """Grep the whole target dir for .claude/skills and rewrite (instruction files + scripts)."""
    total = 0
    for dp, dn, fns in os.walk(target_dir):
        dn[:] = [d for d in dn if d not in ("node_modules", ".git")]
        for fn in fns:
            if fn.endswith((".md", ".sh", ".txt", ".json", ".py", ".js", ".ts")):
                total += rewrite_refs_in_file(os.path.join(dp, fn), apply, actions)
    log(actions, f"ref-rewrite sweep: {total} total '.claude/skills' hit(s) across target")


def scan_cross_agent_strands(src_dir, source_agent, target_agent, actions):
    """CUTOVER best-effort SURFACE (the migration-strands class). On cutover the
    source agent is retired and its workspace renamed agents/<source> ->
    agents/<target>; any SIBLING agent that hardcodes `agents/<source>/...` then
    reads a path the producer no longer feeds (a stale cross-agent read (agents/<src>
    class). The migration must NOT silently rewrite siblings (surgical scope) — so
    this only REPORTS the stranded refs for the operator to repoint, and
    verify.py --expect-cutover is the hard gate that FAILS until they are.
    Returns [(sibling_agent, relpath), ...]."""
    hits = []
    agents_root = os.path.dirname(os.path.normpath(src_dir))
    if not os.path.isdir(agents_root):
        return hits
    seg = re.compile(r"agents/" + re.escape(source_agent) + r"(?![\w-])")
    skip = {os.path.basename(os.path.normpath(src_dir)), source_agent, target_agent}
    for sib in sorted(os.listdir(agents_root)):
        sib_dir = os.path.join(agents_root, sib)
        if sib in skip or not os.path.isdir(sib_dir):
            continue
        for dp, dn, fns in os.walk(sib_dir):
            dn[:] = [d for d in dn if d not in ("node_modules", ".git", "state", "logs")]
            for fn in fns:
                if not fn.endswith((".md", ".sh", ".txt", ".json", ".py", ".js", ".ts")):
                    continue
                fp = os.path.join(dp, fn)
                try:
                    with open(fp, errors="ignore") as f:
                        if seg.search(f.read()):
                            hits.append((sib, os.path.relpath(fp, agents_root)))
                except Exception:
                    pass
    if hits:
        log(actions, f"CUTOVER cross-agent strands: {len(hits)} sibling ref(s) to retired "
                     f"agents/{source_agent} — REPOINT to agents/{target_agent} before enabling "
                     f"(verify.py --expect-cutover hard-fails until clean): {hits}")
    else:
        log(actions, f"CUTOVER cross-agent strands: no sibling refs to agents/{source_agent} (clean)")
    return hits


def _toml_basic_str(s):
    """Escape a Python value as the body of a TOML basic string (no surrounding quotes)."""
    return (str(s).replace("\\", "\\\\").replace('"', '\\"')
            .replace("\n", "\\n").replace("\t", "\\t"))


def _existing_mcp_server_names(config_text):
    """Server names already declared as [mcp_servers.<name>] in a config.toml text."""
    return set(re.findall(r'(?m)^\s*\[mcp_servers\.([^\].]+)\]\s*$', config_text))


_MCP_MIGRATION_HEADER_RE = re.compile(
    r"^# === migrated MCP servers for agent '([^']*)' "
    r"\(claude-to-codex-migration\) ===\s*$")


def _split_self_owned_mcp_region(config_text, target_agent):
    """Partition config.toml text into (foreign_text, self_owned_names).

    A block THIS skill previously wrote for target_agent begins at its
    `# === migrated MCP servers for agent '<target_agent>' (claude-to-codex-migration) ===`
    header and runs to the next such header (any agent) or EOF. Its
    [mcp_servers.<name>] names are SELF-OWNED: a re-run must idempotently OVERWRITE
    them, NOT treat them as a host-global collision (fix for the re-run self-abort —
    the header was written but never parsed back, so a second --apply on an
    MCP-bearing agent hard-stopped on its OWN prior write). Everything else (hand
    config + OTHER agents' migrated blocks) is foreign and returned untouched, so the
    caller can strip only its own stale region before re-appending."""
    lines = config_text.splitlines(keepends=True)
    foreign, owned_names = [], set()
    i, n = 0, len(lines)
    while i < n:
        m = _MCP_MIGRATION_HEADER_RE.match(lines[i].rstrip("\n"))
        if m:
            region = [lines[i]]
            j = i + 1
            while j < n and not _MCP_MIGRATION_HEADER_RE.match(lines[j].rstrip("\n")):
                region.append(lines[j])
                j += 1
            if m.group(1) == target_agent:
                owned_names |= _existing_mcp_server_names("".join(region))
            else:
                foreign.extend(region)
            i = j
        else:
            foreign.append(lines[i])
            i += 1
    return "".join(foreign), owned_names


def _bearer_from_headers(headers):
    """Pull the raw token from a Claude .mcp.json 'Authorization: Bearer <tok>' header."""
    for k, v in (headers or {}).items():
        if k.lower() == "authorization":
            m = re.match(r"\s*Bearer\s+(.+?)\s*$", str(v), re.I)
            if m:
                return m.group(1).strip()
    return None


def _mcp_env_var_name(name):
    return re.sub(r"[^A-Z0-9]", "_", name.upper()) + "_MCP_TOKEN"


def emit_mcp_toml(manifest, target_agent, target_dir, apply, actions):
    """Migrate each source MCP server into the host-global ~/.codex/config.toml as a
    [mcp_servers.<name>] table, MERGING — never overwriting (the file is shared by
    every codex agent on the host). Returns (written, needs_secret, collisions).

    fix #16: this was a print-only STUB (placeholder args/env, no token, never wrote
    config), so Codex started ZERO migrated servers (a migrated agent's Notion server was dead until
    hand-fixed). Now it actually writes the tables, carries the http bearer token from
    the source headers into org secrets.env (env-var indirection — the secret never
    lands in config.toml), and treats a host-global name COLLISION as a HARD-STOP:
    a colliding server cannot be installed = a broken agent, so we write NOTHING and
    the caller aborts the cutover (mirrors the sqlite-integrity gate). verify.py
    asserts every server is present in config.toml AND, live, that Codex starts it."""
    servers = manifest.get("mcp", {}).get("servers", [])
    if not servers:
        log(actions, "no MCP servers to migrate")
        return [], [], []

    codex_cfg = os.path.join(os.path.expanduser("~"), ".codex", "config.toml")
    existing_text = ""
    if os.path.isfile(codex_cfg):
        with open(codex_cfg, errors="ignore") as f:
            existing_text = f.read()
    # A re-run must OVERWRITE this agent's own prior migrated block, not self-collide
    # on it. Split off self-owned names so only FOREIGN [mcp_servers.<name>] entries
    # (hand config + other agents' blocks) count as host-global collisions.
    foreign_text, self_owned = _split_self_owned_mcp_region(existing_text, target_agent)
    existing_names = _existing_mcp_server_names(foreign_text)

    # org secrets.env: target_dir is <...>/orgs/<org>/agents/<agent> -> two up + secrets.env
    secrets_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.normpath(target_dir))), "secrets.env")
    spairs, sseen = _read_env(secrets_path)

    blocks, written, needs_secret, collisions = [], [], [], []
    for s in servers:
        name = s["name"]
        if name in existing_names:
            collisions.append(name)
            log(actions, f"MCP HARD-STOP: server '{name}' already declared in {codex_cfg} "
                         f"(host-global name collision; a human must rename before convert)")
            continue
        if name in self_owned:
            log(actions, f"MCP '{name}': overwriting this agent's own prior migrated "
                         f"table (idempotent re-run, not a collision)")
        lines = [f"[mcp_servers.{name}]"]
        if s.get("transport") == "http":
            env_var = _mcp_env_var_name(name)
            lines.append(f'url = "{_toml_basic_str(s.get("url") or "")}"')
            lines.append(f'bearer_token_env_var = "{env_var}"')
            tok = _bearer_from_headers(s.get("headers"))
            if tok:
                _set_env_key(spairs, sseen, env_var, tok)
                log(actions, f"MCP '{name}' (http): carried {env_var} into "
                             f"{os.path.basename(secrets_path)} from source headers")
            else:
                needs_secret.append(env_var)
                log(actions, f"MCP '{name}' (http): NO token in source headers -> provision "
                             f"{env_var} in secrets.env (verify FAILS until set)")
        else:
            lines.append(f'command = "{_toml_basic_str(s.get("command") or "")}"')
            a = s.get("args") or []
            if a:
                lines.append("args = [" + ", ".join(f'"{_toml_basic_str(x)}"' for x in a) + "]")
            if s.get("cwd"):
                lines.append(f'cwd = "{_toml_basic_str(s.get("cwd"))}"')
            env = s.get("env") or {}
            if env:
                lines.append("")
                lines.append(f"[mcp_servers.{name}.env]")
                for k, v in env.items():
                    lines.append(f'{k} = "{_toml_basic_str(v)}"')
            log(actions, f"MCP '{name}' (stdio): {len(a)} arg(s), {len(env)} env key(s) "
                         f"-> [mcp_servers.{name}]")
        blocks.append("\n".join(lines))
        written.append(name)

    # Host-global collision = HARD-STOP: write NOTHING, signal the caller to abort the
    # cutover (a partial MCP install on an aborted cutover would be inconsistent state).
    if collisions:
        return [], needs_secret, collisions

    if apply and blocks:
        os.makedirs(os.path.dirname(codex_cfg), exist_ok=True)
        region = (f"# === migrated MCP servers for agent '{target_agent}' "
                  f"(claude-to-codex-migration) ===\n" + "\n\n".join(blocks) + "\n")
        # Idempotent: rewrite foreign content (own prior region already stripped) + the
        # fresh block, so a re-run replaces its own block instead of appending a second
        # (duplicate [mcp_servers.<name>] tables). Foreign hand config + other agents'
        # blocks are preserved verbatim.
        base = foreign_text.rstrip("\n")
        new_text = (base + "\n\n" + region) if base else region
        with open(codex_cfg, "w") as f:
            f.write(new_text)
        _write_env(secrets_path, spairs, apply)
        log(actions, f"MCP: wrote {len(written)} server table(s) into {codex_cfg} "
                     f"(idempotent: own prior block replaced)")

    return written, needs_secret, collisions


def _find_fresh_handoff(handoffs_dir, after_ts):
    """Return the path of the NEWEST handoff file in handoffs_dir whose mtime is
    STRICTLY AFTER after_ts (the migration-start timestamp), or None. A
    pre-existing stale handoff (mtime <= after_ts) does NOT satisfy this — the
    write-side gate requires the source to have produced a FRESH handoff."""
    if not os.path.isdir(handoffs_dir):
        return None
    candidates = []
    for fn in os.listdir(handoffs_dir):
        fp = os.path.join(handoffs_dir, fn)
        if not os.path.isfile(fp):
            continue
        try:
            mt = os.path.getmtime(fp)
        except OSError:
            continue
        if mt > after_ts:
            candidates.append((mt, fp))
    if not candidates:
        return None
    candidates.sort()
    return candidates[-1][1]  # newest fresh handoff


def await_fresh_handoff(src_dir, source_agent, migration_start_ts, wait_seconds,
                        poll_seconds, apply, actions):
    """Write-side handoff enforcement (defect 2). BLOCK and poll the SOURCE agent's
    REAL handoff output dir for a handoff produced AFTER migration start (the live
    source runs its normal handoff:create at cutover — NOT a synthesized handoff).
    8i FIX: agents write handoffs to their WORKSPACE memory/handoffs/, NOT
    state/<source>/handoffs/ (that dir does not even exist for most agents), so the
    gate polls <src_dir>/memory/handoffs/. A pre-existing stale handoff does NOT
    satisfy the gate. If no fresh handoff appears within wait_seconds, return None —
    the caller MUST ABORT the cutover (do NOT disable source, do NOT enable target).
    Returns the fresh handoff path on success."""
    handoffs_dir = os.path.join(src_dir, "memory", "handoffs")
    fresh = _find_fresh_handoff(handoffs_dir, migration_start_ts)
    if fresh:
        log(actions, f"write-side gate: fresh source handoff found at "
                     f"{os.path.relpath(fresh, src_dir)} (mtime > migration start)")
        return fresh
    if not apply:
        # Dry-run: do not block. Report what WOULD be required.
        log(actions, f"write-side gate (dry-run): would BLOCK up to {wait_seconds}s "
                     f"polling {source_agent} workspace memory/handoffs/ for a handoff "
                     f"produced AFTER migration start; abort cutover if none appears")
        return None
    deadline = time.time() + wait_seconds
    log(actions, f"write-side gate: BLOCKING up to {wait_seconds}s for the live source "
                 f"'{source_agent}' to produce a FRESH handoff (run handoff:create now)")
    while time.time() < deadline:
        time.sleep(poll_seconds)
        fresh = _find_fresh_handoff(handoffs_dir, migration_start_ts)
        if fresh:
            log(actions, f"write-side gate: fresh handoff produced -> "
                         f"{os.path.relpath(fresh, src_dir)}")
            return fresh
    log(actions, f"FAIL: write-side gate TIMED OUT after {wait_seconds}s — source "
                 f"produced no fresh handoff. ABORTING cutover: source NOT disabled, "
                 f"target NOT enabled.")
    return None


def force_fresh(ctx_root, target_agent, apply, actions):
    """Drop the .force-fresh marker and EXCLUDE ONLY the stale session transcript(s)
    — the narrow, legitimate reason this step exists. Carries the rest of the boot
    state via carry_state_continuity(); this function NEVER wipes the whole state
    dir (the old over-broad behavior dropped .onboarded -> cold onboard)."""
    state_dir = os.path.join(ctx_root, "state", target_agent)
    marker = os.path.join(state_dir, ".force-fresh")
    if apply:
        os.makedirs(state_dir, exist_ok=True)
        with open(marker, "w") as f:
            f.write("")
        # Exclude ONLY the stale session transcripts (codex thread file / *thread.json)
        # that would cause a stale-session resume crash. Everything else was carried.
        removed = []
        for fn in os.listdir(state_dir):
            fp = os.path.join(state_dir, fn)
            if not os.path.isfile(fp):
                continue
            if fn in STATE_EXCLUDE_EXACT or fn.endswith(STATE_EXCLUDE_SUFFIXES):
                os.remove(fp)
                removed.append(fn)
        if removed:
            log(actions, f"excluded stale session transcript(s): {', '.join(removed)}")
    log(actions, f".force-fresh marker dropped at state/{target_agent}/; stale session "
                 f"transcript(s) (*thread.json) excluded; boot-state continuity preserved")


def delete_claude_artifacts(target_dir, apply, actions):
    """If add-agent or a verbatim copy left .claude/ in the target, remove it.

    Recursively removes NESTED .claude/ dirs and CLAUDE.md files anywhere inside
    the target too (a copied workspace can carry its own .claude/CLAUDE.md, which
    a top-level-only delete would leave live)."""
    # Recursive sweep first: any nested .claude dir or CLAUDE.md inside copied content.
    nested = 0
    for dp, dn, fns in os.walk(target_dir, topdown=True):
        dn[:] = [d for d in dn if d != "node_modules"]
        if ".claude" in dn:
            cdir = os.path.join(dp, ".claude")
            if apply:
                shutil.rmtree(cdir)
            dn.remove(".claude")  # don't descend into a dir we just (logically) removed
            nested += 1
            log(actions, f"removed nested .claude/ at {os.path.relpath(cdir, target_dir)}")
        for fn in fns:
            if fn == "CLAUDE.md":
                cm = os.path.join(dp, fn)
                if apply:
                    os.remove(cm)
                nested += 1
                log(actions, f"removed CLAUDE.md at {os.path.relpath(cm, target_dir)}")
    if nested:
        log(actions, f"recursive claude-artifact sweep: {nested} nested .claude/ or CLAUDE.md removed")
    # Belt-and-braces: ensure top-level .claude/ and CLAUDE.md are gone (the sweep
    # above already covers them, but keep an explicit assertion line for the report).
    if os.path.isdir(os.path.join(target_dir, ".claude")):
        if apply:
            shutil.rmtree(os.path.join(target_dir, ".claude"))
        log(actions, "removed top-level .claude/ from target — codex cruft")
    if os.path.isfile(os.path.join(target_dir, "CLAUDE.md")):
        if apply:
            os.remove(os.path.join(target_dir, "CLAUDE.md"))
        log(actions, "deleted top-level CLAUDE.md from target (codex auto-reads AGENTS.md only)")


def disable_in_registry(ctx_root, target_agent, apply, actions):
    """CRITICAL safety: `cortextos add-agent` registers the new agent in
    $CTX_ROOT/config/enabled-agents.json as {"enabled": true, ...}. The
    agent-dir config.json enabled=false is NOT enough — the daemon reads the
    REGISTRY. So a migrated agent can be left LIVE in the registry while
    config.json reports disabled. Flip ONLY the target's key to enabled:false,
    MERGE (never overwrite) the json, and touch NO other agent's entry."""
    reg_path = os.path.join(ctx_root, "config", "enabled-agents.json")
    if not os.path.isfile(reg_path):
        log(actions, f"WARNING: enabled-agents.json not found at {reg_path} — "
                     f"cannot assert registry-disabled; verify add-agent ran")
        return
    try:
        with open(reg_path) as f:
            reg = json.load(f)
    except Exception as e:
        log(actions, f"WARNING: could not parse {reg_path} ({e}) — registry NOT modified")
        return
    if not isinstance(reg, dict):
        log(actions, f"WARNING: {reg_path} is not a JSON object — registry NOT modified")
        return
    entry = reg.get(target_agent)
    if entry is None:
        log(actions, f"WARNING: target '{target_agent}' absent from enabled-agents.json — "
                     f"add-agent registration may not have run; nothing to disable")
        return
    was = entry.get("enabled")
    if isinstance(entry, dict):
        entry["enabled"] = False  # mutate only the target's sub-object
    else:
        reg[target_agent] = {"enabled": False}
    if apply:
        with open(reg_path, "w") as f:
            json.dump(reg, f, indent=2)
            f.write("\n")
    log(actions, f"registry: enabled-agents.json['{target_agent}'].enabled "
                 f"{was} -> False (merge, other agents untouched)")


# ---------------------------------------------------------------------------
# Interactive-flow helpers: bot-token modes, source cutover, codex boot.
# All are NO-OPs unless the implementing agent passes the user-confirmed flags.
# ---------------------------------------------------------------------------

def _read_env(path):
    """Parse a KEY=VALUE .env into an ordered dict (preserves order, ignores
    comments/blanks)."""
    pairs = []
    seen = {}
    if not os.path.isfile(path):
        return pairs, seen
    with open(path, errors="ignore") as f:
        for line in f:
            raw = line.rstrip("\n")
            t = raw.strip()
            if not t or t.startswith("#") or "=" not in t:
                pairs.append((None, raw))  # passthrough line
                continue
            k = t[:t.index("=")].strip()
            v = t[t.index("=") + 1:]
            pairs.append((k, v))
            seen[k] = len(pairs) - 1
    return pairs, seen


def _write_env(path, pairs, apply):
    if not apply:
        return
    out = []
    for k, v in pairs:
        out.append(v if k is None else f"{k}={v}")
    with open(path, "w") as f:
        f.write("\n".join(out).rstrip("\n") + "\n")
    os.chmod(path, 0o600)


def _set_env_key(pairs, seen, key, value):
    """Set key=value in the parsed env list, in place, appending if absent."""
    if key in seen:
        pairs[seen[key]] = (key, value)
    else:
        pairs.append((key, value))
        seen[key] = len(pairs) - 1


def _get_src_bot_token(src_dir):
    pairs, seen = _read_env(os.path.join(src_dir, ".env"))
    if "BOT_TOKEN" in seen:
        return pairs[seen["BOT_TOKEN"]][1]
    return None


def disable_source(src_dir, ctx_root, source_agent, instance, apply, actions):
    """CUTOVER source-disable (reuse mode ONLY): set the SOURCE Claude agent's
    config.json enabled=false AND its registry entry enabled=false, THEN actually
    STOP the running source poller via `cortextos disable`. Telegram allows ONE
    poller per bot, so reusing the source's bot REQUIRES the source to STOP
    polling. The JSON flips alone do NOT stop a live poller — the daemon reads
    enabled-agents.json only at startup (no fs.watch), so a flipped JSON leaves
    the source poller running; booting codex on the same token would then create
    TWO getUpdates pollers = Telegram 409 conflict = outage. So this function
    returns True ONLY when the live source is CONFIRMED stopped; the caller MUST
    NOT boot codex if it returns False. This is the ONLY path that ever touches
    the source, and it only runs on explicit --bot-mode reuse."""
    # source config.json
    src_cfg_path = os.path.join(src_dir, "config.json")
    if os.path.isfile(src_cfg_path):
        with open(src_cfg_path) as f:
            scfg = json.load(f)
        was = scfg.get("enabled")
        scfg["enabled"] = False
        if apply:
            with open(src_cfg_path, "w") as f:
                json.dump(scfg, f, indent=2)
                f.write("\n")
        log(actions, f"CUTOVER: source '{source_agent}' config.json enabled "
                     f"{was} -> False")
    else:
        log(actions, f"WARNING: source config.json not found at {src_cfg_path} — "
                     f"cannot disable source config")
    # source registry entry (the daemon-read disable)
    reg_path = os.path.join(ctx_root, "config", "enabled-agents.json")
    if not os.path.isfile(reg_path):
        log(actions, f"WARNING: enabled-agents.json not found at {reg_path} — "
                     f"cannot disable source in registry")
    else:
        try:
            with open(reg_path) as f:
                reg = json.load(f)
        except Exception as e:
            log(actions, f"WARNING: could not parse {reg_path} ({e}) — source registry NOT modified")
            reg = None
        if reg is not None and not isinstance(reg, dict):
            log(actions, f"WARNING: {reg_path} is not a JSON object — source registry NOT modified")
        elif reg is not None:
            entry = reg.get(source_agent)
            if entry is None:
                log(actions, f"WARNING: source '{source_agent}' absent from enabled-agents.json — "
                             f"nothing to disable in registry")
            else:
                was = entry.get("enabled") if isinstance(entry, dict) else entry
                if isinstance(entry, dict):
                    entry["enabled"] = False
                else:
                    reg[source_agent] = {"enabled": False}
                if apply:
                    with open(reg_path, "w") as f:
                        json.dump(reg, f, indent=2)
                        f.write("\n")
                log(actions, f"CUTOVER: registry enabled-agents.json['{source_agent}'].enabled "
                             f"{was} -> False (merge, other agents untouched)")

    # P0-1: the JSON flips above do NOT stop the running source poller (the daemon
    # reads enabled-agents.json only at startup — no fs.watch). We MUST issue the
    # real daemon stop via `cortextos disable`, which sends IPC stop-agent AND
    # writes the source's .user-disable marker. If this does not confirm a stop,
    # the caller MUST NOT boot codex (two pollers on one bot = Telegram 409).
    if not apply:
        log(actions, f"CUTOVER (dry-run): would run `cortextos disable {source_agent} "
                     f"--instance {instance}` to STOP the live source poller")
        return True  # dry-run: pretend the stop succeeded so flow logging proceeds
    cmd = ["cortextos", "disable", source_agent, "--instance", instance]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        log(actions, f"CUTOVER: ran `{' '.join(cmd)}` -> exit {r.returncode}")
        if r.returncode != 0:
            log(actions, f"FAIL: `cortextos disable` returned {r.returncode}: "
                         f"{r.stderr.strip()[:300]} — source poller NOT confirmed stopped; "
                         f"REFUSING to boot codex (would create a double-poller 409 outage)")
            return False
    except Exception as e:
        log(actions, f"FAIL: `cortextos disable` could not run ({e}) — source poller "
                     f"NOT confirmed stopped; REFUSING to boot codex (double-poller risk)")
        return False
    log(actions, f"CUTOVER: source '{source_agent}' poller CONFIRMED stopped via daemon")
    return True


def disable_source_crons(src_dir, ctx_root, source_agent, apply, actions):
    """CUTOVER (defect 11a): disable the RETIRED source agent's crons.

    disable_source() stops the source AGENT (config.json + registry + `cortextos
    disable`), which halts its live cron-scheduler — BUT the source crons stay
    enabled:true in BOTH the live registry (crons.json) and config.json. Those
    persisted enabled flags re-fire on any daemon restart / re-enable, and the
    daemon has been observed firing retired-agent crons from the registry — a
    durable dual-scheduler hazard once the target carries the same crons. There was
    NEVER a step that disabled the source CRONS (only the agent); both live
    migrations were hand-rescued, masking the gap (now baked + asserted by
    verify.py so it is self-catching).

    Disables RECURRING source crons (set enabled:false) in crons.json AND
    config.json. HOLDS one-shot crons (config type:once / fire_at) ENABLED — they
    have no daemon-loadable twin until the operator re-arms them on the target, so
    disabling them here would leave the reminder armed NOWHERE. Returns
    (disabled_recurring, held_once)."""
    # identify once-crons from config (the same rule migrate_crons uses)
    once_names = set()
    src_cfg_path = os.path.join(src_dir, "config.json")
    cfg = None
    if os.path.isfile(src_cfg_path):
        try:
            with open(src_cfg_path) as f:
                cfg = json.load(f)
            for c in (cfg.get("crons") or []):
                nm = c.get("name")
                if nm and (c.get("type") == "once" or c.get("fire_at") or c.get("fireAt")):
                    once_names.add(nm)
        except Exception as e:
            log(actions, f"WARNING: could not parse source config.json ({e}) — "
                         f"cannot classify once-crons; treating all as recurring")

    disabled, held = [], []

    # (1) live registry crons.json — the file the daemon actually fires from.
    reg_path = os.path.join(ctx_root, ".cortextOS", "state", "agents",
                            source_agent, "crons.json")
    if os.path.isfile(reg_path):
        try:
            with open(reg_path) as f:
                reg = json.load(f)
        except Exception as e:
            log(actions, f"WARNING: could not parse source registry {reg_path} ({e}) — "
                         f"source registry crons NOT disabled")
            reg = None
        if isinstance(reg, dict) and isinstance(reg.get("crons"), list):
            for c in reg["crons"]:
                nm = c.get("name")
                if not nm:
                    continue
                if nm in once_names:
                    held.append(nm)
                    continue
                if c.get("enabled") is not False:
                    c["enabled"] = False
                    disabled.append(nm)
            if apply:
                with open(reg_path, "w") as f:
                    json.dump(reg, f, indent=2)
                    f.write("\n")
    else:
        log(actions, f"note: no source registry at {reg_path} — nothing to disable there")

    # (2) source config.json crons[] — keep the persisted copy consistent so a
    # later daemon read of config does not re-enable a disabled cron.
    if cfg is not None and isinstance(cfg.get("crons"), list):
        changed = False
        for c in cfg["crons"]:
            nm = c.get("name")
            if not nm or nm in once_names:
                continue
            if c.get("enabled") is not False:
                c["enabled"] = False
                changed = True
        if changed and apply:
            with open(src_cfg_path, "w") as f:
                json.dump(cfg, f, indent=2)
                f.write("\n")

    # dedupe for the log
    disabled = sorted(set(disabled))
    held = sorted(set(held))
    log(actions, f"CUTOVER (defect 11a): disabled {len(disabled)} RECURRING source cron(s) "
                 f"in registry+config: {disabled}. HELD {len(held)} one-shot(s) ENABLED "
                 f"(no daemon-loadable twin until re-armed on target): {held} — the operator "
                 f"must re-arm these on the target, THEN disable them on the source. "
                 f"verify.py --expect-cutover asserts no RECURRING source cron stays enabled.")
    return disabled, held


def apply_bot_mode(bot_mode, new_bot_token, src_dir, target_dir, ctx_root,
                   source_agent, instance, apply, actions):
    """Apply the user-chosen bot-token strategy to the codex .env. Returns
    True if a cutover (source-disable, source CONFIRMED stopped) was performed
    (which implies boot). Returns False otherwise (no boot)."""
    env_path = os.path.join(target_dir, ".env")
    pairs, seen = _read_env(env_path)
    if bot_mode == "reuse":
        token = _get_src_bot_token(src_dir)
        if not token:
            # P1-2: reuse means "take over the SOURCE bot". With no source
            # BOT_TOKEN there is nothing to reuse — booting on a stale carried
            # token while tearing down the source is an outage. HARD STOP:
            # do NOT disable the source, do NOT boot.
            log(actions, "FAIL: --bot-mode reuse but source .env has NO BOT_TOKEN — "
                         "nothing to reuse. HARD STOP: source NOT disabled, codex NOT "
                         "booted. Use --bot-mode new with a fresh token instead.")
            return False
        _set_env_key(pairs, seen, "BOT_TOKEN", token)
        _write_env(env_path, pairs, apply)
        log(actions, "bot-mode reuse: copied source BOT_TOKEN into codex .env (0600)")
        # the cutover: disable AND confirm-stop the source so only ONE poller
        # runs the bot. If the source is NOT confirmed stopped, do NOT boot.
        stopped = disable_source(src_dir, ctx_root, source_agent, instance, apply, actions)
        if not stopped:
            log(actions, "FAIL: cutover source-disable did not confirm a stop — "
                         "codex will NOT boot (double-poller 409 prevention)")
            return False
        log(actions, "bot-mode reuse implies boot — codex takes over the original bot")
        return True
    if bot_mode == "new":
        if new_bot_token:
            _set_env_key(pairs, seen, "BOT_TOKEN", new_bot_token)
            _write_env(env_path, pairs, apply)
            log(actions, "bot-mode new: wrote user-provided BOT_TOKEN into codex .env (0600)")
        else:
            placeholder = "REPLACE_ME_WITH_NEW_BOT_TOKEN"
            _set_env_key(pairs, seen, "BOT_TOKEN", placeholder)
            _write_env(env_path, pairs, apply)
            log(actions, f"NEEDS-HUMAN: --bot-mode new with no --new-bot-token — wrote "
                         f"placeholder BOT_TOKEN='{placeholder}' into codex .env; user must "
                         f"paste a real token from @BotFather before boot")
        return False
    # none / default: source untouched, no token change
    log(actions, "bot-mode none (default): source untouched, codex BOT_TOKEN unchanged")
    return False


def boot_codex(target_dir, target_agent, ctx_root, org, instance, apply, actions):
    """Enable the codex agent: flip config.json + registry to enabled:true, then
    start it with `cortextos enable` (the daemon-driven start). ONLY on --boot now
    (or implied by bot-mode reuse). Default path never calls this.

    Returns the `cortextos enable` exit code (0 = started). Returns 0 in dry-run
    (nothing ran) and None if apply but the command could not run at all — the
    caller treats non-zero/None as a boot failure and (in a cutover) rolls back."""
    # config.json enabled = true
    cfg_path = os.path.join(target_dir, "config.json")
    if os.path.isfile(cfg_path):
        with open(cfg_path) as f:
            cfg = json.load(f)
        cfg["enabled"] = True
        if apply:
            with open(cfg_path, "w") as f:
                json.dump(cfg, f, indent=2)
                f.write("\n")
        log(actions, "boot: codex config.json enabled -> True")
    # registry enabled = true (merge-only)
    reg_path = os.path.join(ctx_root, "config", "enabled-agents.json")
    if not os.path.isfile(reg_path):
        # P2-2: parity with disable_in_registry — surface a missing registry.
        log(actions, f"WARNING: enabled-agents.json not found at {reg_path} — "
                     f"cannot set boot enabled:true in registry (the daemon-read "
                     f"state); verify add-agent ran")
    else:
        try:
            with open(reg_path) as f:
                reg = json.load(f)
        except Exception as e:
            log(actions, f"WARNING: could not parse {reg_path} ({e}) — boot registry NOT modified")
            reg = None
        if reg is not None and not isinstance(reg, dict):
            log(actions, f"WARNING: {reg_path} is not a JSON object — boot registry NOT modified")
        elif isinstance(reg, dict):
            entry = reg.get(target_agent)
            if isinstance(entry, dict):
                entry["enabled"] = True
            else:
                reg[target_agent] = {"enabled": True}
            if apply:
                with open(reg_path, "w") as f:
                    json.dump(reg, f, indent=2)
                    f.write("\n")
            log(actions, f"boot: registry enabled-agents.json['{target_agent}'].enabled -> True")
    # daemon start via cortextos enable
    cmd = ["cortextos", "enable", target_agent, "--instance", instance]
    if org:
        cmd += ["--org", org]
    if not apply:
        log(actions, f"boot (dry-run): would run `{' '.join(cmd)}`")
        return 0
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        log(actions, f"boot: ran `{' '.join(cmd)}` -> exit {r.returncode}")
        if r.returncode != 0:
            log(actions, f"WARNING: `cortextos enable` failed: {r.stderr.strip()[:300]}")
        return r.returncode
    except Exception as e:
        log(actions, f"WARNING: `cortextos enable` could not run ({e})")
        return None


def rollback_source(src_dir, ctx_root, source_agent, org, instance, apply, actions):
    """P0-3: a cutover boot FAILED after the source was already disabled+stopped.
    The bot is now orphaned (source down, codex never started) = OUTAGE. Restore
    the source: flip its config.json + registry back to enabled:true and restart
    it via `cortextos enable`. Returns True if the source restart was confirmed."""
    log(actions, f"ROLLBACK: cutover boot failed AFTER source was disabled — "
                 f"restoring source '{source_agent}' to undo the outage")
    # source config.json enabled = true
    src_cfg_path = os.path.join(src_dir, "config.json")
    if os.path.isfile(src_cfg_path):
        with open(src_cfg_path) as f:
            scfg = json.load(f)
        scfg["enabled"] = True
        if apply:
            with open(src_cfg_path, "w") as f:
                json.dump(scfg, f, indent=2)
                f.write("\n")
        log(actions, f"ROLLBACK: source config.json enabled -> True")
    # source registry enabled = true (merge-only)
    reg_path = os.path.join(ctx_root, "config", "enabled-agents.json")
    if os.path.isfile(reg_path):
        try:
            with open(reg_path) as f:
                reg = json.load(f)
        except Exception:
            reg = None
        if isinstance(reg, dict):
            entry = reg.get(source_agent)
            if isinstance(entry, dict):
                entry["enabled"] = True
            else:
                reg[source_agent] = {"enabled": True}
            if apply:
                with open(reg_path, "w") as f:
                    json.dump(reg, f, indent=2)
                    f.write("\n")
            log(actions, f"ROLLBACK: registry['{source_agent}'].enabled -> True")
    # restart the source poller
    cmd = ["cortextos", "enable", source_agent, "--instance", instance]
    if org:
        cmd += ["--org", org]
    if not apply:
        log(actions, f"ROLLBACK (dry-run): would run `{' '.join(cmd)}`")
        return True
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        log(actions, f"ROLLBACK: ran `{' '.join(cmd)}` -> exit {r.returncode}")
        if r.returncode != 0:
            log(actions, f"ROLLBACK FAILED: `cortextos enable {source_agent}` returned "
                         f"{r.returncode}: {r.stderr.strip()[:300]} — SOURCE STILL DOWN, "
                         f"MANUAL INTERVENTION REQUIRED")
            return False
        log(actions, f"ROLLBACK: source '{source_agent}' restarted — outage averted")
        return True
    except Exception as e:
        log(actions, f"ROLLBACK FAILED: could not restart source ({e}) — SOURCE STILL "
                     f"DOWN, MANUAL INTERVENTION REQUIRED")
        return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--src-dir", required=True)
    ap.add_argument("--target-dir", required=True)
    ap.add_argument("--target-agent", required=True)
    ap.add_argument("--ctx-root", required=True)
    ap.add_argument("--apply", action="store_true")
    # Interactive-flow flags (Step 2 of SKILL.md). Safe defaults: no token
    # change, source untouched, codex disabled — i.e. today's behavior.
    ap.add_argument("--bot-mode", choices=["reuse", "new", "none"], default="none",
                    help="reuse=cutover (disable source, copy its bot token, imply boot); "
                         "new=write --new-bot-token; none=no token change (default)")
    ap.add_argument("--new-bot-token", default=None,
                    help="token to write into the codex .env when --bot-mode new")
    ap.add_argument("--boot", choices=["now", "no"], default="no",
                    help="now=enable+start the codex agent; no=leave disabled (default)")
    ap.add_argument("--source-agent", default=None,
                    help="source agent name (for reuse-cutover source-disable); "
                         "defaults to manifest source_agent")
    ap.add_argument("--org", default=None, help="org (for `cortextos enable` on boot)")
    ap.add_argument("--instance", default="default", help="instance id (for boot enable)")
    # Write-side handoff gate (defect 2). The migration-start timestamp is the cutoff:
    # only a handoff produced AFTER it satisfies the gate (a stale pre-existing one
    # does not). Defaults to now-at-parse-time if unset.
    ap.add_argument("--migration-start-ts", type=float, default=None,
                    help="epoch seconds marking migration start; only a source handoff "
                         "with mtime AFTER this satisfies the write-side gate "
                         "(default: now)")
    ap.add_argument("--handoff-wait", type=int, default=300,
                    help="max seconds to BLOCK polling for a fresh source handoff "
                         "before ABORTING the cutover (default 300)")
    ap.add_argument("--handoff-poll", type=int, default=5,
                    help="seconds between handoff polls (default 5)")
    # INSTANCE-DISCOVERY params (public generality). All optional; each degrades to
    # discovery-from-source then safe-degrade when absent.
    ap.add_argument("--orchestrator", default=None,
                    help="orchestrator agent that principal-facing sends route THROUGH "
                         "(the reroute target). If omitted, best-effort auto-scan of "
                         "sibling agents for a positive role signal; if none, the cron "
                         "reroute SAFE-DEGRADES (crons flagged for human review).")
    ap.add_argument("--principal-chat-id", default=None,
                    help="principal's Telegram chat id (literal-reroute match). If "
                         "omitted, discovered from source .env CHAT_ID/ALLOWED_USER.")
    ap.add_argument("--principal-name", default=None,
                    help="principal's name (prose-intent detection + guard text). If "
                         "omitted, discovered from source .env ALLOWED_USER if non-numeric.")
    args = ap.parse_args()
    migration_start_ts = args.migration_start_ts if args.migration_start_ts is not None else time.time()

    with open(args.manifest) as f:
        manifest = json.load(f)

    # P1-1: reuse INHERENTLY means cutover+boot (take over the source's bot, which
    # requires stopping the source and starting codex). `--bot-mode reuse --boot no`
    # is a self-contradiction the old code silently resolved as "cutover anyway".
    # Reject it loudly so the operator picks a coherent combination.
    if args.bot_mode == "reuse" and args.boot == "no":
        print("ERROR: --bot-mode reuse --boot no is contradictory. Reuse takes over "
              "the source's bot, which REQUIRES disabling the source and booting "
              "codex. If you don't want to boot, don't reuse (use --bot-mode none, "
              "or --bot-mode new for a side-by-side codex agent).", file=sys.stderr)
        sys.exit(2)

    # P0-2: host model auth preflight. Codex model auth is host-global
    # (~/.codex/auth.json). A codex agent with no host login crash-loops on first
    # turn — and in a cutover the source is already down, so the bot is orphaned =
    # OUTAGE. Gate the ENTIRE destructive path (source-disable AND boot) on host
    # auth existing. Only enforced on --apply with a boot/cutover requested; the
    # non-destructive default + dry-run are unaffected.
    will_boot = args.apply and ((args.boot == "now") or (args.bot_mode == "reuse"))
    if will_boot:
        auth_path = os.path.expanduser("~/.codex/auth.json")
        if not os.path.isfile(auth_path):
            print(f"ERROR: host codex auth missing at {auth_path}. A codex agent with "
                  f"no host login crash-loops on first turn; in a cutover the source "
                  f"is already down, so this would be an OUTAGE. Run `codex login` "
                  f"(host-global model auth) and re-run. ABORTING the cutover/boot — "
                  f"source left UNTOUCHED.", file=sys.stderr)
            sys.exit(2)

    if manifest.get("hard_stops"):
        print("REFUSING: hard stops present:", file=sys.stderr)
        for h in manifest["hard_stops"]:
            print(f"  - {h}", file=sys.stderr)
        sys.exit(2)

    if not os.path.isdir(args.target_dir):
        print(f"ERROR: target dir {args.target_dir} not found. Run "
              f"`cortextos add-agent {args.target_agent} --template agent-codex "
              f"--runtime codex-app-server` first.", file=sys.stderr)
        sys.exit(1)

    # The codex skeleton (add-agent --template agent-codex) is a MANDATORY,
    # ordered prerequisite. An empty/hand-made target dir lacks the
    # marketplace.json + bundled-skill layout the overlay assumes. Hard-check
    # the marketplace file specifically (not just that the dir exists).
    marketplace = os.path.join(args.target_dir, ".agents", "plugins", "marketplace.json")
    if not os.path.isfile(marketplace):
        print(f"ERROR: target {args.target_dir} is missing "
              f".agents/plugins/marketplace.json — the codex skeleton was not laid "
              f"down. Run `cortextos add-agent {args.target_agent} --template "
              f"agent-codex --runtime codex-app-server --org <org>` FIRST, then "
              f"re-run convert.", file=sys.stderr)
        sys.exit(1)

    mode = "APPLY" if args.apply else "DRY-RUN"
    print(f"=== convert {manifest['source_agent']} -> {args.target_agent} [{mode}] ===",
          file=sys.stderr)
    actions = []

    # 1:1 overlays (instruction family, memory, goals, workspaces, catch-all)
    one_to_one = ["IDENTITY.md", "SOUL.md", "GUARDRAILS.md", "HEARTBEAT.md",
                  "USER.md", "SYSTEM.md", "MEMORY.md", "GOALS.md", "goals.json",
                  "TOOLS.md", "ONBOARDING.md", "AGENTS.md"]
    for fn in one_to_one:
        src = os.path.join(args.src_dir, fn)
        if os.path.isfile(src):
            copy_tree(src, os.path.join(args.target_dir, fn), args.apply, actions, f"overlay {fn}")
    # Identity/path-pinning state is NEVER copied: it would overwrite the
    # target's per-agent identity (.cortextos-env) or carry host/session-pinned
    # MCP state (.playwright-mcp). detect.py already keeps these out of
    # port_verbatim; this is a belt-and-braces guard.
    NEVER_COPY = {".cortextos-env", ".playwright-mcp"}
    # Credential-bearing dirs: copy but surface a REPORT line (review for stale/
    # agent-specific tokens), never let them slip by in a silent bulk copy.
    CREDENTIAL_DIRS = {"auth"}
    # port_verbatim catch-all (memory/, workspaces, skills/drafts, in-repo state/, etc.)
    for name in manifest["buckets"].get("port_verbatim", []):
        if name in NEVER_COPY:
            log(actions, f"SKIP {name}: identity/path-pinned — target keeps its "
                         f"add-agent-generated one")
            continue
        src = os.path.join(args.src_dir, name)
        if os.path.exists(src):
            copy_tree(src, os.path.join(args.target_dir, name), args.apply, actions,
                      f"port-verbatim {name}")
            surface_large_or_binary(name, src, actions)
            if name in CREDENTIAL_DIRS or name.endswith("auth"):
                log(actions, f"REPORT: '{name}/' carried — credential-bearing; "
                             f"REVIEW for stale/agent-specific tokens before enable")
    # .env (carry, preserve 0600)
    env_src = os.path.join(args.src_dir, ".env")
    if os.path.isfile(env_src):
        env_dst = os.path.join(args.target_dir, ".env")
        copy_tree(env_src, env_dst, args.apply, actions, ".env")
        if args.apply:
            os.chmod(env_dst, 0o600)

    source_agent = args.source_agent or manifest.get("source_agent")

    # INSTANCE-DISCOVERY: resolve WHO the principal + orchestrator are for THIS
    # deployment (never baked in). Each degrades to None -> the routing feature
    # safe-degrades rather than inventing an identity.
    principal_chat_id = resolve_principal_chat_id(args.src_dir, args.principal_chat_id)
    principal_name = resolve_principal_name(args.src_dir, args.principal_name)
    orchestrator, orch_src = discover_orchestrator(
        args.src_dir, source_agent, args.target_agent, args.orchestrator, actions)
    log(actions, f"instance-discovery: principal_chat_id="
                 f"{'set' if principal_chat_id else 'UNKNOWN'} "
                 f"principal_name={'set' if principal_name else 'UNKNOWN'} "
                 f"orchestrator={orchestrator or 'UNKNOWN'} (via {orch_src})")
    # GAP E — DOUBLE-UNKNOWN: no orchestrator AND no principal id/name. The routing
    # reroute is entirely off; surface ONE loud, un-buried needs-human line rather
    # than silently shipping crons that may send direct to a principal.
    if not orchestrator and not (principal_chat_id or principal_name):
        log(actions, "★ NEEDS-HUMAN (routing): no orchestrator AND no principal "
                     "discovered — the principal-facing-send reroute is DISABLED. "
                     "Review this agent's crons manually for any direct-to-principal "
                     "sends, or re-run with --orchestrator <name> (+ --principal-chat-id "
                     "/ --principal-name) to auto-route. (Not silently applied.)")
    elif not orchestrator:
        log(actions, "★ NEEDS-HUMAN (routing): a principal was discovered but NO "
                     "orchestrator — cron reroute SAFE-DEGRADED (no send-into-the-void). "
                     "Re-run with --orchestrator <name> to auto-route principal-facing "
                     "crons, or hand-route them.")

    transform_config(args.src_dir, args.target_dir, args.target_agent, manifest, args.apply, actions)
    # crons: UNION of config.json + live registry, deduped; paths translated;
    # principal-facing sends re-routed through the discovered orchestrator when known
    # (defects 4, 5, 6c) — safe-degraded otherwise.
    migrate_crons(args.src_dir, args.target_dir, source_agent, args.target_agent,
                  args.ctx_root, args.apply, actions,
                  principal_chat_id=principal_chat_id, orchestrator=orchestrator,
                  principal_name=principal_name)
    fold_claude_md(args.src_dir, args.target_dir, manifest, args.apply, actions)
    strip_tools_auth(args.target_dir, args.apply, actions)
    # guardrails-into-template: APPROVAL row always; ROUTING row only when the
    # orchestrator + principal are known (defect 6a/6b).
    ensure_guardrails(args.target_dir, args.apply, actions,
                      orchestrator=orchestrator, principal_name=principal_name)
    copy_custom_skills(args.src_dir, args.target_dir, args.target_agent, manifest, args.apply, actions)
    install_all_symlinks(args.target_dir, args.target_agent, args.apply, actions)
    # skill-depth-delta (defect 7): codex skills sit one dir deeper than claude, so
    # __file__-relative workspace anchors (../../../docs, parents[3]) land short;
    # a plugins/docs -> ../docs compat symlink restores workspace doc writes.
    create_skill_depth_compat_symlink(args.target_dir, args.apply, actions)
    # defect 15: any skill sqlite DB raw-copied above may be a TORN copy (copying a
    # live DB tears it). Re-copy malformed DBs from source via the backup API and
    # assert integrity. A non-empty unrepairable set HARD-BLOCKS the cutover below.
    _sqlite_repaired, _sqlite_ok_list, sqlite_unrepairable = ensure_sqlite_integrity(
        args.src_dir, args.target_dir, args.apply, actions)
    rewrite_all_refs(args.target_dir, args.apply, actions)
    delete_claude_artifacts(args.target_dir, args.apply, actions)
    mcp_written, mcp_needs_secret, mcp_collisions = emit_mcp_toml(
        manifest, args.target_agent, args.target_dir, args.apply, actions)
    # boot-state continuity: carry .onboarded + markers + handoffs/ so the target
    # does NOT cold-onboard (defect 1). Runs BEFORE force_fresh, which then excludes
    # ONLY the stale session transcript(s).
    carry_state_continuity(args.src_dir, args.ctx_root, source_agent,
                           args.target_agent, args.apply, actions)
    force_fresh(args.ctx_root, args.target_agent, args.apply, actions)
    disable_in_registry(args.ctx_root, args.target_agent, args.apply, actions)

    # --- Interactive-flow tail: bot-token strategy, then boot. Defaults are
    # fully non-destructive (bot-mode none + boot no) => identical to the
    # original behavior. Only explicit flags trigger source-disable / start.
    #
    # ORDERING CONTRACT (P0-1): when reuse, apply_bot_mode -> disable_source MUST
    # confirm the source poller is STOPPED before boot_codex runs. If the stop is
    # not confirmed, apply_bot_mode returns cutover=False and we DO NOT boot.
    # Codex is NEVER started before the source is confirmed stopped. ---
    # P2-1: `cortextos disable`/`enable` resolve state under --instance, while the
    # JSON writes here use the raw ctx_root path. They must agree: ctx_root should
    # end in the instance segment (.../.cortextos/<instance>). Warn on mismatch so
    # a disable that targets the wrong instance is caught, not silent.
    if os.path.basename(os.path.normpath(args.ctx_root)) != args.instance:
        log(actions, f"WARNING: ctx_root '{args.ctx_root}' does not end with the "
                     f"instance segment '/{args.instance}'. `cortextos disable/enable "
                     f"--instance {args.instance}` resolves a DIFFERENT path than the "
                     f"JSON writes here — they must agree or the daemon stop/start "
                     f"misses. Verify --instance matches the source's ctx_root.")

    # WRITE-SIDE HANDOFF GATE (defect 2): before any cutover, the LIVE source must
    # have produced a FRESH handoff (its normal handoff:create, NOT a synthesized
    # one). Block-poll for a handoff with mtime AFTER migration start. If none
    # appears in time, ABORT: do NOT disable the source, do NOT enable the target.
    # Only gates the cutover path (--bot-mode reuse); side-by-side / disabled paths
    # do not take over the source so they are not gated.
    fresh_handoff = None
    if args.bot_mode == "reuse":
        fresh_handoff = await_fresh_handoff(args.src_dir, source_agent,
                                            migration_start_ts, args.handoff_wait,
                                            args.handoff_poll, args.apply, actions)
        if args.apply and not fresh_handoff:
            # Hard abort: no fresh handoff -> never tear down the source.
            end_state = "cutover-aborted"
            log(actions, "ABORT: write-side handoff gate failed (no fresh source "
                         "handoff). Source NOT disabled, target NOT enabled.")
            print(f"\n=== {len(actions)} actions ({mode}) ===", file=sys.stderr)
            print(f"ABORTED: write-side handoff gate failed — source produced no fresh "
                  f"handoff. Source untouched, target NOT booted.", file=sys.stderr)
            json.dump({"mode": mode, "actions": actions, "end_state": end_state,
                       "bot_mode": args.bot_mode, "boot": False, "cutover": False},
                      sys.stdout, indent=2)
            sys.stdout.write("\n")
            return

    # DB-INTEGRITY HARD GATE (defect 15, default-deny): if any copied sqlite DB
    # could not be made sound (torn copy + source missing/also-malformed, or still
    # malformed after a backup-API re-copy), the migration produced a corrupt
    # artifact and MUST NOT proceed. Gate BEFORE apply_bot_mode so the source is
    # never torn down and the target never boots — same safe shape as the handoff
    # gate, but exits NON-ZERO so the failure cannot be mistaken for success.
    if args.apply and sqlite_unrepairable:
        end_state = "db-integrity-failed"
        log(actions, f"ABORT: DB-integrity gate failed — unrepairable sqlite copy(ies) "
                     f"{sqlite_unrepairable}. Source NOT disabled, target NOT enabled.")
        print(f"\n=== {len(actions)} actions ({mode}) ===", file=sys.stderr)
        print(f"ABORTED: DB-integrity gate failed — {len(sqlite_unrepairable)} sqlite "
              f"copy(ies) could not be made sound ({sqlite_unrepairable}). Source "
              f"untouched, target NOT booted. Fix the source DB or re-run.", file=sys.stderr)
        json.dump({"mode": mode, "actions": actions, "end_state": end_state,
                   "bot_mode": args.bot_mode, "boot": False, "cutover": False,
                   "unrepairable_dbs": sqlite_unrepairable},
                  sys.stdout, indent=2)
        sys.stdout.write("\n")
        sys.exit(2)

    # fix #16: a host-global MCP name collision means a migrated server cannot be
    # installed into the shared ~/.codex/config.toml = the agent boots without that
    # capability. Same gate class as DB-integrity: HARD-BLOCK the cutover, exit
    # non-zero, leave the source untouched. emit_mcp_toml already wrote NOTHING on
    # collision, so there is no partial state to unwind. A human renames the colliding
    # server (host-wide) and re-runs.
    if args.apply and mcp_collisions:
        end_state = "mcp-collision-failed"
        log(actions, f"ABORT: MCP gate failed — host-global name collision(s) "
                     f"{mcp_collisions} already in ~/.codex/config.toml. Source NOT "
                     f"disabled, target NOT enabled, no MCP tables written.")
        print(f"\n=== {len(actions)} actions ({mode}) ===", file=sys.stderr)
        print(f"ABORTED: MCP gate failed — {len(mcp_collisions)} server name(s) "
              f"{mcp_collisions} collide with existing host-global config.toml entries. "
              f"Rename the colliding server(s) host-wide and re-run. Source untouched, "
              f"target NOT booted.", file=sys.stderr)
        json.dump({"mode": mode, "actions": actions, "end_state": end_state,
                   "bot_mode": args.bot_mode, "boot": False, "cutover": False,
                   "mcp_collisions": mcp_collisions},
                  sys.stdout, indent=2)
        sys.stdout.write("\n")
        sys.exit(2)

    cutover = apply_bot_mode(args.bot_mode, args.new_bot_token, args.src_dir,
                             args.target_dir, args.ctx_root, source_agent,
                             args.instance, args.apply, actions)
    # READ-SIDE handoff enforcement (defect 3): on a CONFIRMED cutover, carry the
    # fresh source handoff into the target handoffs/ as the NEWEST file and write
    # the boot directive (.handoff-doc-path) so the daemon points the target at it
    # on first boot. Done before boot so the directive exists when the agent spawns.
    if cutover:
        carry_handoff_and_boot_directive(args.src_dir, args.target_dir, args.ctx_root,
                                         source_agent, args.target_agent,
                                         migration_start_ts, args.apply, actions)
        # defect 11a: the source AGENT is now confirmed stopped, but its CRONS are
        # still enabled:true in the registry+config (durable dual-scheduler hazard
        # once the target carries the same crons). Disable the recurring source
        # crons NOW, before the target boots, so there is no window where both fire.
        # One-shots are HELD enabled (re-armed on target by the operator first).
        disable_source_crons(args.src_dir, args.ctx_root, source_agent,
                             args.apply, actions)
        # Surface (don't auto-rewrite) any SIBLING agent still pointing at the
        # retired source's agents/<source> path — the operator must repoint these
        # to agents/<target> or verify.py --expect-cutover hard-fails on them.
        scan_cross_agent_strands(args.src_dir, source_agent, args.target_agent, actions)
    # do_boot only when reuse-cutover CONFIRMED the source stop, or new-bot --boot now.
    do_boot = cutover or (args.bot_mode != "reuse" and args.boot == "now")
    end_state = "disabled"
    if do_boot:
        rc = boot_codex(args.target_dir, args.target_agent, args.ctx_root, args.org,
                        args.instance, args.apply, actions)
        if rc == 0:
            end_state = "cutover-live" if cutover else "live"
        else:
            # P0-3: enable failed. For a cutover the source is ALREADY down, so a
            # failed boot is an OUTAGE — roll the source back and report failed,
            # NEVER "live".
            if cutover:
                rolled = rollback_source(args.src_dir, args.ctx_root, source_agent,
                                         args.org, args.instance, args.apply, actions)
                end_state = "cutover-failed"
                log(actions, f"end_state=cutover-failed (enable rc={rc}); source "
                             f"rollback {'succeeded' if rolled else 'FAILED — manual fix needed'}")
            else:
                end_state = "boot-failed"
                log(actions, f"end_state=boot-failed (enable rc={rc}); source was never "
                             f"touched, codex left enabled-in-config but not started")
    elif args.bot_mode == "reuse":
        # reuse requested but cutover did NOT confirm (no token / stop unconfirmed).
        # Nothing was booted and (per the hard stops) the source was not torn down.
        end_state = "cutover-aborted"

    print(f"\n=== {len(actions)} actions ({mode}) ===", file=sys.stderr)
    if end_state == "cutover-live":
        print(f"CUTOVER: source '{source_agent}' DISABLED, '{args.target_agent}' booting on "
              f"the original bot. Do the human steps + run verify.py --expect-cutover.",
              file=sys.stderr)
    elif end_state == "live":
        print(f"Target '{args.target_agent}' booting on its OWN bot; source still running. "
              f"Do the human steps + run verify.py --expect-boot.", file=sys.stderr)
    elif end_state == "cutover-failed":
        print(f"OUTAGE/FAILED: codex enable failed during a cutover. Attempted to roll the "
              f"source '{source_agent}' back up. Target is NOT live. Check the action log for "
              f"the rollback result and intervene if it failed.", file=sys.stderr)
    elif end_state == "boot-failed":
        print(f"FAILED: codex enable failed (new-bot boot). Source untouched; target NOT live. "
              f"Investigate the `cortextos enable` error in the action log.", file=sys.stderr)
    elif end_state == "cutover-aborted":
        print(f"ABORTED: reuse-cutover could not proceed (no source token, or the source stop "
              f"was not confirmed). Source NOT torn down, target NOT booted. See the FAIL lines "
              f"in the action log.", file=sys.stderr)
    else:
        print("Target left DISABLED. Do the human steps (fold review, MCP merge, secrets, "
              "leakage adjudication), run verify.py, then `cortextos enable`.", file=sys.stderr)
    json.dump({"mode": mode, "actions": actions, "end_state": end_state,
               "bot_mode": args.bot_mode, "boot": do_boot, "cutover": cutover},
              sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
