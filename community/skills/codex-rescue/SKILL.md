# codex-rescue

Delegate a stuck task to Codex via `codex exec` for a fresh perspective. Use when Claude is going in circles — tried three approaches, each failed for a different reason, and you suspect the framing is wrong, not the execution.

Codex returns a suggested approach (sometimes with code). The invoking agent decides whether to apply, adapt, or discard. The skill is a delegation primitive, not a fix-and-merge wrapper.

**Trigger phrases:**
- "delegate to codex"
- "/codex-rescue"
- "/codex-rescue <one-line problem statement>"

---

## When to use

- **Stuck after 3+ failed approaches.** When the agent has tried the obvious paths and each broke a different way, the framing is often wrong. Fresh perspective unsticks.
- **Pre-implementation: "is this even the right shape?"** When designing something non-trivial, run the design past Codex before writing it.
- **Debugging a bug nobody owns.** Race condition, intermittent failure, "works on my machine" — sometimes a different model spots what yours normalised.
- **When the user explicitly asks for a second opinion.** "What would Codex say about this approach?" → run the skill.

**When NOT to use:**
- After one failed attempt. The first failure is usually a missing piece of information, not the wrong framing.
- For code review on completed work. Use `dual-review` or `adversarial-review` — those are review skills; `codex-rescue` is a design/debug skill.
- As a substitute for thinking. The skill is "I have explored and am stuck"; not "I haven't started and want Codex to do it for me."
- For tasks under ~15 lines of code. The overhead of capturing context exceeds the value at that size.

---

## Prerequisites

```bash
if ! command -v codex >/dev/null 2>&1; then
  echo "abort: codex CLI not installed. Install: npm i -g @openai/codex" >&2
  exit 1
fi

if ! codex login status >/dev/null 2>&1; then
  echo "abort: codex not authenticated. Run: codex login" >&2
  exit 1
fi
```

No fallback — Codex IS the rescuer. If unavailable, the skill aborts.

---

## Setup

```bash
PROBLEM="${1:?usage: /codex-rescue <one-line problem statement>}"
TS=$(date -u +%Y-%m-%dT%H%M%SZ)
SESSION_DIR="reviews/rescue-${TS}"
mkdir -p "$SESSION_DIR"

# Capture context that Codex needs to be useful
git log --oneline -10 > "$SESSION_DIR/recent-commits.txt"
git diff > "$SESSION_DIR/uncommitted.diff"
git status -s > "$SESSION_DIR/status.txt"
```

Add `reviews/` to `.gitignore` as a one-time setup (same convention as other skills).

---

## Stage 1: Capture the problem framing

The invoking agent assembles the rescue prompt. The prompt must include:

1. **What the agent is trying to accomplish** (the goal, in user-language).
2. **What the agent has tried**, with results. Each attempt: approach + why it failed.
3. **Relevant code excerpts** — the function or module the agent is stuck in, including file paths and line numbers.
4. **The specific question** — "should I take a different approach?", "is there a pattern I'm missing?", "is this code structurally wrong?"

Template (substitute the placeholders before passing to Codex):

```
Goal: <one-sentence user-language goal>

What I've tried:
1. <approach 1>: <why it failed>
2. <approach 2>: <why it failed>
3. <approach 3>: <why it failed>

Relevant code:
<file path>:<line range>
```
<code excerpt>
```

Question: <specific question for Codex>

Constraints:
- <e.g. "must work in Node 18+, no native deps">
- <e.g. "must not change the public API of foo()">
- <e.g. "must be idempotent">
```

Write the assembled prompt to `$SESSION_DIR/prompt.txt`.

---

## Stage 2: Run codex exec

```bash
codex exec - < "$SESSION_DIR/prompt.txt" > "$SESSION_DIR/response.md" 2>&1
```

`codex exec` runs codex non-interactively. Reading the prompt from stdin lets you pass arbitrary content without bash quoting headaches.

For long-running rescues (Codex exploring the repo), this can take 30-120 seconds. The skill blocks until done.

---

## Stage 3: Triage Codex's response

Codex returns one of:

