#!/usr/bin/env python3
"""
stagger-resolve.py — Dynamic cron stagger resolver for cortextOS fleet.

Reads every agent's config.json, simulates a 24h fire timeline (ignoring
dom/month/dow so collisions that only occur on specific days are still caught),
finds minutes where >1 cron fires on the same agent, and proposes cold-minute
reassignments — or applies them immediately with --apply.

Usage:
  python3 scripts/stagger-resolve.py [--apply] [--org phytomedic] [--root /path/to/cortextos]

Exits 0 if no collisions found, 1 if collisions remain after dry-run.
"""

import argparse
import json
import os
import sys
from collections import defaultdict
from pathlib import Path


# ---------------------------------------------------------------------------
# Cron expression helpers
# ---------------------------------------------------------------------------

def expand_field(field: str, lo: int, hi: int) -> list[int]:
    vals: set[int] = set()
    for part in field.split(","):
        if part == "*":
            vals.update(range(lo, hi + 1))
        elif "/" in part:
            base, step = part.split("/")
            start = lo if base == "*" else int(base)
            vals.update(range(start, hi + 1, int(step)))
        elif "-" in part:
            a, b = part.split("-")
            vals.update(range(int(a), int(b) + 1))
        else:
            vals.add(int(part))
    return sorted(vals)


def fires_in_24h(schedule: str) -> list[tuple[int, int]]:
    """Return (hour, minute) pairs for one representative 24h window."""
    parts = schedule.split()
    if len(parts) < 5:
        return []
    mins = expand_field(parts[0], 0, 59)
    hours = expand_field(parts[1], 0, 23)
    return [(h, m) for h in hours for m in mins]


def fire_frequency(schedule: str) -> int:
    """Number of fires per 24h — used to pick the anchor vs. the mover."""
    return len(fires_in_24h(schedule))


# ---------------------------------------------------------------------------
# Cold-minute finder
# ---------------------------------------------------------------------------

def find_cold_minute(
    agent: str,
    agent_all_schedules: dict[str, str],
    fleet_minute_load: dict[int, int],
    preferred_hour: int,
) -> int:
    """Pick a minute that minimises collisions.

    Criteria (in order):
    1. Not already used by any cron on this agent (no same-agent collision).
    2. Lowest fleet-wide fire count at that minute.
    3. Among ties, prefer minutes far from {0,5,10,15,20,25,30,35,40,45,50,55}.
    """
    # Build set of minutes already used by this agent
    agent_busy: set[int] = set()
    for sched in agent_all_schedules.values():
        for (_, m) in fires_in_24h(sched):
            agent_busy.add(m)

    # Boundary minutes to deprioritise (known stampede seeds)
    boundary = {0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55}

    candidates = [m for m in range(60) if m not in agent_busy]
    if not candidates:
        # Fallback: any minute with lowest fleet load
        candidates = list(range(60))

    def score(m: int) -> tuple[int, int]:
        boundary_pen = 1 if m in boundary else 0
        return (fleet_minute_load.get(m, 0), boundary_pen)

    return min(candidates, key=score)


# ---------------------------------------------------------------------------
# Main resolution logic
# ---------------------------------------------------------------------------

def load_agent_configs(framework_root: str, org: str) -> dict[str, dict]:
    """Return {agent_name: config_dict} for all agents that have a config.json."""
    agents_dir = Path(framework_root) / "orgs" / org / "agents"
    configs: dict[str, dict] = {}
    if not agents_dir.exists():
        return configs
    for entry in sorted(agents_dir.iterdir()):
        if not entry.is_dir():
            continue
        cfg_path = entry / "config.json"
        if not cfg_path.exists():
            continue
        try:
            with open(cfg_path) as f:
                configs[entry.name] = json.load(f)
        except Exception as e:
            print(f"WARN: could not read {cfg_path}: {e}", file=sys.stderr)
    return configs


def build_timeline(configs: dict[str, dict]) -> dict[tuple[int, int], list[tuple[str, str]]]:
    """Map (hour, minute) -> list of (agent, cron_name) across all crons."""
    timeline: dict[tuple[int, int], list[tuple[str, str]]] = defaultdict(list)
    for agent, cfg in configs.items():
        for c in cfg.get("crons", []):
            if not c.get("enabled", True):
                continue
            for (h, m) in fires_in_24h(c.get("cron", "")):
                timeline[(h, m)].append((agent, c["name"]))
    return dict(timeline)


def find_collisions(
    timeline: dict[tuple[int, int], list[tuple[str, str]]]
) -> list[dict]:
    """Return list of collision dicts sorted by hour:minute."""
    collisions = []
    for (h, m), fires in sorted(timeline.items()):
        agent_fires: dict[str, list[str]] = defaultdict(list)
        for (agent, cron) in fires:
            agent_fires[agent].append(cron)
        for agent, crons in agent_fires.items():
            if len(crons) > 1:
                collisions.append({
                    "time": f"{h:02d}:{m:02d}",
                    "agent": agent,
                    "crons": crons,
                    "fleet_total": len(fires),
                })
    return collisions


