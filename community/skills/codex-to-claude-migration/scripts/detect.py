#!/usr/bin/env python3
"""
detect.py — DETECT stage of the Codex->Claude agent migration.

Walks a source codex-app-server cortextOS agent dir, classifies EVERY artifact into
a bucket, greps custom skills for Codex-only leakage, enumerates the host-global
codex MCP servers (secret values are NEVER read into the manifest — only key names
and a secret/non-secret classification), and emits a JSON manifest on stdout. The
catch-all `port_verbatim` bucket guarantees no file is silently dropped just because
there is no specific rule for it.

Read-only: never writes to or modifies the source agent or ~/.codex.

Usage:
  detect.py --src-dir orgs/<org>/agents/<agent> --ctx-root <CTX_ROOT> --agent <name>
            [--codex-config ~/.codex/config.toml] [--framework-root <repo>]
"""

import argparse
import json
import os
import re
import sys

try:
    import tomllib
except ImportError:  # pragma: no cover - python < 3.11
    tomllib = None

# Claude agent template stdlib (templates/agent/.claude/skills). Skills in this set
# ship for free via `cortextos add-agent --template agent`; only skills NOT here are
# "custom". Every codex-bundled skill is also in this set.
CLAUDE_BUNDLED_SKILLS = {
    "activity-channel",
    "agent-browser",
    "agent-management",
    "approvals",
    "auto-skill",
    "autoresearch",
    "bus-reference",
    "comms",
    "cortext-self-diagnosis",
    "cron-management",
    "env-management",
    "event-logging",
    "guardrails-reference",
    "heartbeat",
    "human-tasks",
    "knowledge-base",
    "m2c1-worker",
    "memory",
    "onboarding",
    "soul-philosophy",
    "system-diagnostics",
    "tasks",
    "tool-registration",
    "worker-agents",
}

CODEX_SKILLS_REL = os.path.join("plugins", "cortextos-agent-skills", "skills")
CODEX_REPO_SKILLS_REL = os.path.join(".agents", "skills")

# Leakage tokens. Split: rewritable (mechanical path refs) vs behavioral (Codex tool
# or runtime semantics a Claude session does not have -> needs-human).
LEAKAGE_REWRITABLE = ["plugins/cortextos-agent-skills/skills", ".agents/skills"]
LEAKAGE_BEHAVIORAL = [
    "apply_patch",
    "update_plan",
    "request_user_input",
    "codex exec",
    "~/.codex",
    "CODEX_HOME",
]

# Instruction-file wording that describes the agent AS a codex agent. Flagged for a
# human edit (prose is never auto-rewritten), not a blocker.
CODEX_IDENTITY_RE = re.compile(
    r"codex-app-server|codex agent|gpt-5[\w.-]*|gpt-6[\w.-]*|\bon codex\b",
    re.IGNORECASE,
)

ONE_TO_ONE_MD = {
    "IDENTITY.md",
    "SOUL.md",
    "GUARDRAILS.md",
    "HEARTBEAT.md",
    "USER.md",
    "SYSTEM.md",
    "MEMORY.md",
    "GOALS.md",
}
INSTRUCTION_FILES = (
    "AGENTS.md",
    "TOOLS.md",
    "IDENTITY.md",
    "SOUL.md",
    "SYSTEM.md",
    "HEARTBEAT.md",
    "ONBOARDING.md",
    "GUARDRAILS.md",
)

# Codex-only top-level entries: replaced by the claude skeleton, never carried.
CODEX_ONLY_ENTRIES = {".agents", "plugins", ".codex"}
# Identity/path-pinned dot-state: never carried (add-agent regenerates it).
IDENTITY_PINNING = {".cortextos-env", ".playwright-mcp"}
# Python virtualenvs embed absolute interpreter paths; a copy is broken. Recreate.
VENV_RE = re.compile(r"^\.?venv([-_.].*)?$")
# Above this, an item is NOT copied by default (disk + time); --include-large opts in.
HUGE_ITEM_BYTES = 100 * 1024 * 1024

