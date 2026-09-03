# Diagnostic Surface Map

Every place cortextOS writes something you can use as evidence. For each surface:
what question it answers, how to read it, and what it means when it is missing or
empty — absence is evidence too, and it is the part people skip.

**Contents**
1. [Resolving the runtime root](#1-resolving-the-runtime-root)
2. [Agent logs](#2-agent-logs)
3. [The message bus](#3-the-message-bus)
4. [State and markers](#4-state-and-markers)
5. [Daemon and PM2](#5-daemon-and-pm2)
6. [Session transcripts](#6-session-transcripts)
7. [Crons](#7-crons)
8. [Config and behavior surfaces](#8-config-and-behavior-surfaces)
9. [Reading order by question](#9-reading-order-by-question)

---

## 1. Resolving the runtime root

Everything below is relative to the runtime root, and getting this wrong makes a
healthy system look dead. Resolution order, matching `src/utils/env.ts`:

1. `$CTX_ROOT` if exported
2. `CTX_ROOT=` in a `.cortextos-env` file (per-agent, in the agent's directory)
3. `~/.cortextos/<instance>/` — the canonical default, instance usually `default`
4. `~/.business-os/` — legacy root, still live on installs that predate the rename

```bash
ROOT="${CTX_ROOT:-}"
[ -z "$ROOT" ] && [ -d ~/.cortextos/default ] && ROOT=~/.cortextos/default
[ -z "$ROOT" ] && [ -d ~/.business-os ] && ROOT=~/.business-os
echo "root: $ROOT"; ls "$ROOT"
```

An install can have both paths present with only one populated. Check which has
recent mtimes rather than assuming:

```bash
ls -lt ~/.cortextos/default ~/.business-os 2>/dev/null | head -20
```

Framework source is separate from runtime state — usually `~/cortextos/`. Code
questions go there; state questions go to the root.

---

## 2. Agent logs

`$ROOT/logs/<agent>/`. The densest evidence in the system.

| File | What it answers |
|---|---|
| `stdout.log` | Everything the PTY rendered — the full terminal history |
| `stderr.log` | Process-level errors; usually empty, interesting when not |
| `restarts.log` | Every restart, when and why (planned and unplanned) |
| `crashes.log` | Crashes only — the signal without the restart noise |
| `fast-checker.log` | Message injection: what was delivered into the session |
| `activity.log` | Higher-level activity trail |
| `.crash_count_today` | Crash counter; a large number means a loop |
| `.first_start` | Marker for first-ever boot |

**stdout.log** is effectively a continuous screenshot of the terminal, status line
and input box included. That makes it verbose but complete — if something was
visible in the session, it is here. Rotated at 50MB, so history is deep but not
infinite.

```bash
tail -300 "$ROOT/logs/<agent>/stdout.log"
grep -niE "error|exception|fatal|refused|timeout|ENOENT|429|rate.?limit" \
  "$ROOT/logs/<agent>/stdout.log" | tail -40
```

For a wedged agent, the *last* lines matter most — whatever it was doing when it
stopped. Check the file mtime against the wall clock: a stdout.log that stopped
growing an hour ago is a strong signal on its own.

**restarts.log / crashes.log** are small and high-signal. Read them fully:

```bash
cat "$ROOT/logs/<agent>/restarts.log" | tail -50
cat "$ROOT/logs/<agent>/crashes.log"
cat "$ROOT/logs/<agent>/.crash_count_today" 2>/dev/null
```

Restart cadence tells you the failure shape. Every few seconds is a crash loop —
the agent dies during startup, so look at what it does *before* it is ready.
Every few hours is likelier planned (handoff, refresh) and usually healthy.

**fast-checker.log** answers "was the message actually put into the session?",
which is the question that splits a delivery bug from a comprehension bug. If the
message appears here, the pipe worked and the agent simply did not act on it —
a very different problem with a very different fix.

**Empty or missing log dir** means this agent never started under the daemon.
Check `config/enabled-agents.json` and the daemon log before assuming a crash.

---

## 3. The message bus

Messages move through four directories, each per-agent:

```
$ROOT/inbox/<agent>/      queued, not yet picked up
$ROOT/inflight/<agent>/   being processed right now
$ROOT/processed/<agent>/  done — retained for audit
$ROOT/outbox/<agent>/     outbound from this agent
```

**Where a message sits localizes the fault**, which makes this the fastest
triage in the system:

- Stuck in `inbox` → not picked up. Fast-checker or daemon side.
- Stuck in `inflight` → picked up, never completed. Agent died mid-processing,
  or the session wedged. Cross-check `restarts.log` for that timestamp.
- In `processed` but the user saw no reply → delivery worked; this is a
  behavior question, not an infrastructure one. Go read the transcript.
- Never anywhere → it never entered the bus. Look at the Telegram poller.

```bash
for d in inbox inflight processed outbox; do
  echo "$d: $(ls "$ROOT/$d/<agent>" 2>/dev/null | wc -l)"
done
ls -lt "$ROOT/inbox/<agent>" | head
```

Message JSON fields: `id`, `from`, `to`, `priority`, `timestamp`, `text`,
`reply_to`. Read a stuck one directly — `to` and `timestamp` are usually the
tell:

```bash
cat "$ROOT/inflight/<agent>/"*.json | python3 -m json.tool | head -40
```

A growing `inflight` count is a reliable early warning: work is being claimed and
not finished.

---

## 4. State and markers

`$ROOT/state/<agent>/`, with `heartbeat.json` canonical. Some installs use
`state/heartbeat/<agent>.json` instead — check both.

Markers are dotfiles that coordinate the daemon and the agent: `.onboarded`,
`.force-refresh`, `.handoff`, and similar. They are written by both sides as
lifecycle events happen, which is exactly why they drift.

```bash
ls -la "$ROOT/state/<agent>/"
cat "$ROOT/state/<agent>/heartbeat.json" 2>/dev/null | python3 -m json.tool
cat "$ROOT/state/heartbeat/<agent>.json" 2>/dev/null | python3 -m json.tool
```

**Heartbeat** answers "does the system think this agent is alive?" A stale
heartbeat on a running process is the classic "shows offline but it's up" bug —
and note the direction of the inference: the heartbeat describes reporting, not
liveness. Confirm the process separately with `pm2 list` before treating a stale
heartbeat as a dead agent.

**Markers explain lifecycle weirdness.** The signature case: an agent that
re-runs onboarding on every restart because `.onboarded` never got written —
often because onboarding was interrupted or veered off before its final step.
Similarly, a "force refresh" that behaved like a plain continue points at
`.force-refresh` not being consumed. When lifecycle behavior is wrong, compare
marker mtimes against `restarts.log` timestamps.

---

## 5. Daemon and PM2

The daemon is the process manager for the whole fleet — PTY sessions, restarts,
handoffs, the cron scheduler, and the Telegram poller all live under it. Because
it spans so much, **it is the best first look when you have no idea where to
start.**

Its logs sit outside the runtime root, under PM2:

```bash
tail -200 ~/.pm2/logs/cortextos-daemon-out.log
tail -100 ~/.pm2/logs/cortextos-daemon-error.log
ls -lt ~/.pm2/logs/ | head
pm2 list
pm2 describe cortextos-daemon
```

`pm2 list` gives status, uptime, and restart count in one line. A high restart
count with low uptime is a daemon crash loop — a different and more serious
condition than a single agent looping, because it takes the fleet with it.

PM2 has a deliberate circuit breaker: if the daemon dies ~10 times faster than 5s
apart, PM2 stops trying and the fleet stays down until someone runs
`pm2 restart cortextos-daemon`. Storm protection is preferred over uptime during
a pathological loop, so **a fully dead fleet after repeated crashes is designed
behavior, not a second bug.** Find the crash cause before restarting, or you will
just re-enter the loop with the evidence overwritten.

Fleet-wide outage after a reboot usually means PM2 resurrection was never
configured, not that anything crashed:

```bash
pm2 startup   # prints the command needed; does not change anything by itself
pm2 save      # persists the current process list for resurrection
```

The daemon also exposes an IPC socket at `$ROOT/daemon.sock`. Missing socket with
a daemon that claims to be online is a real inconsistency worth chasing.

---

## 6. Session transcripts

The verbatim conversation history, written by the harness rather than by cortext.
Location depends on which CLI backs the agent — Claude Code, Codex, and OpenCode
each keep their own, typically as JSONL under the respective tool's home
directory.

Two situations make transcripts the right surface:

**Cortext's logs are clean but behavior is wrong.** The fault is likely a layer
down — a harness bug, a tool-call failure, an API error, a rate limit. Those
appear in the transcript and nowhere in cortext's logs.

**Something was known and then wasn't.** If an agent lost context that is not in
any memory file, the transcript still has it verbatim and can be searched.

Because transcripts contain full conversation content, treat them as the most
sensitive surface here. Quote the minimum needed, and never copy transcript
content into anything destined for a public PR.

---

## 7. Crons

Scheduled prompts are dispatched by the scheduler *inside the daemon*, so cron
failures split cleanly in two:

```bash
cat "$ROOT/orgs/<org>/crons.json" 2>/dev/null | python3 -m json.tool
ls "$ROOT/orgs/<org>/" 2>/dev/null
grep -i cron ~/.pm2/logs/cortextos-daemon-out.log | tail -40
```

- **Definition problem** — wrong schedule, wrong agent, disabled entry. It lives
  in `crons.json` and the state file beside it.
- **Dispatch problem** — the definition is right and the scheduler did not fire,
  or fired and the message went nowhere. That is in the daemon log, and then in
  the bus.

Check the definition first; it is cheaper and it is more often the answer.

---

## 8. Config and behavior surfaces

When an agent is *working* but behaving wrong, the cause is usually here rather
than in any log:

| Surface | Governs |
|---|---|
| Agent bootstrap `.md` files | Identity, instructions, guardrails, goals |
| Agent `config.json` | Goals, approvals, comms preferences |
| `.claude/skills/*/SKILL.md` | Loaded capabilities and their triggers |
| `$ROOT/config/enabled-agents.json` | Who exists and who can see whom |
| Secrets / `.env` | API keys; missing keys surface as tool failures |

`enabled-agents.json` is the specific answer to "agent A doesn't know agent B
exists" — that roster is what agents consult for who is on the fleet.

These files are worth diffing against recent edits. A one-line change to a
bootstrap file can shift behavior substantially, and it will not appear as an
error anywhere. Ask what was edited recently and check mtimes:

```bash
find "$ROOT" -name "*.md" -mtime -7 2>/dev/null | head -20
```

---

## 9. Reading order by question

| Question | Order |
|---|---|
| Is it alive? | `pm2 list` → heartbeat → stdout.log mtime |
| Why did it stop? | stdout.log tail → restarts.log → crashes.log → daemon error |
| Why does it keep dying? | crashes.log → daemon error → stdout.log before each death |
| Where did my message go? | inbox/inflight/processed → fast-checker.log → daemon log |
| Why didn't the cron fire? | crons.json → daemon log → bus |
| Why is it acting strange? | bootstrap files → config.json → skills → transcript |
| Everything is down | `pm2 list` → daemon error → PM2 startup config |
| Nothing above explains it | session transcript — likely harness or API, not cortext |
