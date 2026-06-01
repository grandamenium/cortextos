# Human Review Loop

## Default Behavior

When `research.delivery.requires_approval` is `true` (the default):

1. Run completes, summary written to `research/output/YYYY-MM-DD/summary.md`
2. Agent creates a cortextOS approval with `cortextos bus create-approval`
3. Agent writes `research/output/YYYY-MM-DD/PENDING-APPROVAL.md`
4. Human reviews the dashboard approval, summary, and briefs
5. If approved, agent runs delivery-routing with the existing summary

## Autonomous Mode

When `research.delivery.requires_approval` is `false`:

1. Run completes
2. Summary sent to configured destination automatically
3. No human approval needed

Use autonomous mode only after you have tuned your rubric and trust the signal quality.

## Approving Individual Briefs

The default external message is always a summary, not full brief text. To share a specific brief externally:

- Tell the agent which brief and destination.
- The agent drafts a short summary with the local brief path.
- Human approval is required before sending unless setup explicitly allows that destination.

## Feedback Loop

After reviewing briefs:
- If a signal should have scored higher: note it and adjust rubric weights
- If a signal should have been filtered: add keywords to `privacy_exclusions` or lower rubric weights
- If a source consistently produces noise: remove it from `research/sources.json`

The agent does not auto-adjust rubric weights. All rubric changes are made by the human in config.
