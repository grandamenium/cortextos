#!/usr/bin/env python3
"""
verify.py — VERIFY stage (Tier 1 static) of the Codex->Claude migration.

Asserts the converted claude tree is well-formed AND that no MCP secret value from
~/.codex/config.toml leaked into the target. Read-only. Exit non-zero if any check
fails. Secret values are compared in memory and NEVER printed — a leak is reported
by its config location only.

Usage:
  verify.py --target-dir <tgt> --target-agent <name> --ctx-root <CTX_ROOT>
            [--source-dir <src> --source-agent <name>] [--expect-boot]
            [--codex-config ~/.codex/config.toml] [--bot-mode none|new]
"""

import argparse
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import detect  # noqa: E402

SCAN_EXT = (
    ".md",
    ".json",
    ".txt",
    ".sh",
    ".py",
    ".js",
    ".ts",
    ".toml",
    ".yaml",
    ".yml",
)
MIN_SECRET_LEN = 8


def _load_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return None


def codex_inline_values(codex_config):
    """{location: value} for every inline value the migration must never copy (all MCP
    env values, http_headers values, secret-looking args and url query values). Kept
    in memory only."""
    servers = detect.load_codex_mcp(codex_config) or {}
    out = {}
    for name, spec in servers.items():
        spec = spec or {}
        for k, v in (spec.get("env") or {}).items():
            out[f"[mcp_servers.{name}.env].{k}"] = str(v)
        for k, v in (spec.get("http_headers") or {}).items():
            out[f"[mcp_servers.{name}.http_headers].{k}"] = str(v)
        for i, a in enumerate(spec.get("args") or []):
            a = str(a)
            val = a.split("=", 1)[1] if "=" in a else a
            if detect.SECRET_VALUE_RE.search(val) or detect.looks_secret("", val):
                out[f"[mcp_servers.{name}].args[{i}]"] = val
        for m in detect.SECRET_QUERY_RE.finditer(str(spec.get("url") or "")):
            out[f"[mcp_servers.{name}].url ?{m.group(2)}="] = m.group(3)
    # short / non-sensitive literals (e.g. "1", "true", a common path) would match
    # everywhere and prove nothing — only check values long enough to be specific.
    # A composite value (e.g. a JSON headers blob) is also checked token by token, so
    # the embedded credential is caught even if the wrapper was reformatted.
    res = {}
    for loc, v in out.items():
        if len(v) < MIN_SECRET_LEN or not detect.looks_secret(loc.rsplit(".", 1)[-1], v):
            continue
        cands = {v} | {t for t in re.findall(r"[A-Za-z0-9_.+/=-]{16,}", v)
                       if detect.looks_secret("", t)}
        res[loc] = sorted(cands)
    return res


def find_leaks(target_dir, values):
    """Return sorted config locations whose value appears in any target text file.
    The agent's own .env is excluded: it is the agent secrets file carried 1:1, not
    a destination of the MCP mapping."""
    if not values:
        return []
    hits = set()
    for dp, dn, fns in os.walk(target_dir):
        dn[:] = [
            d
            for d in dn
            if d not in ("node_modules", ".git") and not detect.VENV_RE.match(d)
        ]
        for fn in fns:
            if fn == ".env" or not (fn.endswith(SCAN_EXT) or fn.startswith(".mcp")):
                continue
            fp = os.path.join(dp, fn)
            try:
                if os.path.islink(fp) or os.path.getsize(fp) > 5 * 1024 * 1024:
                    continue
                with open(fp, errors="ignore") as f:
                    txt = f.read()
            except Exception:
                continue
            for loc, cands in values.items():
                if any(c in txt for c in cands):
                    hits.add(loc)
    return sorted(hits)


