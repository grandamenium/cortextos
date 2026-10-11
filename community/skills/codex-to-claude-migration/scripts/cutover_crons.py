#!/usr/bin/env python3
"""
cutover_crons.py — turn a migrated agent's crons ON at cutover, in BOTH places.

convert.py carries every cron as config.json `type: "disabled"` so the copy never
double-fires next to the still-live codex source. At cutover (source stopped) this
flips the chosen crons on in:
  1. the target config.json (`type: "disabled"` -> `"recurring"`), so a forced
     re-migration or a rebuild on another instance does not switch them off again;
  2. the live registry, via `cortextos bus update-cron <target> <name> --enabled true`.

Which crons: --names a,b,c, or --from-source to enable exactly those that are live in
the source (config.json not disabled AND not disabled in the source registry).
Dry-run by default; --apply writes.

Usage:
  cutover_crons.py --target-dir <tgt> --target-agent <name> --instance <id>
                   (--names a,b | --from-source --source-dir <src> --source-agent <name>
                    --source-ctx-root <CTX_ROOT>) [--apply]
"""

import argparse
import json
import os
import subprocess
import sys


def _load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return None


def source_live_names(source_dir, source_ctx_root, source_agent):
    cfg = _load(os.path.join(source_dir, "config.json")) or {}
    reg = (
        _load(
            os.path.join(
                source_ctx_root,
                ".cortextOS",
                "state",
                "agents",
                source_agent,
                "crons.json",
            )
        )
        or {}
    )
    off = {c.get("name") for c in reg.get("crons") or [] if c.get("enabled") is False}
    names = set()
    for c in cfg.get("crons") or []:
        if (
            c.get("name")
            and c.get("type") not in ("disabled", "once")
            and c.get("enabled") is not False
            and c["name"] not in off
        ):
            names.add(c["name"])
    for c in reg.get("crons") or []:
        if c.get("name") and c.get("enabled") is not False:
            names.add(c["name"])
    return names - off


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--target-dir", required=True)
    ap.add_argument("--target-agent", required=True)
    ap.add_argument("--instance", default="default")
    ap.add_argument("--names", default=None, help="comma-separated cron names")
    ap.add_argument("--from-source", action="store_true")
    ap.add_argument("--source-dir")
    ap.add_argument("--source-agent")
    ap.add_argument("--source-ctx-root")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--cortextos", default="cortextos", help=argparse.SUPPRESS)
    args = ap.parse_args()

    if bool(args.names) == bool(args.from_source):
        sys.exit("pass exactly one of --names or --from-source")
    if args.from_source:
        if not (args.source_dir and args.source_agent and args.source_ctx_root):
            sys.exit(
                "--from-source needs --source-dir, --source-agent, --source-ctx-root"
            )
        wanted = source_live_names(
            args.source_dir, args.source_ctx_root, args.source_agent
        )
    else:
        wanted = {n.strip() for n in args.names.split(",") if n.strip()}

    cfg_path = os.path.join(args.target_dir, "config.json")
    cfg = _load(cfg_path)
    if not isinstance(cfg, dict):
        sys.exit(f"cannot read {cfg_path}")
    have = {c.get("name") for c in cfg.get("crons") or []}
    unknown = sorted(wanted - have)
    if unknown:
        sys.exit(f"not crons of {args.target_agent}: {unknown}")

    changed = []
    for c in cfg.get("crons") or []:
        if c.get("name") in wanted and c.get("type") == "disabled":
            c["type"] = "recurring"
            changed.append(c["name"])
    mode = "APPLY" if args.apply else "DRY-RUN"
    print(
        f"=== cutover_crons {args.target_agent} [{mode}]: enabling {sorted(wanted)} ==="
    )
    if args.apply:
        with open(cfg_path, "w") as f:
            json.dump(cfg, f, indent=2)
            f.write("\n")
    print(f"config.json: type disabled -> recurring for {changed}")
    failed = []
    for name in sorted(wanted):
        cmd = [
            args.cortextos,
            "bus",
            "update-cron",
            args.target_agent,
            name,
            "--enabled",
            "true",
        ]
        if not args.apply:
            print(f"would run: {' '.join(cmd)}")
            continue
        env = dict(os.environ, CTX_INSTANCE_ID=args.instance)
        r = subprocess.run(cmd, capture_output=True, text=True, env=env)
        print(f"{' '.join(cmd)} -> exit {r.returncode}")
        if r.returncode != 0:
            failed.append(name)
    if failed:
        sys.exit(f"registry update failed for {failed} (agent booted? daemon running?)")


if __name__ == "__main__":
    main()
