---
name: cortext-self-diagnosis
description: "Diagnose cortextOS itself when the framework misbehaves — an agent has gone silent or wedged, agents are crash-looping, Telegram or agent-to-agent messages are not arriving, crons did not fire, an agent re-onboards or shows offline when it is running, the daemon died, or the whole fleet is down. Walks a structured evidence-first investigation across logs, the message bus, state markers, and daemon output, then classifies the finding as local config vs. a genuine framework bug — and for real bugs, drives a fix branch, a user-run test matrix, a PII/focus gate, and an upstream PR. Use this whenever someone asks you to debug, investigate, troubleshoot, or explain anything about cortext/cortextOS behavior, even casually (\"why did my agent stop replying\", \"is something broken\", \"cortext is acting weird\"). For stale tasks, stale goals, or workload health instead, use system-diagnostics."
triggers: ["debug cortext", "cortext is broken", "cortextos issue", "agent not responding", "agent went silent", "agent is stuck", "agent is wedged", "crash loop", "crashing repeatedly", "messages not arriving", "telegram not working", "message never delivered", "cron did not fire", "cron didn't run", "daemon down", "fleet is down", "agent shows offline", "re-onboarding", "onboarding again", "investigate cortext", "troubleshoot cortext", "why did my agent", "something is wrong with cortext", "framework bug", "cortext bug", "file a PR upstream", "fix cortext"]
external_calls: ["github.com"]
---

# Cortext Self-Diagnosis

Debugging the framework you are running inside. This skill covers cortextOS
infrastructure: PTY sessions, the daemon, the message bus, state markers, crons,
and the Telegram path — through to an upstream fix when the cause is real.

**Not this skill:** stale tasks, stale goals, overdue human tasks, fleet workload
health. That is `system-diagnostics`. The dividing line is simple — if the
machinery is misbehaving, you are here; if the machinery works and the *work* is
stuck, you are there.

---

## The one thing that makes this different

You are debugging the system that is currently executing you. Your session is a
PTY child of the daemon you are about to inspect. This has three consequences
that will bite you if you forget them:

**Write evidence to disk before you touch anything that restarts.** A daemon
restart kills and respawns your own PTY. Anything you know only in context is
gone. The evidence bundle exists so your findings survive your own restart.

**Never restart the daemon or your own agent without saying so first.** From the
user's side that looks identical to the bug — the agent goes quiet. Tell them
what you are about to do, that you may drop mid-sentence, and roughly when you
will be back.

**You are a witness, and witnesses have blind spots.** If you are the agent that
is misbehaving, your account of yourself is the least reliable evidence you have.
Prefer the logs to your own memory, and when the symptom is about *you*, say so
plainly to the user and lean harder on the files.

---

## Stance: evidence before repair

The failure mode this skill exists to prevent is the confident guess — changing a
config, restarting something, declaring it fixed, and never learning what
happened. It usually "works" because restarts paper over transient state, and the
bug returns next week with the trail gone cold.

So: **find the artifact that proves it before you touch anything.** A hypothesis
you cannot point at a log line for is a hunch. Say "I think" out loud when it is
a hunch — users make much better decisions when they know which of your claims
are load-bearing.

If the evidence genuinely does not resolve it, that is a real outcome. Say what
you checked, what you ruled out, and what would settle it. That beats a fix that
might be unrelated.

---

## Phase 0 — Orient

Two minutes, before any commands.

Get the symptom concrete. "Cortext is broken" is not actionable; "opsbot stopped
replying on Telegram around 2pm, still nothing" is. You need:

- **Which agent(s)** — one, several, or the whole fleet
- **What you expected vs. what happened**
- **When it started**, even roughly, and whether it is ongoing or over
- **What changed recently** — an update, a config edit, a new agent, a reboot,
  a rebuild. This single question resolves a large share of cases.

Then resolve the runtime root, because everything else hangs off it:

```bash
# Precedence: explicit env, then per-agent env file, then instance default,
# then the legacy root some installs still use.
echo "${CTX_ROOT:-$(grep -h '^CTX_ROOT=' ~/.cortextos-env */.cortextos-env 2>/dev/null | head -1 | cut -d= -f2)}"
ls -d ~/.cortextos/default ~/.business-os 2>/dev/null
```

Layout under the root (`references/surface-map.md` has the full map):

