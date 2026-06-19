"""
Unit tests for cron-drift-watchdog SKILL.md Step 4 field lookup.

Verifies that:
1. agent_alive is determined by heartbeat.json:last_heartbeat (NOT cron-state.json:last_fire)
2. A fresh last_heartbeat suppresses ALL cron drift alerts for that agent
3. A stale last_heartbeat + stale cron-state -> alert emitted

Root cause: 2026-05-29 false-positive incident where ad-hoc code bypassed Step 4's
agent_alive suppression by reading cron-state.json:last_fire instead of heartbeat.json:last_heartbeat.
"""

import json
import tempfile
import os
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path


# ── Step 4 logic extracted from SKILL.md (canonical implementation) ──────────

GRACE = 1.5
MIN_ALERT_GAP = 60  # minutes


def parse_interval_min(cron_entry):
    interval = cron_entry.get("interval")
    cron_expr = cron_entry.get("cron")
    if interval:
        s = str(interval).strip().lower()
        if s.endswith("h"):
            return int(s[:-1]) * 60
        if s.endswith("m"):
            return int(s[:-1])
        if s.isdigit():
            return int(s)
    if cron_expr:
        parts = cron_expr.strip().split()
        if len(parts) == 5:
            minute, hour, dom, month, dow = parts
            if minute.startswith("*/") and hour == "*":
                return int(minute.split("/")[1])
            if (
                minute.replace(",", "").isdigit()
                and hour == "*"
                and dom == "*"
                and dow == "*"
            ):
                return 60
            if hour.startswith("*/") and dom == "*":
                return int(hour.split("/")[1]) * 60
            if (
                minute.replace(",", "").isdigit()
                and hour.replace(",", "").isdigit()
                and dom == "*"
                and dow == "*"
            ):
                return 1440
    return None


def get_heartbeat_age_min(state_dir, agent, now):
    """Read heartbeat.json:last_heartbeat — the authoritative liveness field."""
    hb = Path(state_dir) / agent / "heartbeat.json"
    if not hb.exists():
        return 9999
    try:
        d = json.loads(hb.read_text())
        lh = d.get("last_heartbeat", "")  # MUST use last_heartbeat, not updated_at
        if not lh:
            return 9999
        ts = datetime.fromisoformat(lh.replace("Z", "+00:00"))
        return (now - ts).total_seconds() / 60
    except Exception:
        return 9999


def run_step4(state_dir, agent, config_crons, cron_state_entries, now):
    """Execute Step 4 algorithm. Returns list of alert dicts."""
    state = {c["name"]: c for c in cron_state_entries}

    hb_age_min = get_heartbeat_age_min(state_dir, agent, now)
    hb_interval = (
        next(
            (parse_interval_min(c) for c in config_crons if c.get("name") == "heartbeat"),
            240,
        )
        or 240
    )
    agent_alive = hb_age_min < (hb_interval * GRACE)

    alerts = []
    for cron_entry in config_crons:
        name = cron_entry.get("name", "")
        interval_min = parse_interval_min(cron_entry)
        if interval_min is None:
            continue
        cron_state = state.get(name)
        if not cron_state:
            continue
        last_fire_str = cron_state.get("last_fire", "")
        if not last_fire_str:
            continue
        last_fire = datetime.fromisoformat(last_fire_str.replace("Z", "+00:00"))
        age_min = (now - last_fire).total_seconds() / 60
        if age_min > interval_min * GRACE and age_min > MIN_ALERT_GAP:
            if agent_alive:
                continue  # suppress — agent demonstrably alive
            alerts.append({"agent": agent, "cron": name, "drift_min": int(age_min - interval_min)})

    return alerts, agent_alive


# ── Fixtures ─────────────────────────────────────────────────────────────────

def make_state_dir(tmp, agent, heartbeat_age_min, cron_last_fire_age_min):
    """Create temp state directory with heartbeat.json and cron-state.json fixtures."""
    now = datetime.now(timezone.utc)
    agent_dir = Path(tmp) / agent
    agent_dir.mkdir(parents=True)

    hb_time = (now - timedelta(minutes=heartbeat_age_min)).isoformat()
    (agent_dir / "heartbeat.json").write_text(
        json.dumps({"agent": agent, "status": "alive", "last_heartbeat": hb_time})
    )

    last_fire = (now - timedelta(minutes=cron_last_fire_age_min)).isoformat()
    cron_state = {
        "crons": [
            {"name": "heartbeat", "last_fire": last_fire, "interval": "240"},
            {"name": "scope-audit", "last_fire": last_fire, "interval": "120"},
        ]
    }
    (agent_dir / "cron-state.json").write_text(json.dumps(cron_state))

    return str(Path(tmp))


CONFIG_CRONS = [
    {"name": "heartbeat", "interval": "240"},
    {"name": "scope-audit", "interval": "120"},
]


# ── Tests ─────────────────────────────────────────────────────────────────────

