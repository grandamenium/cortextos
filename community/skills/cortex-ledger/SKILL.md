---
name: cortex-ledger
description: "Work a cortex-ledger task the way the ledger expects: read the board, start the run before touching files, and close out with the artifacts the guards check for."
triggers: ["opening a task", "starting work on an issue or PR", "reporting completion", "asking what to do next", "asking why an agent stalled"]
external_calls: []
---

# Cortex Ledger

Operating procedure for an agent that works inside a repository managed by
`cortextos-ledger`. Follow it verbatim; do not improvise a substitute for any
step. Everything here maps to a real `cortexctl` command, never to editing the
database directly.

## When to Use

Load this skill whenever you are about to pick up a task from the board,
whenever you are about to start editing files in a repository that has a
`cortex-ledger.json` or a `.cortex/ledger.db`, whenever you finish a piece of
work and need to report it, or whenever you are unsure what to do next on a
task you were assigned.

## Workflow

### Step 1: Read the board before doing anything

```bash
cortexctl packet --board --owner <your agent id>
```

Act only on tasks assigned to you. If the packet's `next_action.actor` is
`human`, do not proceed: post the packet's next action line to the inbox and
stop. That task is not yours to move forward.

### Step 2: Start the run before you touch a single file

```bash
cortexctl run:start --task <task id> --agent <your agent name>
```

This is not optional and not a formality. `run:start` is where the ledger
checks your attempt count and the task's spend against the hard limits, and
where preflight checks the worktree is clean and free of secrets. A non-zero
exit here means stop: read the message, do not work around it, and do not
touch the worktree until the reason is resolved. Print and keep the run id
this command gives you; every following command needs it.

### Step 3: Do the work

Follow the brief at `<runs>/<task-id>/brief.md` and the rules in
`prompts/builder.md` or `prompts/reviewer.md`, whichever role you are. Two
conventions apply everywhere in this kit, in any role:

- If a tool is broken or returns an error you do not understand, stop and
  report it: write `BLOCKED: <tool> <error>` in your output and stop. Do not
  invent a workaround.
- If the fix needs more files than your file cap allows, stop and write
  `SCOPE_EXCEEDED` with the file list instead of continuing.

### Step 4: Record what you did

```bash
cortexctl run:end --run <run id> --exit <code> --cost <usd> --summary "<one line>"
cortexctl artifact --task <task id> --run <run id> --kind diff --path patch.diff
cortexctl test --task <task id> --run <run id> --suite "<name>" --status pass
```

Run `test` once per suite you ran. `run:end` is what triggers the post run
guards (files touched, test edits, missing patch), so it comes before you
consider the run finished, not after.

## Notes / Edge Cases

- Never call `cortexctl task:close` yourself. The owner named on the task
  closes it, after reading your summary and the test results. Reporting
  completion is `run:end` plus `artifact` plus `test`; closing the task is a
  separate, human decision.
- If `run:start` refuses with a retry limit, do not retry with a different
  flag to get around it. A human authorizes one more attempt with
  `cortexctl task:resolve --retry-authorized`, and that is their call, not
  yours.
- A reviewer agent following this skill never opens anything under a
  `builder/` directory. That rule lives in `prompts/reviewer.md` and in the
  filesystem layout itself; this skill does not repeat the review protocol,
  it only tells you how to start and end the run around it.