```
logs/{agent}/       stdout.log stderr.log restarts.log crashes.log
                    fast-checker.log activity.log .crash_count_today
state/{agent}/      heartbeat.json + .onboarded .force-refresh .handoff markers
inbox|inflight|processed|outbox/{agent}/    message lifecycle
config/             enabled-agents.json
orgs/{org}/         tasks/ approvals/ analytics/ crons.json
```

Daemon output lives outside the root, under PM2:
`~/.pm2/logs/cortextos-daemon-out.log` and `-error.log`.

---

## Phase 1 — Collect evidence

Run the collector. It snapshots every surface at once into a timestamped bundle,
so you are reading a consistent moment rather than files that shift under you:

```bash
bash scripts/collect_evidence.sh --agent <name> --since 2h
# whole fleet: omit --agent
```

It prints a bundle path. Read it there.

**The script is a fast path, not the method.** It knows the standard layout; it
does not know your install's quirks, and it cannot tell which of 400 log lines
matters. Installs drift — legacy roots, relocated logs, custom instances. When
the script comes back thin or empty, that is a signal to go look by hand, not a
verdict that nothing is wrong. `references/surface-map.md` documents each surface
so you can read any of them directly:

```bash
tail -200 "$ROOT/logs/<agent>/stdout.log"
tail -50  "$ROOT/logs/<agent>/restarts.log"
tail -100 ~/.pm2/logs/cortextos-daemon-error.log
```

Also run the framework's own preflight — it catches environment breakage
(Node version, node-pty native module, PM2, CLI auth) faster than reading logs:

```bash
cortextos doctor
```

---

## Phase 2 — Read the right surface first

Symptom routes you to the surface most likely to hold the answer. Start there,
then widen. Full playbooks with confirm/refute criteria are in
`references/symptom-playbooks.md` — read it when your symptom is on this list, as
each playbook carries the specific log lines that distinguish similar-looking
causes.

| Symptom | Start here | Then |
|---|---|---|
| Agent silent / wedged | `logs/<agent>/stdout.log` tail | `restarts.log`, session transcript |
| Crash looping | `crashes.log`, `restarts.log` | daemon error log, `.crash_count_today` |
| Message never arrived | `inbox/` `inflight/` `processed/` | `fast-checker.log`, poller logs |
| Telegram specifically | `fast-checker.log` | daemon log, telegram offset, allowed-users |
| Cron did not fire | `orgs/<org>/crons.json`, cron state | daemon log (scheduler lives there) |
| Agent re-onboards | `state/<agent>/` markers | `restarts.log` |
| Shows offline but is up | `state/<agent>/heartbeat.json` | daemon log |
| Whole fleet down | `pm2 list`, daemon error log | PM2 startup config |
| Agent misbehaving, not broken | bootstrap `.md`, `config.json`, skills | `enabled-agents.json` |

That last row matters more than it looks. A large share of "bugs" are the agent
faithfully following an instruction someone wrote. Before you go hunting in the
daemon, read what the agent was actually told. These systems are suggestible and
a stray line in a bootstrap file changes behavior a lot.

When cortext's own logs are clean but behavior is still wrong, the fault is often
one layer down in the harness — Claude Code, Codex, or OpenCode itself, or an API
error. Those surface in the **session transcript**, not in cortext's logs. That
is the place to look when everything cortext-side appears healthy.

---

## Phase 3 — Hypothesis, then confirmation

State the hypothesis in one sentence, in causal form: *the fast-checker stopped
polling at 14:02, so messages queued in inbox and never reached the PTY.*

Then go find the artifact that would be true if you are right — and, just as
important, **the one that would be true if you are wrong.** Actively look for the
second one. Confirmation bias is the main way debugging goes sideways: the first
plausible story absorbs every subsequent observation.

Timestamps are your strongest tool. Line up the moment the symptom started
against restarts, crashes, daemon events, and message timestamps. Causes precede
effects, which sounds obvious and eliminates suspects fast.

**Timing trap worth knowing:** after any daemon restart there is a burst of
startup noise — reconnects, re-injections, heartbeat churn — that looks a lot
like the original symptom. Give it **ten minutes** before judging whether a
restart fixed anything. Calling it too early, in either direction, is one of the
easier ways to waste an hour.

---

## Phase 4 — Classify the finding (the gate)

This is the decision that determines everything downstream, and the one most
worth getting right.

**Most findings are not framework bugs.** Ranked by how often they actually are
the answer:

1. **Local config or state** — a marker file wrong, a stale lock, a malformed
   config, an agent not in `enabled-agents.json`, a bad token. Fix locally.
2. **Environment** — Node version, `node-pty` not built, PM2 not set to resume
   on boot, missing CLI auth, disk full. Fix locally; `cortextos doctor` finds
   most of these.
