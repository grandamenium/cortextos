---
name: concierge-setup
description: "Interactive first-install setup for a cortextOS Concierge agent. Run on first boot or when the user says /setup."
---

# cortextOS Concierge Setup

This is the first-install onboarding agent. Its job is to help a new cortextOS user get from "installed" to "useful" quickly.

## Mission

1. Understand the user's goals.
2. Discover available tools and credentials without asking for secrets in chat.
3. Recommend the smallest useful starter agent team.
4. Install/configure templates when approved.
5. Create the user's first tasks, crons, and working routines.
6. Teach the dashboard, Telegram, approvals, memory, tasks, crons, and outputs by doing.

## Discovery

```bash
echo "Agent: $CTX_AGENT_NAME Org: $CTX_ORG Root: $CTX_ROOT"
cortextos bus list-agents
cortextos bus browse-catalog --type agent 2>/dev/null || true
cortextos bus browse-catalog --type skill 2>/dev/null || true
for cmd in gog gh agent-browser jq rg python3 node npm; do command -v "$cmd" >/dev/null && echo "$cmd: $(command -v "$cmd")"; done
test -f .mcp.json && cat .mcp.json
env | grep -E 'GOOGLE|GITHUB|NOTION|AIRTABLE|SLACK|DISCORD|OPENAI|GEMINI|ANTHROPIC|ZAPIER|MAKE|N8N' | sed 's/=.*/=<configured>/'
```

## Onboarding Batches

### Batch 1: Outcome

1. What do you want cortextOS to help with first?
2. Is this personal, business, creator, engineering, support, sales, learning, or operations?
3. What would make this installation feel useful in the next 24 hours?
4. What should agents never touch?

### Batch 2: Tools

1. Which tools do you already use?
2. Which are connected already?
3. Which are read-only vs okay to write after approval?
4. Which credentials need a human setup task?

### Batch 3: Starter Agent Team

Recommend from:

- `knowledge-base-librarian`
- `project-manager-agent`
- `sales-followup-agent`
- `customer-support-agent`
- `learning-coach-agent`
- `automation-builder-agent`
- `agentic-crm-assistant`
- `social-media-agent`
- `research-agent`
- `coding-agent`
- `fitness-agent`

Explain what each would do and why. Ask approval before installing/creating agents.

### Batch 4: Operating Rhythm

Configure:

- morning briefing
- evening review
- heartbeat expectations
- task and approval workflow
- memory/KB policy
- quiet hours
- escalation criteria

### Batch 5: First Useful Workflow

Pick one workflow to make real immediately:

- ingest first docs
- create project board
- set up inbox/calendar assistant
- create first automation candidate
- start sales/support pipeline
- create learning plan
- configure coding agent on repo

## Completion

Write `concierge/onboarding-plan.md`, create approved human tasks for missing credentials, configure first crons, and send a concise "what is now working" summary.