# Secret classification for MCP config values. Used ONLY to label findings; every
# inline value becomes an env-var reference regardless (default-deny).
SECRET_KEY_RE = re.compile(
    r"TOKEN|SECRET|PASSW|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|AUTH|CREDENTIAL|COOKIE|"
    r"BEARER|HEADERS|SESSION",
    re.IGNORECASE,
)
SECRET_VALUE_RE = re.compile(
    r"^(Bearer\s|sk-|sk_|ntn_|secret_|ghp_|gho_|github_pat_|xox[abp]-|sbp_|glpat-|AKIA|eyJ)"
)
SECRET_FLAG_RE = re.compile(
    r"^--?(api[-_]?key|token|secret|password|auth|bearer)", re.I
)
SECRET_QUERY_RE = re.compile(
    r"([?&])([^=&#]*(?:key|token|secret|auth)[^=&#]*)=([^&#]+)", re.I
)


# Credential-shaped strings, for the carried-content warning (values never printed).
TOKEN_SHAPE_RE = re.compile(
    r"\b(?:sk-[A-Za-z0-9_-]{16,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|ntn_[A-Za-z0-9]{20,}|"
    r"secret_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|"
    r"xox[abpr]-[A-Za-z0-9-]{10,}|sbp_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|"
    r"AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|"
    r"\d{8,10}:[A-Za-z0-9_-]{30,})|Bearer\s+[A-Za-z0-9._-]{20,}")


def token_shape_hits(root, names=None):
    """{relpath: count} of credential-shaped strings in text files under root (or only
    under the given top-level names). Counts only; values are never returned."""
    hits = {}
    tops = [os.path.join(root, n) for n in names] if names is not None else [root]
    for top in tops:
        walk = [(os.path.dirname(top), [], [os.path.basename(top)])] \
            if os.path.isfile(top) else (os.walk(top) if os.path.isdir(top) else [])
        for dp, dn, fns in walk:
            dn[:] = [d for d in dn if d not in ("node_modules", ".git", "__pycache__")
                     and not VENV_RE.match(d)]
            for fn in fns:
                fp = os.path.join(dp, fn)
                try:
                    if os.path.islink(fp) or os.path.getsize(fp) > 5 * 1024 * 1024:
                        continue
                    txt = open(fp, errors="strict").read()
                except Exception:
                    continue
                n = len(TOKEN_SHAPE_RE.findall(txt))
                if n:
                    hits[os.path.relpath(fp, root)] = n
    return hits


def read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return None


def looks_secret(key, value):
    """True if a config key/value pair looks like a credential. Labeling only."""
    v = str(value)
    if SECRET_KEY_RE.search(str(key or "")):
        return True
    if SECRET_VALUE_RE.search(v.strip()):
        return True
    # long opaque token with no whitespace and no path separators
    if (
        len(v) >= 24
        and not re.search(r"[\s/\\]", v)
        and re.search(r"\d", v)
        and re.search(r"[A-Za-z]", v)
    ):
        return True
    return False


def _tree_size(path):
    if os.path.islink(path):
        return 0
    if os.path.isfile(path):
        try:
            return os.path.getsize(path)
        except OSError:
            return 0
    total = 0
    for dp, dn, fns in os.walk(path):
        dn[:] = [d for d in dn if d not in ("node_modules", ".git")]
        for fn in fns:
            fp = os.path.join(dp, fn)
            if os.path.islink(fp):
                continue
            try:
                total += os.path.getsize(fp)
            except OSError:
                pass
    return total


# A token appearing ONLY in a skill's own prose/docs or its data corpus is documented,
# not depended on. Same rule as claude-to-codex-migration/detect.py.
NARRATIVE_BASENAMES = {"SKILL.md", "README.md", "README", "CHANGELOG.md"}
NARRATIVE_DIRS = {"references", "docs", "reference", "examples"}
DATA_DIRS = {
    "data",
    "transcripts",
    "digests",
    "output",
    "outputs",
    "cache",
    "state",
    "logs",
    "results",
    "downloads",
    "raw",
    "snapshots",
    "archive",
}


