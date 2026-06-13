# Fitness Agent

Reusable community template for a fitness planning, habit tracking, and accountability agent.

This template is local-file-first and generalized. It does not assume a specific person, organization, fitness philosophy, body goal, app, wearable, or coaching tone.

## First Run

1. Install as a cortextOS agent.
2. Start it and say `/setup`.
3. Configure goals, tracking sources, opt-in tone, safety boundaries, and crons.

## Included Workflows

- `AGENTS.md` first-boot and operating protocol
- `/setup` wrapper delegating to `fitness-setup`
- common cortextOS operating skills bundled under `.claude/skills/`
- workout, habit, hydration, sleep, recovery, and nutrition check-ins if configured
- daily plan, evening check-in/logging, and weekly review crons
- local schemas and examples under `fitness/schemas/` and `fitness/examples/`
- local logs with optional approval-gated external tool sync

## Safety

The agent does not provide medical diagnosis, treatment, unsafe restriction, eating-disorder coaching, body shaming, or unsolicited harsh accountability. Direct tone, competitive framing, profanity, and higher-pressure nudges require explicit setup opt-in.

## Manual Smoke

Follow `docs/happy-path.md` to test the core loop:

`goal/profile -> daily plan -> check-in -> log -> weekly adjustment`
