---
name: onboarding
description: "You have just booted for the first time — there is no .onboarded flag in your state directory — and you need to set up your identity, connect your Telegram bot, configure your goals, and establish yourself within the org. Or onboarding was previously interrupted and the user has asked you to run it again. This skill walks you through every step of becoming a functioning agent. Do not skip steps. Do not start normal operations until onboarding is complete."
triggers: ["onboarding", "/onboarding", "first boot", "run onboarding", "setup", "not onboarded", "configure agent", "set up identity", "establish identity", "set goals", "onboard me", "start onboarding", "redo onboarding", "onboarding interrupted", "first time setup", "initial setup", "agent setup"]
---

# Onboarding

This skill runs on first boot or when explicitly triggered. It is the only thing you should do until it is complete.

---

## Step 1: Check onboarding status

```bash
[[ -f "${CTX_ROOT}/state/${CTX_AGENT_NAME}/.onboarded" ]] && echo "ONBOARDED" || echo "NEEDS_ONBOARDING"
```

If already `ONBOARDED`, skip to normal session start. Do not re-run onboarding unless the user explicitly requests it.

---

## Step 2: Read ONBOARDING.md

```bash
cat ONBOARDING.md
```

This file contains the full onboarding protocol for your specific agent role. Follow every step exactly. Do not improvise.

---

## Step 3: What onboarding establishes

Onboarding must complete all of the following before you are considered functional:

| Item | File written |
|------|-------------|
| Your name, role, emoji, and identity | `IDENTITY.md` |
| Your behavior, autonomy rules, and mode | `SOUL.md` |
| Your current goals and focus | `GOALS.md` |
| User preferences and context | `USER.md` |
| Guardrails and patterns to avoid | `GUARDRAILS.md` |
| Telegram bot connected and tested | `.env` (BOT_TOKEN, CHAT_ID) |
| Crons configured and running | `config.json` |
| Knowledge base ingestion rules set | `.claude/skills/memory-management/SKILL.md` |
| KB initial ingestion done | `cortextos bus kb-ingest` |
| Migration from previous agent (if applicable) | memory files copied |
| Autoresearch cycle offered | `experiments/config.json` (optional) |
| .onboarded flag written | `$CTX_ROOT/state/$CTX_AGENT_NAME/.onboarded` |

---

## Step 4: Mark complete

When all steps in ONBOARDING.md are done:

```bash
mkdir -p "$CTX_ROOT/state/$CTX_AGENT_NAME"
touch "$CTX_ROOT/state/$CTX_AGENT_NAME/.onboarded"
```

Then notify the user via Telegram that you are online and ready.

---

## If Onboarding Is Interrupted

If a session crash or restart interrupts onboarding mid-way:

1. Check which steps completed (look at which files exist)
2. Resume from the first incomplete step
3. Do NOT restart from the beginning if some steps already completed
4. Re-run `/onboarding` if needed to trigger this skill again

---

## Critical Rules

- Do NOT send a Telegram message claiming you are online until onboarding is complete
- Do NOT set up crons until IDENTITY.md and GOALS.md are written
- Do NOT start processing user requests until `.onboarded` is written
- The user is waiting — be efficient, but do not skip steps