def test_fresh_heartbeat_suppresses_all_alerts():
    """
    Agent with fresh last_heartbeat but stale cron-state -> NO alerts.
    This is the false-positive scenario from 2026-05-29.
    """
    now = datetime.now(timezone.utc)
    with tempfile.TemporaryDirectory() as tmp:
        state_dir = make_state_dir(
            tmp,
            "product-owner",
            heartbeat_age_min=5,       # fresh: 5min ago
            cron_last_fire_age_min=900, # stale in cron-state: 900min ago
        )
        cron_state_entries = [
            {"name": "heartbeat", "last_fire": (now - timedelta(minutes=900)).isoformat()},
            {"name": "scope-audit", "last_fire": (now - timedelta(minutes=900)).isoformat()},
        ]
        alerts, agent_alive = run_step4(state_dir, "product-owner", CONFIG_CRONS, cron_state_entries, now)

    assert agent_alive is True, "Agent with 5min heartbeat should be alive"
    assert alerts == [], (
        f"Fresh heartbeat must suppress ALL alerts, got: {alerts}. "
        "This is the 2026-05-29 false-positive bug — ad-hoc code read cron-state instead of heartbeat.json"
    )
    print("PASS: fresh heartbeat suppresses stale cron-state alerts")


def test_stale_heartbeat_and_stale_cron_emits_alert():
    """
    Agent with stale last_heartbeat AND stale cron-state -> alerts emitted.
    """
    now = datetime.now(timezone.utc)
    with tempfile.TemporaryDirectory() as tmp:
        state_dir = make_state_dir(
            tmp,
            "dead-agent",
            heartbeat_age_min=600,     # stale: 600min (10h) ago
            cron_last_fire_age_min=600,
        )
        cron_state_entries = [
            {"name": "heartbeat", "last_fire": (now - timedelta(minutes=600)).isoformat()},
            {"name": "scope-audit", "last_fire": (now - timedelta(minutes=600)).isoformat()},
        ]
        alerts, agent_alive = run_step4(state_dir, "dead-agent", CONFIG_CRONS, cron_state_entries, now)

    assert agent_alive is False, "Agent with 600min heartbeat should NOT be alive"
    assert len(alerts) == 2, f"Expected 2 drift alerts, got {len(alerts)}: {alerts}"
    cron_names = {a["cron"] for a in alerts}
    assert "heartbeat" in cron_names
    assert "scope-audit" in cron_names
    print(f"PASS: stale agent emits {len(alerts)} alerts: {cron_names}")


def test_missing_heartbeat_json_treated_as_stale():
    """
    Agent with no heartbeat.json -> age=9999 -> not alive -> alerts possible.
    """
    now = datetime.now(timezone.utc)
    with tempfile.TemporaryDirectory() as tmp:
        agent_dir = Path(tmp) / "ghost-agent"
        agent_dir.mkdir()
        # No heartbeat.json written — agent is absent
        cron_state_entries = [
            {"name": "heartbeat", "last_fire": (now - timedelta(minutes=500)).isoformat()},
        ]
        config = [{"name": "heartbeat", "interval": "240"}]
        alerts, agent_alive = run_step4(str(tmp), "ghost-agent", config, cron_state_entries, now)

    assert agent_alive is False, "Missing heartbeat.json should be treated as not alive"
    print(f"PASS: missing heartbeat.json -> not alive -> {len(alerts)} alerts")


def test_last_heartbeat_field_not_updated_at():
    """
    Heartbeat.json must use 'last_heartbeat' key, not 'updated_at' or 'timestamp'.
    Writing wrong field names must result in age=9999 (not alive).
    """
    now = datetime.now(timezone.utc)
    with tempfile.TemporaryDirectory() as tmp:
        agent_dir = Path(tmp) / "wrong-field-agent"
        agent_dir.mkdir()
        # Write heartbeat.json with WRONG field names (updated_at, timestamp)
        (agent_dir / "heartbeat.json").write_text(json.dumps({
            "updated_at": now.isoformat(),   # wrong field
            "timestamp": now.isoformat(),    # wrong field
            # 'last_heartbeat' intentionally absent
        }))
        cron_state_entries = [
            {"name": "heartbeat", "last_fire": (now - timedelta(minutes=500)).isoformat()},
        ]
        config = [{"name": "heartbeat", "interval": "240"}]
        alerts, agent_alive = run_step4(str(tmp), "wrong-field-agent", config, cron_state_entries, now)

    assert agent_alive is False, (
        "Wrong field names (updated_at/timestamp) must NOT be accepted as last_heartbeat. "
        "Only 'last_heartbeat' is valid. See feedback_drift_watchdog_heartbeat_field."
    )
    print("PASS: only 'last_heartbeat' field is accepted — wrong fields treated as missing")


# ── Runner ────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    tests = [
        test_fresh_heartbeat_suppresses_all_alerts,
        test_stale_heartbeat_and_stale_cron_emits_alert,
        test_missing_heartbeat_json_treated_as_stale,
        test_last_heartbeat_field_not_updated_at,
    ]
    passed = 0
    failed = 0
    for t in tests:
        try:
            t()
            passed += 1
        except AssertionError as e:
            print(f"FAIL: {t.__name__}: {e}")
            failed += 1
        except Exception as e:
            print(f"ERROR: {t.__name__}: {e}")
            failed += 1

    print(f"\n{passed}/{len(tests)} tests passed")
    sys.exit(0 if failed == 0 else 1)