def _is_non_invocation(relpath):
    parts = relpath.split(os.sep)
    if parts[-1] in NARRATIVE_BASENAMES:
        return True
    return any(p in NARRATIVE_DIRS or p in DATA_DIRS for p in parts[:-1])


def grep_tokens(root, tokens):
    """Return ({token: invocation_paths}, {token: prose_only_paths})."""
    raw = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in ("node_modules", ".git")]
        for fn in filenames:
            fp = os.path.join(dirpath, fn)
            try:
                if os.path.getsize(fp) > 2 * 1024 * 1024:
                    continue
                with open(fp, "r", errors="ignore") as f:
                    content = f.read()
            except Exception:
                continue
            rel = os.path.relpath(fp, root)
            bucket_name = "narrative" if _is_non_invocation(rel) else "invocation"
            for tok in tokens:
                if tok in content:
                    raw.setdefault(tok, {"narrative": [], "invocation": []})[
                        bucket_name
                    ].append(rel)
    invocation = {
        t: b["invocation"] + b["narrative"] for t, b in raw.items() if b["invocation"]
    }
    prose_only = {t: b["narrative"] for t, b in raw.items() if not b["invocation"]}
    return invocation, prose_only


def _skill_md(path):
    try:
        with open(os.path.join(path, "SKILL.md"), "rb") as f:
            return f.read()
    except Exception:
        return None


def mcp_var_name(server, key):
    """Env-var name a migrated inline value is referenced by. Namespaced by server so
    two servers that both use e.g. API_KEY cannot collide in secrets.env."""
    prefix = re.sub(r"[^A-Z0-9]", "_", server.upper())
    k = re.sub(r"[^A-Z0-9]", "_", str(key).upper())
    return k if k.startswith(prefix + "_") else f"{prefix}_{k}"


