---
name: tool-registration
description: "A new tool has been added to the system and is not yet documented — agents do not know it exists or how to use it. This includes any new bus script, CLI binary, MCP server, external web tool or API wrapper, or any other capability an agent can invoke. You need to add it to TOOLS.md with its command, purpose, key flags, and usage examples. Or you have discovered that TOOLS.md is out of sync with what is actually available. This keeps the tool reference current so every agent can discover and use new capabilities."
---

# Tool Registration

When a new tool, CLI binary, or bus script becomes available, it must be documented in TOOLS.md so all agents know it exists.

---

## Where TOOLS.md Lives

Each agent has its own TOOLS.md in its workspace directory. All 3 templates ship with a full TOOLS.md — it is the canonical tool reference for that agent.

```
orgs/{org}/agents/{agent}/TOOLS.md
```

---

## What to Add

Every entry in TOOLS.md needs:
- **Binary/command name**
- **What it's for** (one sentence)
- **Usage pattern**
- **Key flags** (if any)
- **Example calls**

---

## Adding a New Bus Script

Bus scripts live in `$CTX_FRAMEWORK_ROOT/bus/` and are invoked as `cortextos bus <command>`.

When a new wrapper is added, add an entry in the `## Bus Scripts` section of TOOLS.md:

```markdown
### new-command
Brief description of what it does.

```bash
cortextos bus new-command <required_arg> [--optional flag]
```

- **required_arg**: What it is
- **--optional**: What it does

Example:
```bash
cortextos bus new-command "my value" --flag result
```
```

Also add it to the Quick Reference table at the bottom of TOOLS.md:
```markdown
| I need to...         | Command              |
|----------------------|----------------------|
| Do the new thing     | `new-command`        |
```

---

## Adding a New Third-Party CLI

Add a dedicated section at the bottom of TOOLS.md under the `## Third-Party Tools` heading:

```markdown
### ToolName (purpose)
- **Binary**: `toolname`
- **Use for**: What tasks it handles
- **Auth**: How to authenticate
- **Usage examples**:
  - `toolname command --flag value`
  - `toolname other-command`
- **Important**: Any gotchas or constraints
```

---

## After Updating TOOLS.md

1. Notify the orchestrator so it can update its own TOOLS.md if the tool is org-wide:
```bash
cortextos bus send-message "$CTX_ORCHESTRATOR_AGENT" normal "New tool registered in TOOLS.md: <tool name>. Update your TOOLS.md if applicable."
```

2. If it is a shared tool all agents should have, the orchestrator should broadcast to all agents.
