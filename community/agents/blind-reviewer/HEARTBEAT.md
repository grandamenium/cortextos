# Heartbeat: blind-reviewer

Executed on the schedule in `config.json`. Do not skip a step.

## Step 1: Read the board packet

```bash
cortexctl packet --board --owner blind-reviewer
```

## Step 2: Act only on tasks assigned to you

For each task in the packet whose `next_action.actor` is `blind-reviewer` (or
this agent's configured name), read `next_action.command` and run it. That
command is almost always a `cortexctl review:brief` followed by producing a
`verdict.json`, per `prompts/reviewer.md`.

## Step 3: If the next action is a human's

If a task's `next_action.actor` is `human`, do not act on it. Post the
packet's `next_action.action` line to the inbox for that task's owner, and
move on to the next task.

## Step 4: Stop when the board is clear

If no task in the packet is assigned to you and needs a reviewer, do nothing
further this cycle. Idle is the correct state when there is no review to do;
do not go looking for work outside the board.
