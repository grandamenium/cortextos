#!/usr/bin/env bash
# fleet-heartbeat-advance-watch.sh — SYS-MASK-01 (a) cron-tick-freshness backstop
#
# WHY: today's incident (2026-06-17, 2nd in ~8 days) — a daemon restart (↺~every
# 10h) stopped agents' heartbeat-crons while sessions stayed alive; 3 agents sat
# non-ticking 4-6h and were found MANUALLY. The deployed GAP3 cron-health detector
# (withCronHealthSignal #1340/#1366) did NOT auto-catch it — it reads daemon-cached
# cron-state, which a daemon restart staleens, so the masking-DETECTOR is itself
# maskable by the very event it should catch. This is the operational/status-masking
# class (cortextos status reports "running" while the heartbeat mechanism is dead).
#
# WHAT: read each agent's last_heartbeat from the BUS STORE (cortextos bus
# list-agents) — a RESTART-DURABLE source independent of the daemon cache — and
# check wall-clock advance. OUTCOME-based (did the heartbeat actually move) not
# process-based (did a cron fire). This is the un-maskable backstop per the
# Cycle-8 design-principle: check outcome from a source the mechanism cannot corrupt.
#
# This is the DETECT-side INTERIM safety net (per SYS-DAEMON-RESILIENCE-01 §6,
# PD detect-first/prevent-after sequencing): it lands now + catches a recurrence
# within one watch cycle so PD can wake-nudge before agents sit stale for hours.
# The durable PREVENT-side (devops reconcile-on-boot + inject-worker rebind) lands
# after. Severity-2 (session HUNG while status=running, e.g. improver today) is NOT
# caught here — tick-advance only catches tick-stopped; severity-2 rides the devops
# inject-worker-rebind liveness probe (daemon-can-reach-session). This watch = sev-1.
#
# CROSS-MONITOR COVERAGE COUPLING (bidirectional — DO NOT remove without the reciprocal):
#   This backstop COVERS the post-restart-fleet-never-recovers global-pause: after a daemon
#   restart, credit-death/daemon-wide-freeze leaves every agent hb-stale + work-silent, which
#   this watch ALERTs (the daemon-restart-stall class it is built for, trust-state-independent).
#   The wedge-watchdog HOLD-gate (holdAlertGate(fleetTrustedCount, K=3), scripts/self-healing/)
#   INTENTIONALLY SUPPRESSES its "possible global pause" alert during fleet-bootstrap (< K
#   trusted, e.g. just-post-restart) to avoid a guaranteed-recurring false-push — and that
#   suppression is SAFE *only because this backstop covers the suppressed case*. The two
#   monitors PARTITION the global-pause space: wedge HOLD = trusted-fleet-MID-RUN-stop (trust
#   preserved, no restart); this backstop = POST-RESTART-fleet-never-recovers. If this watch's
#   daemon-restart-stall detection is ever disabled/retuned, UPDATE the wedge holdAlertGate in
#   the same change — else the wedge suppression silently re-opens a global-pause blind spot
#   (the reciprocal note lives in wedge-watchdog holdAlertGate). A hidden cross-monitor
#   coverage dependency is itself a masking-class risk; the coupling is documented on BOTH sides.
#
# THRESHOLDS (grounded in the DEMONSTRATED incident, lenient-by-design):
#   The backstop targets the daemon-restart-stall CLASS — which manifests as HOURS
#   of non-ticking (today: 4-6h). It is NOT a tight per-agent liveness monitor.
#   Thresholds are deliberately generous so they NEVER false-fire on a legitimately
#   slow-heartbeating agent: testing 2026-06-17 showed user-proxy (passive Founder
#   auto-responder) at 56min while healthy — a 30min ALERT would have cried wolf on
#   it. So:
#   WARN  >90min  — well beyond any normal cadence incl. passive agents; soft heads-up
#   ALERT >180min — ~3h; catches the 4-6h daemon-stall class with margin (PD can
#                   nudge at 3h before it drags to 6h) without ever firing on a
#                   slow-but-healthy agent.
#   REFINEMENT (noted, not built): per-agent thresholds keyed to each agent's actual
#   configured heartbeat interval would tighten detection (esp. for the 4min coding
#   agents) without false-firing on passive ones. Universal-generous is the safe v1.
#
# Run:  bash scripts/fleet-heartbeat-advance-watch.sh   (read-only; bus-store)
# Exit: 0 = all agents fresh (<WARN)                 — no fire
#       1 = >=1 agent at ALERT (>30min)              — route ALERT to PD lane
#       3 = WARN-only (>15min, none at ALERT)        — soft heads-up to PD lane
#       2 = probe error (list-agents empty/unreadable) — probe-blind, do NOT fire
set -euo pipefail

