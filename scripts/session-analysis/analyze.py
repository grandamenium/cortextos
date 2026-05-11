#!/usr/bin/env python3
"""Analyze Claude Code session JSONL logs for token-spend insights.

Reads ~/.claude/projects/<encoded-cwd>/*.jsonl. The encoded-cwd is the
absolute working directory with '/' replaced by '-'. Subcommands report
project totals, per-session breakdowns, tool-level aggregation, hourly
spend, USD estimates, and turns where /compact would have helped.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

# Anthropic Opus 4.x list pricing (USD per 1M tokens) — keep in sync with
# https://www.anthropic.com/pricing when re-running cost reports.
PRICING_USD_PER_MTOK = {
    "input": 15.0,
    "output": 75.0,
    "cache_write_5m": 18.75,
    "cache_write_1h": 30.0,
    "cache_read": 1.50,
}


def human(n: float) -> str:
    for unit in ("", "K", "M", "B"):
        if abs(n) < 1000:
            return f"{n:.1f}{unit}"
        n /= 1000
    return f"{n:.1f}T"


def project_dir_for_cwd(cwd: str) -> Path:
    encoded = cwd.replace("/", "-")
    return Path.home() / ".claude" / "projects" / encoded


def default_project_dir() -> Path:
    return project_dir_for_cwd(os.getcwd())


def iter_sessions(project_dir: Path):
    for path in sorted(glob.glob(str(project_dir / "*.jsonl"))):
        yield Path(path)


def iter_events(jsonl_path: Path):
    with jsonl_path.open() as f:
        for line in f:
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def usage_of(event: dict) -> dict:
    return event.get("message", {}).get("usage", {}) or {}


def extract_tokens(u: dict) -> tuple[int, int, int, int, int, int]:
    inp = u.get("input_tokens", 0)
    out = u.get("output_tokens", 0)
    cc = u.get("cache_creation_input_tokens", 0)
    cr = u.get("cache_read_input_tokens", 0)
    cache = u.get("cache_creation", {}) or {}
    cc_5m = cache.get("ephemeral_5m_input_tokens", 0)
    cc_1h = cache.get("ephemeral_1h_input_tokens", 0)
    return inp, out, cc, cr, cc_5m, cc_1h


def dollars(inp: int, out: int, cc_5m: int, cc_1h: int, cr: int) -> float:
    p = PRICING_USD_PER_MTOK
    return (
        inp * p["input"]
        + out * p["output"]
        + cc_5m * p["cache_write_5m"]
        + cc_1h * p["cache_write_1h"]
        + cr * p["cache_read"]
    ) / 1_000_000


# ---------------------------------------------------------------- summary ----

def cmd_summary(args):
    project_dir = Path(args.project_dir)
    if not project_dir.exists():
        print(f"No session dir at {project_dir}", file=sys.stderr)
        return 1
    sessions = []
    grand = Counter()
    for path in iter_sessions(project_dir):
        s = {
            "sid": path.stem,
            "size_bytes": path.stat().st_size,
            "in": 0, "out": 0, "cc": 0, "cr": 0, "cc_5m": 0, "cc_1h": 0,
            "main_in": 0, "main_out": 0, "sub_in": 0, "sub_out": 0,
            "models": Counter(),
            "agents": set(),
            "branches": set(),
            "first": None, "last": None,
            "turns": 0,
        }
        for ev in iter_events(path):
            t = ev.get("type")
            if t == "agent-name" and ev.get("agentName"):
                s["agents"].add(ev["agentName"])
                continue
            if t != "assistant":
                continue
            s["turns"] += 1
            inp, out, cc, cr, cc_5m, cc_1h = extract_tokens(usage_of(ev))
            s["in"] += inp; s["out"] += out; s["cc"] += cc; s["cr"] += cr
            s["cc_5m"] += cc_5m; s["cc_1h"] += cc_1h
            if ev.get("isSidechain"):
                s["sub_in"] += inp + cc + cr; s["sub_out"] += out
            else:
                s["main_in"] += inp + cc + cr; s["main_out"] += out
            s["models"][ev.get("message", {}).get("model", "?")] += 1
            br = ev.get("gitBranch")
            if br:
                s["branches"].add(br)
            ts = ev.get("timestamp")
            if ts:
                if not s["first"] or ts < s["first"]: s["first"] = ts
                if not s["last"]  or ts > s["last"]:  s["last"] = ts
        s["total"] = s["in"] + s["out"] + s["cc"] + s["cr"]
        s["usd"] = dollars(s["in"], s["out"], s["cc_5m"], s["cc_1h"], s["cr"])
        grand["in"] += s["in"]; grand["out"] += s["out"]
        grand["cc"] += s["cc"]; grand["cr"] += s["cr"]
        grand["cc_5m"] += s["cc_5m"]; grand["cc_1h"] += s["cc_1h"]
        grand["turns"] += s["turns"]
        sessions.append(s)

    sessions.sort(key=lambda s: -s["total"])
    total_tokens = sum(grand[k] for k in ("in", "out", "cc", "cr"))
    total_usd = dollars(grand["in"], grand["out"], grand["cc_5m"], grand["cc_1h"], grand["cr"])

    print(f"Project: {project_dir}")
    print(f"Sessions: {len(sessions)}  |  Turns: {grand['turns']}")
    print(f"Total tokens: {human(total_tokens)}  (~${total_usd:,.2f})")
    print(f"  cache_read:   {human(grand['cr'])}  (~${grand['cr'] * PRICING_USD_PER_MTOK['cache_read'] / 1e6:,.2f})")
    print(f"  cache_create: {human(grand['cc'])}  (5m={human(grand['cc_5m'])}  1h={human(grand['cc_1h'])})")
    print(f"  input:        {human(grand['in'])}")
    print(f"  output:       {human(grand['out'])}")
    print()
    hdr = f"{'session':36s} {'first':19s} {'turns':>5s} {'total':>8s} {'cr':>8s} {'cc':>7s} {'out':>7s} {'sub':>7s} {'usd':>8s}  branches | agents"
    print(hdr)
    print("-" * len(hdr))
    for s in sessions:
        agents = ",".join(sorted(s["agents"]))[:30] or "-"
        brs = ",".join(sorted(s["branches"]))[:50]
        print(
            f"{s['sid']:36s} {(s['first'] or '')[:19]:19s} {s['turns']:>5d} "
            f"{human(s['total']):>8s} {human(s['cr']):>8s} {human(s['cc']):>7s} "
            f"{human(s['out']):>7s} {human(s['sub_in'] + s['sub_out']):>7s} "
            f"${s['usd']:>7,.2f}  {brs} | {agents}"
        )
    return 0


# ---------------------------------------------------------------- session ----

def _load_session(path: Path):
    turns = []   # list of dicts per assistant turn
    agents = []
    for ev in iter_events(path):
        t = ev.get("type")
        if t == "agent-name" and ev.get("agentName"):
            agents.append(ev["agentName"])
        if t != "assistant":
            continue
        inp, out, cc, cr, cc_5m, cc_1h = extract_tokens(usage_of(ev))
        tools = []
        for c in ev.get("message", {}).get("content", []) or []:
            if c.get("type") == "tool_use":
                tools.append(c.get("name", "?"))
        turns.append({
            "ts": ev.get("timestamp", ""),
            "tools": tools,
            "in": inp, "out": out, "cc": cc, "cr": cr,
            "cc_5m": cc_5m, "cc_1h": cc_1h,
            "sidechain": bool(ev.get("isSidechain")),
            "model": ev.get("message", {}).get("model", "?"),
            "branch": ev.get("gitBranch"),
        })
    return turns, agents


def cmd_session(args):
    project_dir = Path(args.project_dir)
    matches = sorted(project_dir.glob(f"{args.session}*.jsonl"))
    if not matches:
        print(f"No session matching {args.session} in {project_dir}", file=sys.stderr)
        return 1
    if len(matches) > 1:
        print(f"Multiple matches; using {matches[0].name}", file=sys.stderr)
    path = matches[0]
    turns, agents = _load_session(path)
    if not turns:
        print(f"No assistant turns in {path.name}")
        return 0

    tool_n = Counter()
    tool_cr = defaultdict(int); tool_cc = defaultdict(int); tool_out = defaultdict(int)
    by_hour = defaultdict(lambda: {"cr": 0, "cc": 0, "out": 0, "n": 0})
    for t in turns:
        cr, cc, out = t["cr"], t["cc"], t["out"]
        for name in t["tools"]:
            tool_n[name] += 1
            tool_cr[name] += cr; tool_cc[name] += cc; tool_out[name] += out
        h = t["ts"][:13]
        by_hour[h]["cr"] += cr; by_hour[h]["cc"] += cc
        by_hour[h]["out"] += out; by_hour[h]["n"] += 1

    print(f"Session: {path.name}")
    print(f"Turns: {len(turns)}  |  Sidechain turns: {sum(1 for t in turns if t['sidechain'])}")
    print(f"Agents tagged: {sorted(set(agents)) or '-'}")
    print()
    print(f"=== Tool usage ({sum(tool_n.values())} calls) ===")
    print(f"{'tool':18s} {'n':>5s} {'cache_read':>10s} {'cache_create':>13s} {'output':>8s}")
    for name, n in tool_n.most_common():
        print(f"{name:18s} {n:>5d} {human(tool_cr[name]):>10s} {human(tool_cc[name]):>13s} {human(tool_out[name]):>8s}")

    print()
    print(f"=== Top {args.top} turns by (cache_read + cache_create) ===")
    biggest = sorted(turns, key=lambda t: -(t["cr"] + t["cc"]))[:args.top]
    for t in biggest:
        tools = ",".join(t["tools"]) or "(text)"
        print(f"  {t['ts'][:19]}  tools={tools[:40]:40s} cr={human(t['cr']):>8s} cc={human(t['cc']):>7s} out={human(t['out']):>6s}")

    print()
    print("=== Tokens by hour ===")
    for h in sorted(by_hour):
        x = by_hour[h]
        print(f"  {h}  turns={x['n']:>4d}  cr={human(x['cr']):>8s}  cc={human(x['cc']):>7s}  out={human(x['out']):>7s}")
    return 0


# ------------------------------------------------------------------ tools ----

def cmd_tools(args):
    project_dir = Path(args.project_dir)
    n = Counter()
    cr = defaultdict(int); cc = defaultdict(int); out = defaultdict(int); inp = defaultdict(int)
    for path in iter_sessions(project_dir):
        for ev in iter_events(path):
            if ev.get("type") != "assistant":
                continue
            i, o, c, r, _, _ = extract_tokens(usage_of(ev))
            for piece in ev.get("message", {}).get("content", []) or []:
                if piece.get("type") == "tool_use":
                    name = piece.get("name", "?")
                    n[name] += 1
                    cr[name] += r; cc[name] += c; out[name] += o; inp[name] += i
    print(f"Project: {project_dir}")
    print(f"{'tool':20s} {'calls':>6s} {'cache_read':>11s} {'cache_create':>13s} {'output':>8s} {'input':>8s}")
    for name, c in n.most_common():
        print(f"{name:20s} {c:>6d} {human(cr[name]):>11s} {human(cc[name]):>13s} {human(out[name]):>8s} {human(inp[name]):>8s}")
    return 0


# ------------------------------------------------------ compact-candidates ----

def cmd_compact(args):
    """List turns where /compact would have helped: large cache_read AND a likely-safe boundary
    (turn ends with a TaskUpdate to 'completed' OR has no tool_use, OR is the last turn before a long gap)."""
    project_dir = Path(args.project_dir)
    threshold = args.threshold * 1000  # K
    for path in iter_sessions(project_dir):
        turns, _ = _load_session(path)
        if not turns:
            continue
        printed_header = False
        for i, t in enumerate(turns):
            ctx = t["cr"] + t["cc"]
            if ctx < threshold:
                continue
            # boundary heuristic: text-only turn (no tool_use), or last turn in a 5-minute idle gap
            text_only = not t["tools"]
            gap = False
            if i + 1 < len(turns):
                try:
                    from datetime import datetime
                    a = datetime.fromisoformat(t["ts"].rstrip("Z"))
                    b = datetime.fromisoformat(turns[i + 1]["ts"].rstrip("Z"))
                    gap = (b - a).total_seconds() > 300
                except Exception:
                    pass
            if not (text_only or gap):
                continue
            if not printed_header:
                print(f"\nSession {path.stem}:")
                printed_header = True
            why = "text-boundary" if text_only else "5m-idle-gap"
            print(f"  {t['ts'][:19]}  cr={human(t['cr']):>7s} cc={human(t['cc']):>6s}  ({why})")
    return 0


# ----------------------------------------------------- recent-candidates ----

def _derive_agent_name(project_dir_name: str) -> str | None:
    """Best-effort agent name from encoded-cwd dir name.

    Encoded-cwd replaces '/' with '-'. For cortextos agents the cwd ends in
    '.../agents/<name>', so the dir name contains '-agents-<name>'.
    Returns None for projects that don't match the cortextos layout.
    """
    marker = "-agents-"
    idx = project_dir_name.rfind(marker)
    if idx == -1:
        return None
    return project_dir_name[idx + len(marker):]


def _parse_iso(ts: str) -> datetime | None:
    """Parse an ISO-8601 timestamp string into an aware UTC datetime, or None."""
    if not ts:
        return None
    s = ts.rstrip("Z")
    try:
        d = datetime.fromisoformat(s)
    except ValueError:
        return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d.astimezone(timezone.utc)


def cmd_recent_candidates(args):
    """Scan every ~/.claude/projects/<encoded-cwd>/, find the most-recently-modified
    JSONL per agent, and report the latest compact-eligible boundary turn that
    occurred within --since-minutes. Emits one entry per active session.

    Used by scripts/self-healing/compact-boundary-watcher.sh (cron, every 10 min).
    """
    base = Path.home() / ".claude" / "projects"
    if not base.exists():
        print("[]" if args.format == "json" else "(no ~/.claude/projects)", file=sys.stderr)
        return 0

    threshold = args.threshold * 1000
    since_seconds = args.since_minutes * 60
    now = datetime.now(timezone.utc)
    cutoff = now.timestamp() - since_seconds

    results = []
    for proj_dir in sorted(base.iterdir()):
        if not proj_dir.is_dir():
            continue
        jsonls = [p for p in proj_dir.glob("*.jsonl") if p.is_file()]
        if not jsonls:
            continue
        jsonls.sort(key=lambda p: p.stat().st_mtime, reverse=True)
        path = jsonls[0]
        mtime = path.stat().st_mtime
        if mtime < cutoff:
            continue  # stale session — no activity in the window

        turns, agents = _load_session(path)
        if not turns:
            continue

        candidate = None
        # Walk newest-first so the first match is the most recent eligible boundary
        for i in range(len(turns) - 1, -1, -1):
            t = turns[i]
            ts = _parse_iso(t["ts"])
            if ts is None:
                continue
            age = (now - ts).total_seconds()
            if age > since_seconds:
                # Sidechain turns can produce non-monotonic timestamps, so
                # keep walking rather than `break` — old turns get filtered
                # by the age check itself.
                continue
            ctx = t["cr"] + t["cc"]
            if ctx < threshold:
                continue
            text_only = not t["tools"]
            gap = False
            if i + 1 < len(turns):
                # turns[i+1] is the NEXT turn chronologically (higher index =
                # later append). gap>300 ⇒ the agent paused 5+ min AFTER turn i,
                # so turn i is the last safe boundary before the idle window.
                # Matches cmd_compact's existing semantics.
                nxt = _parse_iso(turns[i + 1]["ts"])
                if nxt is not None:
                    gap = (nxt - ts).total_seconds() > 300
            if not (text_only or gap):
                continue
            candidate = {
                "session_id": path.stem,
                "project_dir": proj_dir.name,
                "jsonl_path": str(path),
                "agent_name": (agents[-1] if agents else None) or _derive_agent_name(proj_dir.name),
                "branch": t.get("branch"),
                "cache_read": t["cr"],
                "cache_create": t["cc"],
                "context_total": ctx,
                "timestamp": t["ts"],
                "why": "text-boundary" if text_only else "5m-idle-gap",
                "model": t.get("model"),
                "jsonl_mtime_unix": mtime,
            }
            break

        if candidate:
            results.append(candidate)

    if args.format == "json":
        print(json.dumps(results, indent=2))
    else:
        if not results:
            print("(no recent compact candidates)")
        for c in results:
            agent = c["agent_name"] or "?"
            print(
                f"  {c['timestamp'][:19]}  agent={agent:20s} session={c['session_id'][:8]} "
                f"cr={human(c['cache_read']):>8s} cc={human(c['cache_create']):>7s}  ({c['why']})"
            )
    return 0


# ---------------------------------------------------------------- projects ----

def cmd_projects(args):
    base = Path.home() / ".claude" / "projects"
    rows = []
    for d in sorted(base.glob("*")):
        if not d.is_dir():
            continue
        tot = Counter()
        for path in d.glob("*.jsonl"):
            for ev in iter_events(path):
                if ev.get("type") != "assistant":
                    continue
                i, o, c, r, c5, c1 = extract_tokens(usage_of(ev))
                tot["in"] += i; tot["out"] += o; tot["cc"] += c; tot["cr"] += r
                tot["cc_5m"] += c5; tot["cc_1h"] += c1
        total = tot["in"] + tot["out"] + tot["cc"] + tot["cr"]
        usd = dollars(tot["in"], tot["out"], tot["cc_5m"], tot["cc_1h"], tot["cr"])
        rows.append((total, usd, d.name, tot))
    rows.sort(reverse=True)
    print(f"{'project':70s} {'total':>9s} {'cache_read':>11s} {'output':>8s} {'usd':>9s}")
    for total, usd, name, tot in rows[: args.limit]:
        if total == 0:
            continue
        print(f"{name[:70]:70s} {human(total):>9s} {human(tot['cr']):>11s} {human(tot['out']):>8s} ${usd:>8,.2f}")
    return 0


# -------------------------------------------------------------------- main ----

def build_parser():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--project-dir", default=str(default_project_dir()),
        help="Path to ~/.claude/projects/<encoded-cwd>/ (default: derived from cwd)",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("summary", help="Project totals + per-session table")
    sp.set_defaults(func=cmd_summary)

    sp = sub.add_parser("session", help="Drill into one session (prefix-match on session id)")
    sp.add_argument("session", help="Session id or unique prefix")
    sp.add_argument("--top", type=int, default=10, help="Show top-N largest turns (default 10)")
    sp.set_defaults(func=cmd_session)

    sp = sub.add_parser("tools", help="Tool usage aggregated across all sessions")
    sp.set_defaults(func=cmd_tools)

    sp = sub.add_parser("compact-candidates", help="Find turns where /compact would have helped")
    sp.add_argument("--threshold", type=int, default=200, help="Min cache_read+cache_create in K tokens (default 200)")
    sp.set_defaults(func=cmd_compact)

    sp = sub.add_parser(
        "recent-candidates",
        help="Scan every agent dir under ~/.claude/projects/ and report sessions with a recent compact-eligible boundary (for compact-boundary-watcher cron)",
    )
    sp.add_argument("--since-minutes", type=int, default=10,
                    help="Only consider sessions whose JSONL was modified in the last N minutes (default 10)")
    sp.add_argument("--threshold", type=int, default=120,
                    help="Min cache_read+cache_create in K tokens (default 120 — tuned for 200K-context models)")
    sp.add_argument("--format", choices=("text", "json"), default="text",
                    help="Output format (default text; json for cron consumption)")
    sp.set_defaults(func=cmd_recent_candidates)

    sp = sub.add_parser("projects", help="Compare token spend across ALL ~/.claude/projects/")
    sp.add_argument("--limit", type=int, default=20)
    sp.set_defaults(func=cmd_projects)
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
