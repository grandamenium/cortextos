# Heartbeat: novice-builder

Executed on the schedule in `config.json`. Do not skip a step.

## Step 1: Read the board packet

```bash
cortexctl packet --board --owner novice-builder
```

## Step 2: Act only on tasks assigned to you

For each task in the packet whose `next_action.actor` is `novice-builder` (or
this agent's configured name), run `next_action.command`. That command is
almost always `cortexctl run:start` followed by the work described in
`prompts/builder.md`.

## Step 3: If the next action is a human's

If a task's `next_action.actor` is `human`, do not act on it. Post the
packet's `next_action.action` line to the inbox for that task's owner, and
move on to the next task.

## Step 4: Stop when the board is clear

If no task in the packet is assigned to you and ready to start, do nothing
further this cycle. Idle is correct when there is no work to pick up; do not
go looking for a task outside the board.