- **A specific approach with code.** Read it, decide whether the approach is right for the project. Common outcome: approach is right, code needs adapting to project conventions.
- **A diagnosis of why the current approach won't work.** Useful as a stuck-unstucker even without a fix.
- **A clarifying question back.** Codex didn't have enough context. Update the prompt with the missing info and re-run, OR escalate to user.
- **Generic best-practice advice that doesn't match your context.** Codex doesn't know your CLAUDE.md or `.claude/rules/`. Discard.

Classify the response:

| Classification | Meaning | Next action |
|---|---|---|
| **APPLY** | Codex's approach is right; will adapt to project conventions | Implement; commit; reference rescue session in commit message |
| **PARTIAL** | Some of Codex's diagnosis is useful; the proposed fix isn't | Cherry-pick the diagnosis; re-think the fix |
| **DISCARD** | Codex's response doesn't help (wrong context, generic advice, hallucinated facts) | Note in triage.md why; don't apply |
| **CLARIFY** | Codex needs more info to be useful | Update prompt, re-run |
| **ESCALATE** | Stuck even after Codex; needs user input | Surface to Saurav with what was tried |

Append to `$SESSION_DIR/triage.md`:

```
APPLY: Codex suggested using a queue with idempotency keys; matches our existing pattern in src/idempotency.ts. Adapting to project naming conventions.
DISCARD: Codex suggested adding a try/catch around the entire function — defeats the boundary-validation pattern from 03-code-quality/error-handling.md.
```

---

## Stage 4: Implement (if APPLY)

If applying Codex's approach, implement it AS IF YOU CAME UP WITH IT — adapt to project conventions, naming, file structure. Don't paste Codex's code verbatim; it doesn't know your CLAUDE.md.

Commit message references the rescue:

```bash
git add -u
git commit -m "$(cat <<EOF
fix: <description of fix>

Approach unstuck by codex-rescue session at $SESSION_DIR.
Prior attempts (failed): <one-line summary of 1-3 things tried>.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

The commit message names the rescue so a future bisecter can find the session if needed.

---

## Output structure

```
reviews/rescue-<TS>/
  recent-commits.txt    # context: what's been happening in this branch
  uncommitted.diff      # context: what the agent had in flight
  status.txt            # context: working-tree state
  prompt.txt            # the assembled rescue prompt
  response.md           # raw Codex response
  triage.md             # APPLY / PARTIAL / DISCARD / CLARIFY / ESCALATE classification
```

The session dir is local-only audit (gitignored).

---

## Cost

One `codex exec` call per rescue. Longer than a `codex review` because Codex explores the repo and reasons through the problem. Typical run: 30-120 seconds, ~5x the cost of a `codex review` invocation.

Reserve for genuinely-stuck moments. If you find yourself running `/codex-rescue` more than ~3x per day, the underlying problem is probably brief design (`08-llm-and-agents/brief-design.md`) — the agent isn't getting clear enough goals.

---

## Anti-patterns

- **Running codex-rescue on first failure.** Try the obvious paths first; rescue is for genuine "I've tried 3+ things" moments.
- **Pasting Codex's code verbatim.** It doesn't know your conventions; you'll ship inconsistent code.
- **Treating Codex's response as authoritative.** It's a fresh perspective, not a verdict. Triage applies; some responses are wrong.
- **Skipping context capture.** A rescue prompt without "what I've tried" produces generic advice. Be specific about prior attempts and why they failed.
- **Using rescue for code review.** Use `dual-review` or `adversarial-review` for review; rescue is for design/debug.
- **Chaining rescues** ("Codex's response didn't help, let me run rescue again with more context"). Past 1 retry, escalate to user — the stuck signal is real.

---

## Source

- OpenAI Codex CLI: `codex exec` (https://developers.openai.com/codex/cli)
- `codex-plugin-cc`'s `/codex:rescue` slash command (the inspiration; this skill replicates the pattern via direct CLI for agent-callability)
- Companion: `community/skills/dual-review/SKILL.md` (balanced review), `community/skills/adversarial-review/SKILL.md` (focused pressure-test)