def plan_mcp_server(name, spec, claude_user_servers):
    """Map one codex [mcp_servers.<name>] table to a Claude .mcp.json entry WITHOUT
    carrying any inline value. Returns a plan dict; the `entry` it contains holds only
    ${VAR} references and non-sensitive structure (command, url without secret query
    values, args that do not look secret). Inline values are never put in the plan."""
    plan = {
        "name": name,
        "action": "migrate",
        "entry": None,
        "env_vars": [],
        "inline_secrets": [],
        "dropped_keys": [],
        "notes": [],
    }
    env = spec.get("env") or {}
    cmd = str(spec.get("command") or "")
    if (
        "CODEX_HOME" in env
        or "CODEX_CLI_PATH" in env
        or "Codex.app" in cmd
        or "/.codex/" in cmd
        or "Codex.app" in str(spec.get("cwd") or "")
    ):
        plan["action"] = "skip-codex-internal"
        plan["notes"].append(
            "Codex-desktop-internal server (CODEX_HOME / Codex.app); "
            "no Claude equivalent"
        )
        return plan
    if spec.get("enabled") is False:
        plan["action"] = "skip-disabled"
        plan["notes"].append("enabled = false in codex config")
        return plan
    if name in claude_user_servers:
        plan["action"] = "skip-claude-user-scope"
        plan["notes"].append(
            "already defined at Claude user scope (~/.claude.json); "
            "the claude agent inherits it"
        )
        return plan

    def ref(key, value, where, secret_hint=None):
        var = mcp_var_name(name, key)
        secret = looks_secret(key, value) if secret_hint is None else secret_hint
        plan["env_vars"].append(
            {"var": var, "source": where, "secret": secret, "kind": "inline"}
        )
        if secret:
            plan["inline_secrets"].append(where)
        return "${" + var + "}"

    entry = {}
    if spec.get("url"):
        url = str(spec["url"])
        entry["type"] = "http"

        def _q(m):
            return (
                m.group(1)
                + m.group(2)
                + "="
                + ref(
                    "URL_" + m.group(2),
                    m.group(3),
                    f"[mcp_servers.{name}].url ?{m.group(2)}=",
                    secret_hint=True,
                )
            )

        entry["url"] = SECRET_QUERY_RE.sub(_q, url)
        headers = {}
        btv = spec.get("bearer_token_env_var")
        if btv:
            headers["Authorization"] = "Bearer ${" + btv + "}"
            plan["env_vars"].append(
                {
                    "var": btv,
                    "source": f"[mcp_servers.{name}].bearer_token_env_var",
                    "secret": True,
                    "kind": "env-ref",
                }
            )
        for h, v in (spec.get("http_headers") or {}).items():
            headers[h] = ref("HEADER_" + h, v, f"[mcp_servers.{name}.http_headers].{h}")
        for h, var in (spec.get("env_http_headers") or {}).items():
            headers[h] = "${" + str(var) + "}"
            plan["env_vars"].append(
                {
                    "var": str(var),
                    "source": f"[mcp_servers.{name}.env_http_headers].{h}",
                    "secret": True,
                    "kind": "env-ref",
                }
            )
        if headers:
            entry["headers"] = headers
    else:
        entry["command"] = cmd
        args = []
        prev_flag = False
        for i, a in enumerate(spec.get("args") or []):
            a = str(a)
            if "=" in a and SECRET_FLAG_RE.match(a.split("=", 1)[0]):
                flag, val = a.split("=", 1)
                args.append(
                    flag
                    + "="
                    + ref(f"ARG{i}", val, f"[mcp_servers.{name}].args[{i}]", True)
                )
            elif prev_flag or SECRET_VALUE_RE.search(a) or looks_secret("", a):
                args.append(ref(f"ARG{i}", a, f"[mcp_servers.{name}].args[{i}]", True))
            else:
                args.append(a)
            prev_flag = bool(SECRET_FLAG_RE.match(a)) and "=" not in a
        if args:
            entry["args"] = args
        out_env = {}
        # default-deny: EVERY inline env value becomes a reference, secret or not.
        for k, v in env.items():
            out_env[k] = ref(k, v, f"[mcp_servers.{name}.env].{k}")
        for k in spec.get("env_vars") or []:
            out_env[str(k)] = "${" + str(k) + "}"
            plan["env_vars"].append(
                {
                    "var": str(k),
                    "source": f"[mcp_servers.{name}].env_vars",
                    "secret": False,
                    "kind": "env-ref",
                }
            )
        if out_env:
            entry["env"] = out_env
        if spec.get("cwd"):
            plan["dropped_keys"].append("cwd")
            plan["notes"].append(
                "cwd has no .mcp.json equivalent — wrap the command "
                "or make paths absolute"
            )
    for k in (
        "startup_timeout_sec",
        "startup_timeout_ms",
        "tool_timeout_sec",
        "required",
        "enabled_tools",
        "disabled_tools",
        "default_tools_approval_mode",
    ):
        if k in spec:
            plan["dropped_keys"].append(k)
    plan["entry"] = entry
    return plan


def load_codex_mcp(codex_config_path):
    """Parse ~/.codex/config.toml and return {name: spec}. The spec dicts DO hold the
    raw values (needed to classify); callers must only ever emit plan_mcp_server()
    output, never the spec."""
    if not tomllib or not os.path.isfile(codex_config_path):
        return None
    try:
        with open(codex_config_path, "rb") as f:
            data = tomllib.load(f)
    except Exception:
        return None
    return data.get("mcp_servers") or {}


def claude_user_mcp_names():
    d = read_json(os.path.expanduser("~/.claude.json")) or {}
    return set((d.get("mcpServers") or {}).keys())