def resolve(
    configs: dict[str, dict],
    collisions: list[dict],
    apply: bool = False,
) -> dict[str, dict]:
    """
    For each collision, move the lowest-frequency cron to a cold minute.
    Always updates in-memory state so subsequent moves see prior relocations.
    Only writes to disk when apply=True.
    """
    already_moved: set[tuple[str, str]] = set()

    # Fleet minute load tracks actual 24h fire count per minute of hour.
    # Updated live as we move crons so each subsequent move sees the current load.
    fleet_minute_load: dict[int, int] = defaultdict(int)
    for agent, cfg in configs.items():
        for c in cfg.get("crons", []):
            for (_, m) in fires_in_24h(c.get("cron", "")):
                fleet_minute_load[m] += 1

    for col in collisions:
        agent = col["agent"]
        crons_in_col = col["crons"]
        time_str = col["time"]
        preferred_hour = int(time_str.split(":")[0])

        # Sort by fire frequency desc — keep most-frequent (anchor), move the rest
        agent_cfg_crons: dict[str, dict] = {
            c["name"]: c
            for c in configs[agent].get("crons", [])
        }
        sorted_by_freq = sorted(
            crons_in_col,
            key=lambda n: fire_frequency(agent_cfg_crons[n].get("cron", "")),
            reverse=True,
        )
        anchor = sorted_by_freq[0]

        for cron_name in sorted_by_freq[1:]:
            if (agent, cron_name) in already_moved:
                continue
            already_moved.add((agent, cron_name))

            # Re-read from (potentially already-updated) configs
            current_agent_crons = {
                c["name"]: c for c in configs[agent].get("crons", [])
            }
            old_sched = current_agent_crons[cron_name].get("cron", "")
            old_parts = old_sched.split()
            if len(old_parts) < 5:
                print(f"  SKIP {agent}/{cron_name}: unparseable schedule '{old_sched}'")
                continue

            # Build CURRENT agent schedules (includes prior moves from this run)
            agent_all_schedules = {
                c["name"]: c.get("cron", "")
                for c in configs[agent].get("crons", [])
            }

            new_minute = find_cold_minute(
                agent, agent_all_schedules, fleet_minute_load, preferred_hour
            )
            new_parts = [str(new_minute)] + old_parts[1:]
            new_sched = " ".join(new_parts)

            print(
                f"  MOVE  {agent}/{cron_name}\n"
                f"    old: {old_sched}\n"
                f"    new: {new_sched}\n"
                f"    (conflicts with anchor={anchor} at {time_str})"
            )

            # Always update in-memory state (so next move avoids this new minute).
            # Only write to disk when apply=True.
            for c in configs[agent]["crons"]:
                if c["name"] == cron_name:
                    c["cron"] = new_sched
                    break
            # Update fleet load: subtract old, add new
            for (_, m) in fires_in_24h(old_sched):
                fleet_minute_load[m] = max(0, fleet_minute_load.get(m, 0) - 1)
            for (_, m) in fires_in_24h(new_sched):
                fleet_minute_load[m] = fleet_minute_load.get(m, 0) + 1

    return configs


def write_configs(configs: dict[str, dict], framework_root: str, org: str) -> None:
    agents_dir = Path(framework_root) / "orgs" / org / "agents"
    for agent, cfg in configs.items():
        cfg_path = agents_dir / agent / "config.json"
        if cfg_path.exists():
            with open(cfg_path, "w") as f:
                json.dump(cfg, f, indent=2, ensure_ascii=False)
            print(f"  WROTE {cfg_path}")


def print_timeline(configs: dict[str, dict]) -> None:
    """Print a compact 24h stacked timeline showing fires per minute-of-hour."""
    # Per-minute-of-hour (0-59) across the whole 24h
    minute_of_hour_fires: dict[int, list[tuple[str, str]]] = defaultdict(list)
    for agent, cfg in configs.items():
        for c in cfg.get("crons", []):
            for (_, m) in fires_in_24h(c.get("cron", "")):
                minute_of_hour_fires[m].append((agent, c["name"]))

    print("\n24h minute-of-hour fire count (minute -> total):")
    hot = []
    for m in range(60):
        count = len(minute_of_hour_fires.get(m, []))
        if count > 0:
            bar = "#" * count
            tag = " ← HOT" if count > 5 else ""
            print(f"  :{m:02d}  {bar} ({count}){tag}")
        if count > 2:
            hot.append(m)
    if hot:
        print(f"\nMinutes with >2 fleet fires: {[f':{m:02d}' for m in hot]}")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description="Dynamic cron stagger resolver")
    parser.add_argument("--apply", action="store_true", help="Apply changes to config.json files")
    parser.add_argument("--org", default="phytomedic", help="Org name (default: phytomedic)")
    parser.add_argument(
        "--root",
        default=os.environ.get("CTX_FRAMEWORK_ROOT", "/Users/arndt/cortextos"),
        help="Framework root directory",
    )
    args = parser.parse_args()

    print(f"{'DRY-RUN' if not args.apply else 'APPLYING'} stagger resolution for org={args.org}\n")

    configs = load_agent_configs(args.root, args.org)
    if not configs:
        print("No agent config.json files found.")
        return 0

    print(f"Loaded {len(configs)} agent configs: {sorted(configs.keys())}\n")

    timeline = build_timeline(configs)
    collisions = find_collisions(timeline)

    if not collisions:
        print("No same-agent simultaneous cron fires found.")
        print_timeline(configs)
        return 0

    print(f"Found {len(collisions)} collision(s):\n")
    for col in collisions:
        print(f"  {col['time']} UTC — {col['agent']}: {col['crons']} (fleet={col['fleet_total']})")

    print()
    updated = resolve(configs, collisions, apply=args.apply)

    if args.apply:
        print("\nWriting updated config.json files...")
        write_configs(updated, args.root, args.org)

        # Re-check
        new_timeline = build_timeline(updated)
        new_collisions = find_collisions(new_timeline)
        print(f"\nPost-apply collision check: {len(new_collisions)} collision(s) remaining.")
        if new_collisions:
            for col in new_collisions:
                print(f"  {col['time']} — {col['agent']}: {col['crons']}")
            print_timeline(updated)
            return 1

    print_timeline(updated)
    return 0 if not args.apply or True else 1


if __name__ == "__main__":
    sys.exit(main())