# Thresholds raised to be SAFE for the slowest-legitimate heartbeat interval in the
# fleet: agents do NOT all heartbeat every ~4min — user-proxy (passive Founder
# auto-responder) heartbeats HOURLY ("38 * * * *"), so it normally reaches ~60-90min
# between ticks. WARN90 false-fired it 2026-06-17 (91min, healthy, just ticked 21:38).
# WARN150/ALERT210 sit above any normal interval incl. hourly+jitter, while still
# catching the daemon-restall incident class (today's was 4-6h » 210min). The proper
# refinement (noted, not built) is PER-AGENT interval-aware thresholds (read each
# agent's heartbeat-cron interval, set threshold = N x its interval) — that would
# restore fast-detection for the 4min agents without false-firing the hourly ones.
WARN_MIN="${FLEET_HB_WARN_MIN:-150}"
ALERT_MIN="${FLEET_HB_ALERT_MIN:-210}"

# ADVANCE-DELTA state: persist each agent's last_heartbeat between fires so a FROZEN
# agent (last_heartbeat NOT advancing across a cycle) is caught within ONE cycle,
# regardless of absolute age — the outcome-check (did it MOVE) beating the proxy
# (is the age high). Proof case 2026-06-17: frontend-dev frozen-since-19:08 sat 1min
# under the absolute WARN90 at the 20:37 fire; absolute-age missed it, advance-delta
# flags it immediately. A genuinely-slow-but-healthy agent (e.g. passive user-proxy)
# still ADVANCES within a cycle, so it won't trip FROZEN. FROZEN is WARN-level (soft),
# not a hard page, to stay safe against any unusually-slow-but-healthy interval.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Runtime state lives in CTX_ROOT/state (outside the repo) — never next to the tracked
# script, so relocating into scripts/self-healing/ produces zero tracked churn.
STATE_FILE="${FLEET_HB_STATE_FILE:-${CTX_ROOT:-$HOME/.cortextos/default}/state/.fleet-hb-prev-state.json}"
mkdir -p "$(dirname "$STATE_FILE")" 2>/dev/null || true

# Bus-store is the restart-durable source of truth (independent of daemon cache).
# FLEET_HB_RAW_OVERRIDE = test hook: inject a synthetic list-agents JSON to exercise the
# spare/alert paths deterministically (used by the negative-case test; unset in production).
RAW="${FLEET_HB_RAW_OVERRIDE:-$(cortextos bus list-agents --format json 2>/dev/null || true)}"
if [ -z "$RAW" ]; then
  echo "FLEET-HB-WATCH: ERROR — empty list-agents response (bus store unreadable?)" >&2
  exit 2
fi

# ACTIVITY-CORROBORATION input: a stale/frozen heartbeat is only a PROXY for a stop.
# work-produced is the un-maskable OUTCOME. A busy agent on a long work-turn (15-25min:
# rebases, builds, CI-watchers, long inference) ages its heartbeat WHILE genuinely
# producing — it only heartbeats at turn boundaries (cause-3: the FE 2026-06-17 + the
# improver 2026-06-19 [2x today] false-positives that would have cost a wrong reap).
#
# TWO outcome sources, combined (newest wins = liveness):
#  (1) task-activity (bus-store updated_at/completed_at) — RESTART-DURABLE but COARSE:
#      an agent producing mid-long-turn need not touch the task store, so this alone
#      MISSED improver (busy writing context_status, last task-update older than its hb).
#  (2) work-produced fs-mtime — the SHARED wedge-watchdog lastActivity source-set:
#      newest of {state/<name>/context_status.json, logs/<name>/stdout.log, state/<name>/
#      newest-file mtime}. context_status.json is the STRONGEST live signal (a wedged
#      session mid-dead-stream CANNOT write it) but only improver-class agents emit it;
#      stdout.log + state-dir mtime cover the rest. Consuming the SAME source-set as
#      wedge-watchdog-data.mjs lastActivity() keeps the two monitors from disagreeing on
#      busy-vs-stalled for the same agent (PD coherence req 2026-06-19; mirror until the
#      .mjs adds context_status — flagged to devops to fold into the in-flight iteration).
#
# RECENCY is WINDOW-RELATIVE (PD req): spare only if liveness is newer than the staleness
# threshold the candidate TRIPPED (now - liveness < that threshold), matching wedge B2's
# activity-within-the-window. An agent whose LAST work is OLDER than the freeze (produced
# once after an old hb then genuinely went quiet) still ALERTs — we never spare on
# stale-old activity. Corroboration-blind (no sources readable) -> do NOT suppress (fail
# toward surfacing, never hide). Tasks -> TEMP FILE (task-store JSON too large for env; E2BIG).
TASKS_FILE="$(mktemp -t fleet-hb-tasks.XXXXXX)"
trap 'rm -f "$TASKS_FILE"' EXIT
cortextos bus list-tasks --format json > "$TASKS_FILE" 2>/dev/null || echo '[]' > "$TASKS_FILE"

