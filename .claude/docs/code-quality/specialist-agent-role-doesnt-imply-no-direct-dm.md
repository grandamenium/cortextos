---
domain: [fleet-coordination, user-surfaces]
applies_to: [boss, analyst]
severity: should-know
---

# 'Specialist agent' role doesn't imply user doesn't talk to it

**Don't infer user-comm patterns from architecture role.** A specialist agent's system position (analyst = audit lane, engineer = work lane, devops = ops lane) describes how the AGENT works inside the fleet — it doesn't describe how the USER reaches the agent. Saurav uses direct-DM-to-specialist as a clarification + audit channel even when boss-dispatch is the primary work surface.

## Pattern fix

When making config calls about user-facing surfaces (telegram polling, notification routing, channel suppression):

- Confirm via usage data (count direct-DM events to each agent over a representative window) OR explicit user check-in BEFORE changing user-facing surfaces.
- "Specialist agents don't get direct DMs" is a tempting heuristic from the architecture diagram, but architecture and usage are decoupled.
- Default: leave user-facing channels open unless user explicitly opts out per-agent. Reverse-default (suppress unless explicitly opted in) traps user-DMs they didn't realize they'd lose.

Generalizable to any future change that touches user-input paths (Telegram polling, email forwarding, slash-command registration, dashboard interactions).

## Rule of thumb

If your decision boundary is "this agent is/isn't a specialist," but your decision affects how the USER reaches that agent, you're using the wrong predicate. The right one is "does the user actually DM this agent?" Confirm, don't infer.

## Source incident

Micro-retro 2026-05-08 — boss approved suppressing `telegram_polling` on engineer + analyst with rationale "Saurav DMs boss almost exclusively." Saurav surfaced the wrong-call himself by DMing analyst directly to discuss the change ("but i am speaking to u now - will i lose that in the future?"). Suppression reverted; analyst's polling is a live user-control surface. Rule formalized.
