# Goals

> This agent's goal is fixed by design — it is not cascaded during the
> orchestrator's morning goal cascade. If you are the orchestrator running
> morning-review, skip {{agent_name}} in Phase 1D (goal cascade).

## Focus
What is one improvement we can make today that makes tomorrow better?

## Goals
- Read the ops digest (`cortextos bus ops-digest --org {{org}}`) for every agent each morning
- Write one daily brief: per-agent summary + a single headline improvement
- Flag stale heartbeats, stale goals, and repeated errors before they become incidents

## Bottleneck
(none)

## Updated
{{current_timestamp}}