CTX_BASE="${CTX_ROOT:-$HOME/.cortextos/${CTX_INSTANCE_ID:-default}}"
WARN_MIN="$WARN_MIN" ALERT_MIN="$ALERT_MIN" RAW="$RAW" TASKS_FILE="$TASKS_FILE" STATE_FILE="$STATE_FILE" CTX_BASE="$CTX_BASE" python3 - <<'PY'
import json, os, sys, datetime

warn_m = float(os.environ["WARN_MIN"])
alert_m = float(os.environ["ALERT_MIN"])
state_file = os.environ["STATE_FILE"]
now = datetime.datetime.now(datetime.timezone.utc)

try:
    data = json.loads(os.environ["RAW"])
except Exception:
    print("FLEET-HB-WATCH: ERROR — unparseable list-agents JSON", file=sys.stderr)
    sys.exit(2)

agents = data if isinstance(data, list) else data.get("agents", [])
if not agents:
    print("FLEET-HB-WATCH: ERROR — no agents in list-agents response", file=sys.stderr)
    sys.exit(2)

# ACTIVITY map {agent: newest task updated/completed datetime} = the un-maskable OUTCOME.
# A heartbeat-candidate with task-activity AFTER its last_heartbeat is provably alive
# past the heartbeat (busy-not-frozen, cause-3) -> SUPPRESS. Corroboration-blind
# (empty/bad tasks) -> activity={} -> do NOT suppress (fail toward surfacing, never hide).
agent_activity = {}
try:
    with open(os.environ["TASKS_FILE"]) as tf:
        tasks = json.load(tf)
    for t in (tasks if isinstance(tasks, list) else []):
        who = t.get("assigned_to")
        if not who:
            continue
        for ts in (t.get("updated_at"), t.get("completed_at")):
            if not ts:
                continue
            try:
                dt = datetime.datetime.fromisoformat(ts.replace("Z", "+00:00"))
            except Exception:
                continue
            if who not in agent_activity or dt > agent_activity[who]:
                agent_activity[who] = dt
except Exception:
    agent_activity = {}  # corroboration-blind -> do not suppress

# fs-mtime activity = the SHARED wedge-watchdog lastActivity source-set:
# newest of {state/<name>/context_status.json, logs/<name>/stdout.log, state/<name>/
# newest-file mtime}. Finer-grained than task-activity (catches busy-mid-long-turn that
# never touches the task store, e.g. improver). Bus agent name == fs dir name (verified).
# Any path absent/unreadable -> just skipped (an agent missing context_status still has
# stdout.log + state-dir). Returns None only if NOTHING is readable (corroboration-blind).
ctx_base = os.environ.get("CTX_BASE", "")
def fs_activity_dt(name):
    if not ctx_base:
        return None
    newest = None
    explicit = [
        os.path.join(ctx_base, "state", name, "context_status.json"),
        os.path.join(ctx_base, "logs", name, "stdout.log"),
    ]
    for p in explicit:
        try:
            dt = datetime.datetime.fromtimestamp(os.path.getmtime(p), datetime.timezone.utc)
        except OSError:
            continue
        if newest is None or dt > newest:
            newest = dt
    sdir = os.path.join(ctx_base, "state", name)
    try:
        for entry in os.scandir(sdir):
            if not entry.is_file():
                continue
            try:
                dt = datetime.datetime.fromtimestamp(entry.stat().st_mtime, datetime.timezone.utc)
            except OSError:
                continue
            if newest is None or dt > newest:
                newest = dt
    except OSError:
        pass
    return newest

# Prev-fire readings {agent: last_heartbeat_value} for the advance-delta (frozen) check.
prev = {}
try:
    with open(state_file) as f:
        prev = json.load(f).get("readings", {})
except Exception:
    prev = {}  # first fire / missing / unreadable -> absolute-only this cycle