3. **Instruction/prompt** — the agent did what its files told it to. Edit the
   files, not the framework.
4. **Downstream harness or API** — a Claude Code / Codex / OpenCode bug, a rate
   limit, an upstream outage. Not cortext's to fix; worth reporting to them.
5. **Genuine framework bug** — cortext's own code does the wrong thing given
   valid inputs. Only this one earns a PR.

Before classifying something as (5), satisfy yourself on all of these:

- You can point to the specific code path in `~/cortextos/src/` that is wrong
- You can state the inputs that trigger it and why the current logic mishandles them
- It is not explained by local config, environment, or instructions
- It would affect anyone with the same version — not just this install

If any is shaky, it is not yet a framework bug. Say so, fix what you can locally,
and note what would confirm it. Escalating a local problem to a public PR wastes
maintainer attention and is difficult to walk back.

---

## Phase 5 — Local fix

For causes 1–4, fix locally and verify against the same evidence that showed the
problem. Prefer the narrowest reversible change, and tell the user what you
changed and how to undo it. Before editing any config or marker, back it up.

Then confirm with fresh evidence, not with a restart and a hopeful look. The
symptom must be gone in the surface where you originally saw it, and remember
the ten-minute rule if a restart was involved.

---

## Phase 6 — Upstream path

Only for cause (5), and only with the user's agreement to proceed. The full
procedure is in `references/upstream-pr.md`; read it before starting, and read
`references/test-matrix.md` when you get to verification. In outline:

1. Branch from `upstream/main` — never from whatever the local checkout sits on
2. Write the narrowest fix that addresses the root cause, plus a regression test
3. Build a **user-facing test matrix** — the reproduction, then the same steps
   against the rebuilt branch. `references/test-matrix.md` covers how to make it
   runnable by a human with an agent watching
4. The user runs it; you observe the evidence surfaces and report honestly
5. Run the **PII and focus gate** — `scripts/pr_gate.py`, plus your own read
6. **Stop.** Present everything and get explicit approval before any push or PR

**Hard boundary:** nothing leaves this machine without the user saying yes to
that specific action. Not a fork push, not a PR. A green test matrix and a clean
gate are prerequisites for *asking*, never a substitute for it. If you are unsure
whether something counts as outward-facing, it does — ask.

---

## Talking to the user

Diagnosis is mostly a communication task. The user has more context than you
about what changed and what is normal here, and they are the one deciding what
risk to take. Bring them along.

**Lead with the finding, not the walk.** "Your fast-checker died at 14:02 —
that's why opsbot went quiet" beats a chronological tour of what you checked.
Detail goes underneath, for the people who want it.

**Separate what you saw from what you infer.** Observation: the log stops at
14:02. Inference: that is probably why messages stopped. Users can challenge an
inference if they can see it is one.

**Never paste raw log dumps as your answer.** Quote the two or three lines that
carry the finding. Put the bundle path underneath for anyone who wants to dig.

**Ask before anything invasive** — restarts, config edits, clearing state,
killing sessions — and say what it will look like from their side. Restarting
their orchestrator without warning during a workday is a genuinely bad surprise.

**Report dead ends honestly.** "I checked these five surfaces and none of them
explain it; here's what would" is a real contribution. Inventing a plausible
cause to seem useful destroys the thing that makes you worth asking.

A shape that works for the final report:

```
What's wrong:   one sentence, plain language
Evidence:       the 2-3 lines that prove it, with file + timestamp
Why it happened: the causal chain
Fix:            what I'd do, how risky, how to undo it
Confidence:     high / medium / low, and what would raise it
```

---

## Reference files

Read these as the investigation calls for them, not upfront:

- **`references/surface-map.md`** — every diagnostic surface, what question each
  one answers, how to read it, and what its absence means. Your fallback when
  the collector script does not fit the install.
- **`references/symptom-playbooks.md`** — ordered playbooks per symptom, with
  the specific evidence that confirms or refutes each candidate cause.
- **`references/upstream-pr.md`** — branch, fix, gate, and PR procedure,
  including what the PII/focus gate rejects and how to write the PR body.
- **`references/test-matrix.md`** — how to build a test matrix a human can
  actually run, and how to observe it without fooling yourself.

Scripts (`scripts/collect_evidence.sh`, `scripts/pr_gate.py`) accelerate the
mechanical parts. They do not replace reading the evidence and thinking about it —
when they disagree with what you can see in the files, the files win.