def detect(src_dir, ctx_root, agent, codex_config=None, framework_root=None):
    m = {
        "source_agent": agent,
        "source_dir": src_dir,
        "ctx_root": ctx_root,
        "hard_stops": [],
        "config": {},
        "instructions": {},
        "skills": {
            "bundled_present": [],
            "bundled_customized": [],
            "custom": [],
            "claude_residue_only": [], "data_only": [],
        },
        "mcp": {
            "config_path": None,
            "servers": [],
            "inline_secrets": [],
            "env_vars": [],
        },
        "buckets": {
            "one_to_one": [],
            "transform": [],
            "dropped": [],
            "needs_human": [],
            "port_verbatim": [],
            "not_carried": [],
        },
        "notes": [],
    }
    if not os.path.isdir(src_dir):
        m["hard_stops"].append(f"source dir not found: {src_dir}")
        return m
    if framework_root is None:
        framework_root = os.path.abspath(os.path.join(src_dir, "..", "..", "..", ".."))

    # --- config.json ---
    cfg = read_json(os.path.join(src_dir, "config.json"))
    if cfg is None:
        m["hard_stops"].append("config.json missing or unparseable")
        cfg = {}
    else:
        runtime = cfg.get("runtime", "claude-code")
        m["config"] = {
            "runtime": runtime,
            "model": cfg.get("model"),
            "codex_only_keys": [
                k
                for k in (
                    "codex_context_cap",
                    "reasoning_effort",
                    "model_reasoning_effort",
                )
                if k in cfg
            ],
            "working_directory": cfg.get("working_directory", ""),
            "cron_count": len(cfg.get("crons") or []),
            "cron_names": sorted({c.get("name") for c in cfg.get("crons") or [] if c.get("name")}),
        }
        if runtime != "codex-app-server":
            m["hard_stops"].append(
                f"source runtime is '{runtime}', not codex-app-server — nothing to migrate "
                f"(this skill only converts codex agents)"
            )
        m["buckets"]["transform"].append(
            "config.json (runtime -> claude-code, model -> Claude id, codex-only keys dropped)"
        )

    # --- instruction family ---
    if os.path.isfile(os.path.join(src_dir, "AGENTS.md")):
        m["buckets"]["transform"].append(
            "AGENTS.md (kept as the shared source; skill paths rewritten) + CLAUDE.md = "
            "one-line @AGENTS.md import"
        )
    else:
        m["hard_stops"].append(
            "AGENTS.md missing — a codex agent's boot contract is "
            "AGENTS.md; nothing to import into CLAUDE.md"
        )
    if os.path.isfile(os.path.join(src_dir, "CLAUDE.md")):
        m["needs_human_claude_md"] = True
        m["buckets"]["needs_human"].append(
            "source has a stale CLAUDE.md (pre-codex residue) — NOT carried; the target "
            "CLAUDE.md is the @AGENTS.md import. Fold anything still wanted into AGENTS.md"
        )
    for fn in sorted(ONE_TO_ONE_MD | {"TOOLS.md", "ONBOARDING.md"}):
        if os.path.isfile(os.path.join(src_dir, fn)):
            m["buckets"]["one_to_one"].append(fn)
    codex_lines = {}
    for fn in INSTRUCTION_FILES:
        fp = os.path.join(src_dir, fn)
        if not os.path.isfile(fp):
            continue
        with open(fp, errors="ignore") as f:
            for i, line in enumerate(f, 1):
                if CODEX_IDENTITY_RE.search(line):
                    codex_lines.setdefault(fn, []).append(i)
    m["instructions"]["codex_wording_lines"] = codex_lines

    # Files that still name the SOURCE agent (e.g. `--agent <src>`, a script default
    # of CTX_AGENT_NAME:-<src>) or depend on codex-only artifacts. History is
    # excluded: it is a record. Flagged, never rewritten (code and prose).
    self_re = re.compile(r"(?<![\w.])" + re.escape(agent) + r"(?![\w-])")
    codex_art = re.compile(r"codex-tokens\.jsonl|codex-app-server-thread")
    refs = {}
    scan_roots = [os.path.join(src_dir, f) for f in INSTRUCTION_FILES + ("goals.json",)]
    for d in ("scripts", "tools", "bin"):
        scan_roots.append(os.path.join(src_dir, d))
    for root in scan_roots:
        walk = [(os.path.dirname(root), [], [os.path.basename(root)])] \
            if os.path.isfile(root) else (os.walk(root) if os.path.isdir(root) else [])
        for dp, dn, fns in walk:
            dn[:] = [x for x in dn if x not in ("node_modules", ".git", "__pycache__")]
            for fn in fns:
                fp = os.path.join(dp, fn)
                try:
                    if os.path.getsize(fp) > 2 * 1024 * 1024:
                        continue
                    txt = open(fp, errors="strict").read()
                except Exception:
                    continue
                why = [w for w, rx in (("names source agent", self_re),
                                       ("codex-only artifact", codex_art)) if rx.search(txt)]
                if why:
                    refs[os.path.relpath(fp, src_dir)] = why
    m["instructions"]["source_self_refs"] = refs
    if refs:
        m["buckets"]["needs_human"].append(
            f"{len(refs)} instruction/script file(s) still name '{agent}' or read "
            f"codex-only artifacts (see instructions.source_self_refs) — repoint to the "
            f"new agent or retire")
    if codex_lines:
        m["buckets"]["needs_human"].append(
            "instruction files describe the agent as a codex agent "
            f"({', '.join(f'{k}:{len(v)} line(s)' for k, v in codex_lines.items())}) — "
            "edit the wording for Claude (prose is not auto-rewritten)"
        )

    # --- skills ---
    claude_tpl = os.path.join(framework_root, "templates", "agent", ".claude", "skills")
    codex_tpl = os.path.join(
        framework_root, "templates", "agent-codex", CODEX_SKILLS_REL
    )
    seen = set()
    for rel in (CODEX_SKILLS_REL, CODEX_REPO_SKILLS_REL):
        root = os.path.join(src_dir, rel)
        if not os.path.isdir(root):
            continue
        for name in sorted(os.listdir(root)):
            sp = os.path.join(root, name)
            if not os.path.isdir(sp) or name in seen:
                continue
            seen.add(name)
            if not os.path.isfile(os.path.join(sp, "SKILL.md")):
                # a dir with no SKILL.md is not a loadable skill (Claude ignores it);
                # carry its files so nothing is lost, but never count it as a skill
                m["skills"]["data_only"].append({"name": name,
                                                 "path": os.path.relpath(sp, src_dir)})
                m["buckets"]["needs_human"].append(
                    f"skill dir '{name}' has no SKILL.md — carried as data into "
                    f".claude/skills/{name}, not a working skill; restore its SKILL.md")
                continue
            if name in CLAUDE_BUNDLED_SKILLS:
                m["skills"]["bundled_present"].append(name)
                tpl = _skill_md(os.path.join(codex_tpl, name))
                if tpl is not None and _skill_md(sp) not in (None, tpl):
                    m["skills"]["bundled_customized"].append(name)
                continue
            beh, prose = grep_tokens(sp, LEAKAGE_BEHAVIORAL)
            # rewritable path refs are rewritten wherever they sit, prose included
            rew_inv, rew_prose = grep_tokens(sp, LEAKAGE_REWRITABLE)
            rew = {**rew_prose, **rew_inv}
            entry = {
                "name": name,
                "path": os.path.relpath(sp, src_dir),
                "leakage_rewritable": rew,
                "leakage_behavioral": beh,
                "behavioral_prose_only": prose,
                "disposition": "needs_human" if beh else "transform",
            }
            m["skills"]["custom"].append(entry)
            if beh:
                m["buckets"]["needs_human"].append(
                    f"custom skill '{name}' has codex behavioral leakage {list(beh)} "
                    f"(invocation) — NOT auto-copied; rewrite for Claude (skill-creator)"
                )
            else:
                m["buckets"]["transform"].append(
                    f"custom skill '{name}' -> .claude/skills/{name}"
                )
    if m["skills"]["bundled_customized"]:
        m["buckets"]["needs_human"].append(
            "bundled skills whose source SKILL.md differs from the current codex template "
            "(local customization or an older template version): "
            f"{m['skills']['bundled_customized']} — the claude skeleton ships the stock "
            "version; port the customization by hand"
        )
    if os.path.isdir(claude_tpl):
        m["notes"].append(f"claude bundled skills come from {claude_tpl}")
    residue = os.path.join(src_dir, ".claude", "skills")
    if os.path.isdir(residue):
        only = sorted(
            n
            for n in os.listdir(residue)
            if os.path.isdir(os.path.join(residue, n))
            and n not in seen
            and n not in CLAUDE_BUNDLED_SKILLS
        )
        m["skills"]["claude_residue_only"] = only
        if only:
            m["buckets"]["needs_human"].append(
                f"source .claude/skills residue has skills absent from the live codex "
                f"skill set: {only} — NOT carried (stale pre-codex copies); copy by hand "
                f"if still wanted"
            )

    # --- hooks ---
    m["buckets"]["transform"].append(
        "hooks: codex has no per-agent hook file; the claude skeleton's "
        ".claude/settings.json restores the Claude hooks (see hooks-disposition.md)"
    )

    # --- MCP (host-global ~/.codex/config.toml) ---
    codex_config = codex_config or os.path.expanduser("~/.codex/config.toml")
    m["mcp"]["config_path"] = codex_config
    servers = load_codex_mcp(codex_config)
    if servers is None:
        m["notes"].append(
            f"no readable codex config at {codex_config} — no MCP servers"
        )
    else:
        user_scope = claude_user_mcp_names()
        for name, spec in servers.items():
            plan = plan_mcp_server(name, spec or {}, user_scope)
            m["mcp"]["servers"].append(plan)
            m["mcp"]["inline_secrets"].extend(plan["inline_secrets"])
            if plan["action"] == "migrate":
                m["mcp"]["env_vars"].extend(plan["env_vars"])
        migrating = [p["name"] for p in m["mcp"]["servers"] if p["action"] == "migrate"]
        if migrating:
            m["buckets"]["transform"].append(
                f"MCP: {len(migrating)} host codex server(s) -> target .mcp.json "
                f"(env-var references only): {migrating}"
            )
            m["buckets"]["needs_human"].append(
                "MCP: set the listed env vars in orgs/<org>/secrets.env (values are "
                "never copied)"
            )
        if m["mcp"]["inline_secrets"]:
            m["buckets"]["needs_human"].append(
                f"FINDING: ~/.codex/config.toml holds {len(m['mcp']['inline_secrets'])} "
                "inline secret value(s) in plain text (see mcp.inline_secrets) — not "
                "copied; consider moving them to env vars on the codex side too"
            )

    # --- .env ---
    if os.path.isfile(os.path.join(src_dir, ".env")):
        m["buckets"]["transform"].append(
            ".env (carried 0600; BOT_TOKEN stripped unless --bot-mode new — one bot "
            "cannot have two pollers)"
        )

    # --- crons: the live registry can hold crons config.json does not ---
    regp = os.path.join(ctx_root, ".cortextOS", "state", "agents", agent, "crons.json")
    reg = read_json(regp) or {}
    reg_names = {c.get("name") for c in (reg.get("crons") or []) if c.get("name")}
    cfg_names = set(m["config"].get("cron_names") or [])
    m["config"]["registry_only_crons"] = sorted(reg_names - cfg_names)
    m["config"]["cron_union_count"] = len(reg_names | cfg_names)

    # --- live state ---
    state = os.path.join(ctx_root, "state", agent)
    m["state"] = {
        "dir": state,
        "onboarded": os.path.isfile(os.path.join(state, ".onboarded")),
    }
    m["buckets"]["dropped"].append(
        "codex thread/session state (codex-app-server-thread.json etc.) — excluded; "
        "the claude agent starts a fresh session (.force-fresh)"
    )

    # --- catch-all ---
    known = {
        "config.json",
        "AGENTS.md",
        "CLAUDE.md",
        "TOOLS.md",
        "ONBOARDING.md",
        ".claude",
        ".mcp.json",
        ".env",
        "goals.json",
        ".git",
        "node_modules",
    } | ONE_TO_ONE_MD
    for name in sorted(os.listdir(src_dir)):
        if name in known:
            continue
        p = os.path.join(src_dir, name)
        if name in CODEX_ONLY_ENTRIES:
            m["buckets"]["dropped"].append(
                f"{name}/ (codex-only layout; replaced by the claude skeleton)"
            )
        elif name in IDENTITY_PINNING:
            m["buckets"]["dropped"].append(
                f"{name} (identity/path-pinned; target keeps its add-agent one)"
            )
        elif VENV_RE.match(name) and os.path.isdir(p):
            m["buckets"]["not_carried"].append(
                {
                    "name": name,
                    "reason": "python virtualenv (absolute paths) — recreate",
                }
            )
        else:
            size = _tree_size(p)
            if size >= HUGE_ITEM_BYTES:
                m["buckets"]["not_carried"].append(
                    {
                        "name": name,
                        "reason": f"{size / 1048576:.0f} MB — over the "
                        f"{HUGE_ITEM_BYTES // 1048576} MB default limit; pass "
                        f"--include-large to carry",
                        "bytes": size,
                    }
                )
            else:
                m["buckets"]["port_verbatim"].append(name)
    # sqlite sidecars travel with their database: a -wal/-shm/-journal copied without
    # the db it belongs to is useless and misleading
    skipped = {nc["name"] for nc in m["buckets"]["not_carried"]}
    for name in list(m["buckets"]["port_verbatim"]):
        for suf in ("-wal", "-shm", "-journal"):
            if name.endswith(suf) and name[: -len(suf)] in skipped:
                m["buckets"]["port_verbatim"].remove(name)
                m["buckets"]["not_carried"].append(
                    {"name": name, "reason": f"sqlite sidecar of not-carried "
                                             f"{name[: -len(suf)]}"})
    if os.path.isfile(os.path.join(src_dir, "goals.json")):
        m["buckets"]["one_to_one"].append("goals.json")
    # carried history is copied verbatim; warn (counts only) when it holds
    # credential-shaped strings so they can be redacted before the copy is used
    tok = token_shape_hits(src_dir, [n for n in m["buckets"]["port_verbatim"]])
    m["carried_token_shapes"] = tok
    if tok:
        m["buckets"]["needs_human"].append(
            f"WARNING: {sum(tok.values())} credential-shaped string(s) in {len(tok)} carried "
            f"file(s) (see carried_token_shapes; values not shown) — redact before use")
    if os.path.isdir(os.path.join(src_dir, ".claude")):
        m["buckets"]["dropped"].append(
            ".claude/ in source (pre-codex residue) — target gets the template's"
        )
    for nc in m["buckets"]["not_carried"]:
        m["buckets"]["needs_human"].append(
            f"not carried: {nc['name']} ({nc['reason']})"
        )
    return m


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src-dir", required=True)
    ap.add_argument("--ctx-root", required=True)
    ap.add_argument("--agent", required=True)
    ap.add_argument(
        "--codex-config",
        default=None,
        help="codex host config (default ~/.codex/config.toml)",
    )
    ap.add_argument(
        "--framework-root",
        default=None,
        help="cortextOS repo root (default: derived from --src-dir)",
    )
    args = ap.parse_args()
    manifest = detect(
        args.src_dir, args.ctx_root, args.agent, args.codex_config, args.framework_root
    )
    json.dump(manifest, sys.stdout, indent=2)
    sys.stdout.write("\n")
    sys.exit(2 if manifest["hard_stops"] else 0)


if __name__ == "__main__":
    main()