alerts, warns, lines = [], [], []
new_readings = {}
for ag in agents:
    name = ag.get("name", "?")
    if ag.get("enabled") is False:
        continue  # intentionally-disabled agents do not heartbeat
    hb = ag.get("last_heartbeat") or ag.get("lastHeartbeat") or ag.get("heartbeat_at")
    if not hb:
        lines.append(f"  {name}: NO last_heartbeat field -> skip (cannot assess)")
        continue
    try:
        hb_dt = datetime.datetime.fromisoformat(hb.replace("Z", "+00:00"))
        age_m = (now - hb_dt).total_seconds() / 60.0
    except Exception:
        lines.append(f"  {name}: unparseable last_heartbeat '{hb}' -> skip")
        continue
    new_readings[name] = hb
    # FROZEN = last_heartbeat did NOT advance since the prev fire (zero-advance).
    frozen = name in prev and prev[name] == hb
    # Candidate status = ABSOLUTE staleness only. advance-delta "frozen" is DEMOTED to
    # an informational note (not an independent trigger): its only two standalone catches
    # 2026-06-17 were BOTH false-positives (FE busy-long-turn, user-proxy hourly-heartbeat)
    # — at the watch's hourly cadence, zero-advance cannot distinguish frozen from a slow
    # or busy agent. Absolute-stale + activity-corroboration carry the real detection.
    if age_m > alert_m:
        status, bucket = "ALERT", alerts
    elif age_m > warn_m:
        status, bucket = "WARN", warns
    else:
        status, bucket = "OK", None
    # ACTIVITY-CORROBORATION (the OUTCOME, WINDOW-RELATIVE): liveness = newest of
    # {task-activity (bus-store), fs-mtime (context_status/stdout/state-dir)}. A candidate
    # is SUPPRESSED (busy-not-frozen) only if it produced work WITHIN the staleness window
    # it tripped (now - liveness < that threshold) — matching wedge B2. An agent whose LAST
    # work is OLDER than the freeze (genuinely went quiet) still ALERTs; never spare on
    # stale-old activity. Corroboration-blind (no source) -> do NOT suppress. NEVER auto-acts.
    threshold_for = alert_m if status == "ALERT" else (warn_m if status == "WARN" else None)
    live_dt = agent_activity.get(name)
    fs_dt = fs_activity_dt(name)
    if fs_dt is not None and (live_dt is None or fs_dt > live_dt):
        live_dt = fs_dt
    # frozen-note only on actual candidates (WARN/ALERT) — not on OK agents (avoids the
    # misleading "OK [frozen]" line; an OK agent simply hasn't ticked yet this window).
    note = " [frozen: hb unchanged since last fire]" if (frozen and bucket is not None) else ""
    if bucket is not None and live_dt is not None and threshold_for is not None:
        live_age_m = (now - live_dt).total_seconds() / 60.0
        if live_age_m < threshold_for:
            note = (f" -> SUPPRESSED busy (work-produced {live_age_m:.0f}min ago, "
                    f"within the {threshold_for:.0f}min window — busy-not-frozen)")
            status, bucket = "BUSY", None  # alive within the staleness window: do not alert
    lines.append(f"  {name}: hb {age_m:.0f}min old (WARN>{warn_m:.0f}, ALERT>{alert_m:.0f}) -> {status}{note}")
    if bucket is not None:
        bucket.append({"agent": name, "hbAgeMin": round(age_m), "status": status,
                       "reason": "absolute_alert" if status == "ALERT" else "absolute_warn",
                       "frozenNote": frozen,
                       "threshold": alert_m if status == "ALERT" else warn_m})

# Persist this fire's readings for the next cycle's advance-delta check.
try:
    with open(state_file, "w") as f:
        json.dump({"recordedAt": now.isoformat(), "readings": new_readings}, f)
except Exception as e:
    print(f"FLEET-HB-WATCH: WARN — could not write state file {state_file}: {e}", file=sys.stderr)

print("FLEET-HB-WATCH (bus-store last_heartbeat, restart-durable, advance-delta frozen-detection):")
print("\n".join(lines))

if alerts:
    print(f"\nALERT — route to PD lane (heartbeat stalled >{alert_m:.0f}min; PD triages "
          "nudge [sev-1 false-stale] then reap+cold-restart [sev-2 hung] per runbook):")
    print(json.dumps(alerts, indent=2))
    sys.exit(1)
if warns:
    print(f"\nWARN — soft heads-up to PD lane (FROZEN = hb did not advance since last fire = "
          f"cron-stopped, caught in one cycle regardless of age; or absolute >{warn_m:.0f}min):")
    print(json.dumps(warns, indent=2))
    sys.exit(3)
print(f"\nAll enabled agents heartbeating fresh (<{warn_m:.0f}min) + advancing — fleet tick healthy.")
sys.exit(0)
PY
