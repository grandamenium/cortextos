# Symptom Playbooks

One playbook per common failure. Each lists the candidate causes in rough order
of likelihood, with the evidence that **confirms** or **refutes** each one.

Work the confirm/refute pairs rather than stopping at the first plausible story.
Several of these failures look identical from the user's side and differ only in
which file changed — the refute column is what keeps you from fixing the wrong
thing and believing you succeeded.

`$ROOT` is the runtime root (see `surface-map.md` §1). `$A` is the agent name.

**Contents**
- [Agent silent or wedged](#agent-silent-or-wedged)
- [Crash looping](#crash-looping)
- [Message never arrived](#message-never-arrived)
- [Telegram path specifically](#telegram-path-specifically)
- [Cron did not fire](#cron-did-not-fire)
- [Agent re-onboards on restart](#agent-re-onboards-on-restart)
- [Shows offline but is running](#shows-offline-but-is-running)
- [Whole fleet down](#whole-fleet-down)
- [Agent misbehaving but healthy](#agent-misbehaving-but-healthy)
- [Cannot reproduce](#cannot-reproduce)

---

## Agent silent or wedged

The agent is up but not responding. First question: **is it stuck, or did it
never receive anything?** These have opposite fixes, and the bus answers it in
one command.

```bash
ls -lt "$ROOT/inbox/$A" "$ROOT/inflight/$A" 2>/dev/null | head
ls -l  "$ROOT/logs/$A/stdout.log"          # mtime = last terminal activity
tail -100 "$ROOT/logs/$A/stdout.log"
tail -20  "$ROOT/logs/$A/restarts.log"
```

| Cause | Confirms | Refutes |
|---|---|---|
| Wedged mid-task | `inflight` holds a message; stdout ends mid-operation and stopped growing | `inflight` empty |
| Never delivered | Message sits in `inbox`; nothing in `fast-checker.log` | Message in `processed` |
| Waiting on a tool/API | stdout ends on a tool call; transcript shows a pending or failed call | stdout ends on ordinary output |
| Rate limited | 429 / "rate limit" in stdout or transcript | No such lines |
| Died without restart | stdout stops abruptly; `crashes.log` has an entry | `crashes.log` unchanged |
| Actually finished | Reply is in `processed`/`outbox` | Nothing outbound |

The last row is worth checking early. "Silent" sometimes means the agent replied
and the reply did not reach the user — a delivery problem pointing the other
direction, and you will waste a lot of time debugging the agent if you assume it
never ran.

If wedged: capture evidence to the bundle **before** restarting, because the
restart discards the wedged state you would need to explain it.

---

## Crash looping

Restarting repeatedly, never becoming useful.

```bash
cat "$ROOT/logs/$A/crashes.log"
tail -40 "$ROOT/logs/$A/restarts.log"
cat "$ROOT/logs/$A/.crash_count_today" 2>/dev/null
grep -i "$A" ~/.pm2/logs/cortextos-daemon-error.log | tail -40
```

The crash happens during startup, so the useful evidence is what stdout shows
**immediately before each death** — and the fact that it repeats means you get
many samples of the same moment. Compare two or three; what is identical across
them is the cause.

| Cause | Confirms | Refutes |
|---|---|---|
| Poisoned session state | Same error each boot; clearing session state ends it | Errors differ run to run |
| Bad config / malformed JSON | Parse error in daemon log naming the file | Configs parse cleanly |
| Missing dependency | `ENOENT`, module load failure, `node-pty` error | `cortextos doctor` passes |
| Bad instruction at boot | Agent errors while reading bootstrap files | Crash precedes bootstrap |
| Resource exhaustion | Disk full, OOM, descriptor limits | Resources fine |
| Harness/CLI failure | Underlying CLI fails standalone | CLI runs fine by hand |

Validate configs cheaply before theorizing:

```bash
for f in "$ROOT/config/"*.json; do python3 -m json.tool "$f" >/dev/null \
  && echo "ok $f" || echo "BAD $f"; done
```

Escalation matters here: a single looping agent is contained. A looping **daemon**
takes the fleet down and eventually trips PM2's circuit breaker
(`surface-map.md` §5). Check `pm2 list` to see which you have before deciding how
urgent this is.

---

## Message never arrived

Trace the path in order and find the first place it is absent. The lifecycle has
several hops, and knowing the last hop that saw it collapses the search
immediately:

```
Telegram → poller → bus inbox → fast-checker → PTY injection → agent
```

```bash
for d in inbox inflight processed; do
  echo "== $d"; ls -lt "$ROOT/$d/$A" 2>/dev/null | head -5
done
tail -100 "$ROOT/logs/$A/fast-checker.log"
grep -iE "poll|telegram|inject" ~/.pm2/logs/cortextos-daemon-out.log | tail -40
```

| Last seen at | Meaning | Look at |
|---|---|---|
| Nowhere | Never entered the system | Poller, bot token, allowed users |
| `inbox`, not picked up | Delivery side stalled | fast-checker.log, daemon health |
| `inflight`, stuck | Claimed, never completed | Agent crashed mid-processing |
| `processed`, no reply | Delivered fine | Not infrastructure — read transcript |
| In `fast-checker.log` | Injected into session | Agent behavior, not plumbing |

The `processed` case is the one people misdiagnose most. Delivery succeeded; the
agent chose not to act, or acted invisibly. That is a prompt/behavior
investigation, and no amount of daemon debugging will move it.

**Known timing quirk, not a bug:** a message sent while an agent is still
producing its onboarding output gets consumed without being acted on. Wait for
the agent to go idle, then send. If the symptom only ever appears during
onboarding, this is very likely it.

---

## Telegram path specifically

```bash
tail -100 "$ROOT/logs/$A/fast-checker.log"
grep -iE "telegram|poller|getUpdates|offset|401|409|unauthorized" \
  ~/.pm2/logs/cortextos-daemon-out.log | tail -40
```

The poller long-polls Telegram and accepts messages only from allowed users, so
misconfiguration usually presents as total silence rather than as an error the
user sees.

| Cause | Confirms | Refutes |
|---|---|---|
| User not allow-listed | Message never enters bus; poller shows a rejection | Other messages from same user work |
| Bad/rotated bot token | 401 in poller output | Poller authenticates |
| Two pollers competing | 409 conflict on getUpdates | Single daemon in `pm2 list` |
| Offset skipped ahead | Gap in message IDs; older messages never fetched | Offset advances normally |
| Poller not running | No poll activity in daemon log at all | Regular poll lines |

409 conflicts deserve suspicion whenever someone has been restarting things by
hand — two daemons polling the same bot is a common self-inflicted state and
looks like intermittent message loss.

---

## Cron did not fire

Definition problem or dispatch problem — check the definition first, it is
cheaper and more often the answer.

```bash
cat "$ROOT/orgs/<org>/crons.json" | python3 -m json.tool
grep -i cron ~/.pm2/logs/cortextos-daemon-out.log | tail -40
```

| Cause | Confirms | Refutes |
|---|---|---|
| Wrong schedule expression | Expression does not mean what was intended | Expression correct |
| Disabled / not saved | Entry absent or flagged off | Entry present and enabled |
| Targets wrong agent | `agent` field names someone else | Target correct |
| Daemon down at fire time | Daemon restart spans the window | Daemon up throughout |
| Fired, message lost | Daemon logs the dispatch; bus has nothing | No dispatch logged |
| Fired, agent ignored it | Message in `processed` | Never reached bus |

"Fired but ignored" is again a behavior question, not a scheduler one.

---

## Agent re-onboards on restart

The agent greets you as new every time. Almost always a marker that never got
written.

```bash
ls -la "$ROOT/state/$A/"
tail -20 "$ROOT/logs/$A/restarts.log"
```

| Cause | Confirms | Refutes |
|---|---|---|
| `.onboarded` never written | Marker absent though onboarding was completed | Marker present |
| Onboarding never finished | Transcript shows it veered off before the last step | Ran to completion |
| Marker in wrong location | Marker exists under a different root/instance | Only one root in use |
| Wrong root entirely | Agent reads a different `$ROOT` than you inspected | Roots match |

The last row is a recurring trap on installs that have both `~/.cortextos/` and
`~/.business-os/` present — you inspect one, the agent uses the other, and every
marker looks mysteriously absent. Confirm which root the agent actually resolves
before concluding the marker logic is broken.

Writing the marker by hand resolves the symptom but not the cause. Note in your
report *why* it was missing, so a repeat is recognizable.

---

## Shows offline but is running

A reporting failure, not a liveness failure — establish that first.

```bash
pm2 list
cat "$ROOT/state/$A/heartbeat.json" 2>/dev/null | python3 -m json.tool
cat "$ROOT/state/heartbeat/$A.json" 2>/dev/null | python3 -m json.tool
ls -l "$ROOT/logs/$A/stdout.log"
```

If the process is up and stdout is growing, the agent is fine and the *heartbeat*
is the broken thing.

| Cause | Confirms | Refutes |
|---|---|---|
| Heartbeat not being written | File mtime is old, process is up | mtime current |
| Written to a different path | Both canonical and legacy paths exist, one stale | Single path |
| Dashboard reads elsewhere | Heartbeat current but UI disagrees | Both agree |
| Agent too busy to heartbeat | Long uninterrupted operation in stdout | Idle agent |
| Clock skew | Timestamps inconsistent with wall clock | Times align |

---

## Whole fleet down

Rare, and usually system-level rather than a cortext bug.

```bash
pm2 list
tail -100 ~/.pm2/logs/cortextos-daemon-error.log
pm2 describe cortextos-daemon | head -30
uptime; df -h | head -5
```

| Cause | Confirms | Refutes |
|---|---|---|
| Machine rebooted, no resurrection | Uptime is short; daemon absent from `pm2 list` | Long uptime |
| PM2 gave up after crash storm | High restart count, stopped/errored status | Low restart count |
| Daemon crash | Stack trace in error log | Clean log |
| Disk full | `df` near 100%; write failures in logs | Ample space |
| Node/dependency broke after update | `cortextos doctor` fails on environment | Doctor passes |

After a reboot with no resurrection configured, the fix is `pm2 startup` plus
`pm2 save` — nothing is actually broken.

If PM2 tripped its breaker, **diagnose before restarting.** A restart re-enters
the loop and overwrites the evidence that would explain it.

---

## Agent misbehaving but healthy

Everything runs; the behavior is wrong. No log will show an error, because
nothing errored — the agent did what it was told.

```bash
find "$ROOT" -name "*.md" -mtime -7 2>/dev/null | head -20
cat "$ROOT/config/enabled-agents.json" | python3 -m json.tool
```

Read, in order: bootstrap `.md` files (identity, guardrails, goals), `config.json`,
the agent's loaded skills, then `enabled-agents.json`.

| Cause | Confirms | Refutes |
|---|---|---|
| Instruction says so | A file plainly directs this behavior | Nothing relevant |
| Recent edit changed it | Behavior change lines up with an mtime | No recent edits |
| Skill triggering wrongly | Skill fires when it should not, or never fires | Triggering correct |
| Roster gap | Other agent missing from `enabled-agents.json` | Roster complete |
| Missing key surfaces as refusal | Tool errors on absent credential | Keys present |

Small wording changes move behavior a lot. When the user says "it used to do X",
treat that as a diff question and go looking for what changed.

---

## Cannot reproduce

Legitimate outcome, not a failure. Do not manufacture a cause.

Establish and report:

- **Did it actually happen?** Find the artifact — a log line, a message, a
  timestamp. Sometimes the expectation was wrong, which is worth knowing.
- **Is it transient?** A single crash that recovered may need no fix.
- **Has evidence rotated out?** stdout rotates at 50MB; old detail may be gone.
- **What would catch it next time?** Naming the surface to watch turns an
  unresolved case into a prepared one.

Report the boundary honestly: what you checked, what you eliminated, what remains
possible, and what would settle it. That is more useful than a plausible story,
and much easier to build on when it recurs.