def mcp_refs_only(mcp):
    """Every env/header value in .mcp.json must be a ${VAR} reference (optionally with
    a 'Bearer ' prefix). Returns offending 'server.field.key' paths."""
    bad = []
    ref = re.compile(r"^(Bearer\s+)?\$\{[A-Za-z_][A-Za-z0-9_]*\}$")
    for name, s in ((mcp or {}).get("mcpServers") or {}).items():
        for field in ("env", "headers"):
            for k, v in (s.get(field) or {}).items():
                if not ref.match(str(v)):
                    bad.append(f"{name}.{field}.{k}")
    return bad


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--target-dir", required=True)
    ap.add_argument("--target-agent", required=True)
    ap.add_argument("--ctx-root", required=True)
    ap.add_argument("--source-dir", default=None)
    ap.add_argument("--source-ctx-root", default=None,
                    help="source instance CTX_ROOT if different from --ctx-root")
    ap.add_argument("--source-agent", default=None)
    ap.add_argument(
        "--expect-boot",
        action="store_true",
        help="assert the target is ENABLED (config.json + registry)",
    )
    ap.add_argument(
        "--codex-config", default=os.path.expanduser("~/.codex/config.toml")
    )
    ap.add_argument("--bot-mode", choices=["none", "new"], default="none")
    args = ap.parse_args()
    td = args.target_dir
    src_ctx = args.source_ctx_root or args.ctx_root
    checks = []

    def chk(ok, label):
        checks.append((bool(ok), label))

    cfg = _load_json(os.path.join(td, "config.json")) or {}
    chk(cfg.get("runtime") == "claude-code", "config.runtime == claude-code")
    chk(
        str(cfg.get("model") or "").startswith("claude-") or "model" not in cfg,
        f"config.model is a Claude id or unset (got {cfg.get('model')!r})",
    )
    for k in ("codex_context_cap", "reasoning_effort", "model_reasoning_effort"):
        chk(k not in cfg, f"codex-only key '{k}' dropped")

    reg = _load_json(os.path.join(args.ctx_root, "config", "enabled-agents.json"))
    entry = reg.get(args.target_agent) if isinstance(reg, dict) else None
    chk(isinstance(entry, dict), f"registry entry present for '{args.target_agent}'")
    want = bool(args.expect_boot)
    chk(cfg.get("enabled") is want, f"config.json enabled == {want}")
    chk(
        isinstance(entry, dict) and entry.get("enabled") is want,
        f"registry enabled == {want} (the daemon reads the registry)",
    )

    # instructions: shared-instructions pattern
    cm = os.path.join(td, "CLAUDE.md")
    cm_body = open(cm, errors="ignore").read().strip() if os.path.isfile(cm) else ""
    chk(cm_body == "@AGENTS.md", "CLAUDE.md is the one-line @AGENTS.md import")
    chk(
        os.path.isfile(os.path.join(td, "AGENTS.md")),
        "AGENTS.md present (shared source)",
    )

    settings = _load_json(os.path.join(td, ".claude", "settings.json"))
    chk(
        isinstance(settings, dict) and settings.get("hooks"),
        ".claude/settings.json present with hooks (claude skeleton)",
    )
    for name in sorted(detect.CODEX_ONLY_ENTRIES):
        chk(
            not os.path.lexists(os.path.join(td, name)),
            f"no codex-only '{name}' in target",
        )

    leftover = []
    for dp, dn, fns in os.walk(td):
        dn[:] = [
            d
            for d in dn
            if d not in ("node_modules", ".git") and not detect.VENV_RE.match(d)
        ]
        for fn in fns:
            if fn.endswith(SCAN_EXT):
                fp = os.path.join(dp, fn)
                try:
                    if os.path.getsize(fp) > 2 * 1024 * 1024:
                        continue
                    if (
                        "plugins/cortextos-agent-skills/skills"
                        in open(fp, errors="ignore").read()
                    ):
                        leftover.append(os.path.relpath(fp, td))
                except Exception:
                    pass
    chk(not leftover, f"no codex skill-path refs left ({leftover[:5]})")

    # skills: every source skill present unless it was a needs-human leak
    skills_root = os.path.join(td, ".claude", "skills")
    if args.source_dir:
        m = detect.detect(
            args.source_dir,
            src_ctx,
            args.source_agent or "",
            codex_config=args.codex_config,
        )
        missing = []
        for name in m["skills"]["bundled_present"]:
            if not os.path.isfile(os.path.join(skills_root, name, "SKILL.md")):
                missing.append(name)
        for s in m["skills"]["custom"]:
            if s["disposition"] != "needs_human" and not os.path.isfile(
                os.path.join(skills_root, s["name"], "SKILL.md")
            ):
                missing.append(s["name"])
        chk(
            not missing,
            f"every portable source skill present in .claude/skills ({missing})",
        )

        # crons: union preserved
        want_crons = {
            c.get("name")
            for c in (
                _load_json(os.path.join(args.source_dir, "config.json")) or {}
            ).get("crons")
            or []
            if c.get("name")
        }
        regp = os.path.join(
            src_ctx,
            ".cortextOS",
            "state",
            "agents",
            args.source_agent or "",
            "crons.json",
        )
        want_crons |= {
            c.get("name")
            for c in ((_load_json(regp) or {}).get("crons") or [])
            if c.get("name")
        }
        got = {c.get("name") for c in cfg.get("crons") or []}
        chk(
            want_crons <= got,
            f"all source-union crons carried (missing {sorted(want_crons - got)})",
        )
        bad_keys = sorted({k for c in cfg.get("crons") or [] for k in c}
                          - {"name", "type", "interval", "cron", "fire_at", "prompt"})
        chk(not bad_keys, f"target crons use only the daemon cron schema (extra keys "
                          f"{bad_keys} would make the daemon REFUSE them)")
        src_cfg = _load_json(os.path.join(args.source_dir, "config.json")) or {}
        chk(
            src_cfg.get("runtime") == "codex-app-server",
            "source config untouched (still codex-app-server)",
        )

    # MCP: references only + no inline value anywhere in the target
    mcp = _load_json(os.path.join(td, ".mcp.json"))
    if mcp is not None:
        bad = mcp_refs_only(mcp)
        chk(not bad, f".mcp.json env/header values are all ${{VAR}} refs ({bad})")
        if mcp.get("mcpServers") or {}:
            chk(
                isinstance(settings, dict)
                and settings.get("enableAllProjectMcpServers"),
                "enableAllProjectMcpServers set (unattended session will not stall)",
            )
    leaks = find_leaks(td, codex_inline_values(args.codex_config))
    chk(
        not leaks,
        f"no ~/.codex/config.toml inline secret value appears in any target "
        f"file (leaked locations: {leaks})",
    )

    # .env
    envp = os.path.join(td, ".env")
    if os.path.isfile(envp):
        chk(oct(os.stat(envp).st_mode & 0o777) == "0o600", ".env is 0600")
        has_tok = any(
            line.startswith("BOT_TOKEN=") and line.strip() != "BOT_TOKEN="
            for line in open(envp, errors="ignore")
        )
        if args.bot_mode == "none":
            chk(not has_tok, ".env has no BOT_TOKEN (source still owns the bot)")
            chk(cfg.get("telegram_polling") is False,
                "telegram_polling false (bus-only copy; enable accepts it without a bot)")

    # state
    sd = os.path.join(args.ctx_root, "state", args.target_agent)
    chk(
        not os.path.isfile(os.path.join(sd, "codex-app-server-thread.json")),
        "no codex thread file carried into target state",
    )
    if args.source_agent and os.path.isfile(
        os.path.join(src_ctx, "state", args.source_agent, ".onboarded")
    ):
        chk(
            os.path.isfile(os.path.join(sd, ".onboarded")),
            "target .onboarded present (no cold onboard)",
        )

    passed = sum(1 for ok, _ in checks if ok)
    print(f"=== Tier 1 static verify: {passed}/{len(checks)} passed ===")
    for ok, label in checks:
        print(f"  [{'PASS' if ok else 'FAIL'}] {label}")
    print(
        "\nTier 2 (live boot probe) is run by the operator with explicit go: enable the "
        "target, wait for the Claude status bar (bootstrap), send it a bus probe, "
        "confirm a reply + last_idle.flag, then disable it."
    )
    sys.exit(0 if passed == len(checks) else 1)


if __name__ == "__main__":
    main()
