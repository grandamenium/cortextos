---
name: m2c1-worker
description: "You need to build software autonomously — a new project, a major feature, or any structured development task. You will act as the 'human' supervisor for a dedicated M2C1 worker session, managing it through all 12 phases: provide the brain dump, answer discovery questions, configure tools and credentials, monitor progress via bus messages and git, validate the output, and clean up when done. Use when the work is large enough to warrant a dedicated isolated build session."
---

# M2C1 Worker Agent Skill

> Any cortextOS agent can autonomously build complete software by acting as the "human" in the M2C1 framework, managing a dedicated worker Claude Code session through the full 12-phase lifecycle.

> Worker session spawn is fully implemented. Use `cortextos spawn-worker` to launch an isolated Claude Code M2C1 build session.

---

## Overview

This skill enables 3-layer agentception:
1. **You** (the cortextOS agent) act as the human/supervisor
2. **Worker** (a fresh Claude Code session) acts as the M2C1 orchestrator
3. **Subagents** (spawned by the worker) execute parallel research and tasks

You provide the brain dump, answer discovery questions, help with tool setup, monitor progress, and validate the final output. The worker does all the building.

---

## Prerequisites

- M2C1 skill files available (bundled in cortextos templates)
- A clear project idea or brain dump
- An isolated directory for the build
- Worker session spawn mechanism available (`cortextos spawn-worker`)

---

## Phase 0: Setup

### 1. Create the project directory

```bash
PROJECT_DIR="$HOME/<project-name>"
mkdir -p "$PROJECT_DIR"
cd "$PROJECT_DIR"
git init
echo "node_modules/" > .gitignore
echo ".claude/" >> .gitignore
git add .gitignore && git commit -m "init: $PROJECT_DIR"
```

### 2. Copy M2C1 skill files

```bash
mkdir -p plugins/cortextos-agent-skills/skills/m2c1/artifact-templates

# Copy from the local cortextOS framework install
for file in SKILL.md orchestration-workflow.md; do
  cp "${CTX_FRAMEWORK_ROOT}/templates/agent-codex/plugins/cortextos-agent-skills/skills/m2c1/$file" "./plugins/cortextos-agent-skills/skills/m2c1/$file"
done
```

### 3. Create the worker's inbox

```bash
mkdir -p "$CTX_ROOT/inbox/<worker-name>"
mkdir -p "$CTX_ROOT/state/<worker-name>"
```

### 4. Write BRAINDUMP.md

Write a comprehensive brain dump in `$PROJECT_DIR/BRAINDUMP.md`. Include:
- What you are building and why
- Technical requirements and constraints
- Reference implementations or existing code to study
- Any research already done
- Success criteria

### 5. Copy comms skill to worker project

The worker needs the bus messaging skill to communicate with you:

```bash
mkdir -p "$PROJECT_DIR/plugins/cortextos-agent-skills/skills/comms"
cp "$CTX_FRAMEWORK_ROOT/templates/agent-codex/plugins/cortextos-agent-skills/skills/comms/SKILL.md" "$PROJECT_DIR/plugins/cortextos-agent-skills/skills/comms/SKILL.md" 2>/dev/null
```

### 6. Set up .claude/ permission bypass

Workers write to `.claude/orchestration-*/` extensively. Set up permissions BEFORE spawning:

```bash
mkdir -p "$PROJECT_DIR/.claude"
cat > "$PROJECT_DIR/.claude/settings.json" << 'SETTINGS'
{
  "permissions": {
    "allow": [
      "Edit",
      "Write",
      "Bash"
    ],
    "allowedPaths": [
      ".claude/"
    ]
  }
}
SETTINGS
```

If the file already exists (e.g., with MCP config), merge the permissions key into it rather than overwriting.

### 7. Write AGENTS.md

Write `$PROJECT_DIR/AGENTS.md` with instructions for the worker:

```markdown
# <Project Name> - M2C1 Autonomous Build

You are building <description>.

## Your Role
You are the M2C1 orchestrator. Follow the 12-phase workflow in plugins/cortextos-agent-skills/skills/m2c1/orchestration-workflow.md.

## Communication
Send messages to <your-agent-name>:
```
cortextos bus send-message <your-agent-name> normal '<message>'
```
Check inbox:
```
cortextos bus check-inbox
```


## Stuck Detection (self-monitoring)

You must self-monitor for looping behavior. After every tool call, check: is this the same tool call I just made, with the same arguments, multiple times in a row?

If you detect the same tool call repeated 5 or more times consecutively (same tool name, same arguments):
1. Stop immediately — do not make the call again
2. Send a stuck alert to <your-agent-name>:
   ```
   cortextos bus send-message <your-agent-name> urgent 'STUCK ALERT: Detected repeated tool call loop. Tool: <tool-name>. Args: <args summary>. Repeated 5 times. Pausing for supervisor guidance.'
   ```
3. Wait for a bus message from <your-agent-name> before continuing. Check inbox:
   ```
   cortextos bus check-inbox
   ```
4. Do not resume until the supervisor responds with instructions.

Common stuck patterns to watch for:
- Repeated shell calls with the same command that keeps failing
- Repeated file reads on the same file with no subsequent action
- Repeated file edits that fail and are retried identically
- Repeated web search calls with the same query

Set environment:
```
export CTX_AGENT_NAME="<worker-name>"
export CTX_ORG="<org>"
export CTX_FRAMEWORK_ROOT="<path>"
export CTX_ROOT="$HOME/.cortextos/default"
```

When you have questions during Phase 3 (Discovery), send them via send-message. Do NOT use AskUserQuestion.

## Planning Phase (REQUIRED before any file writes)

Before writing any code or creating any project files:

1. Read BRAINDUMP.md thoroughly
2. Write PLAN.md in the project root. Include:
   - Architecture overview (what you are building, how it fits together)
   - File list (every file you plan to create or modify, with one-line purpose)
   - Task breakdown (ordered list of implementation steps)
   - Risks and open questions
3. Send PLAN.md content to <your-agent-name>:
   ```
   PLAN_CONTENT=$(cat PLAN.md)
   cortextos bus send-message <your-agent-name> normal "PLAN READY FOR REVIEW

$PLAN_CONTENT"
   ```
4. Wait for approval. Check inbox every 60 seconds:
   ```
   cortextos bus check-inbox
   ```
   Do NOT write any source files until you receive a message containing `PLAN_APPROVED`.
5. Once approved, read plugins/cortextos-agent-skills/skills/m2c1/orchestration-workflow.md and begin implementation.

## Start
1. Read BRAINDUMP.md
2. Execute the Planning Phase above
3. After PLAN_APPROVED, begin Phase 0, then Phase 1
4. Message <your-agent-name> when PRD is ready
5. Continue autonomously through all phases
```

---

## Phase 1: Spawn the Worker

```bash
WORKER_NAME="m2c1-$(basename $PROJECT_DIR)"

cortextos spawn-worker "$WORKER_NAME" \
  --dir "$PROJECT_DIR" \
  --prompt "Read AGENTS.md for your instructions, then read BRAINDUMP.md for the project spec. Begin the M2C1 workflow starting with Phase 0." \
  --parent $CTX_AGENT_NAME
```

The worker:
- Runs in `$PROJECT_DIR` with `--dangerously-skip-permissions`
- Gets `CTX_AGENT_NAME=$WORKER_NAME` so it can use `cortextos bus send-message` to reach you
- Is tracked by the daemon: `cortextos list-workers` shows its status

Log the spawn:
```bash
cortextos bus log-event action worker_spawned info \
  --meta '{"worker":"'$WORKER_NAME'","parent":"'$CTX_AGENT_NAME'","project":"'$PROJECT_DIR'"}'
```

---

## Phase 2: Monitor and Communicate

### Communication Priority
1. **Bus messages** (primary) — worker sends you updates, you reply via bus.
2. **Direct session intervention** (fallback) — only when the worker is stuck or unresponsive to bus. **Implementation pending.**
3. **Git** (monitoring) — check commits to see what was built without interrupting the worker.

### Checking Progress

```bash
# Via bus messages (worker sends updates)
cortextos bus check-inbox

# Via git (see what was built)
cd $PROJECT_DIR && git log --oneline | head -10

# Via file system (check orchestration artifacts)
ls $PROJECT_DIR/.claude/orchestration-*/
```

### Answering Discovery Questions (Phase 3)

The worker will send you questions via send-message. Answer them:

```bash
cortextos bus send-message <worker-name> normal '<your answers>'
```

Base your answers on:
- The original brain dump requirements
- Any research you have done
- Your domain knowledge as a cortextOS agent
- The org's goals and constraints (GOALS.md, knowledge.md)

If you do not know the answer, make a reasonable decision and note it. Do not block the worker with "ask the user" unless it is truly a human-only decision.


### Reviewing the Worker's Plan (REQUIRED before worker proceeds)

The worker will send a `PLAN READY FOR REVIEW` message with the full PLAN.md content before writing any files. You must review it and respond.

**Review checklist:**
- Architecture makes sense for the requirements in BRAINDUMP.md
- File list is complete — no obvious missing pieces
- Task order is logical — dependencies resolved before dependents
- No scope creep — worker isn't building more than asked
- Open questions are addressed or explicitly deferred

**To approve:**
```bash
cortextos bus send-message <worker-name> normal 'PLAN_APPROVED. Proceed with implementation.'
```

**To request changes:**
```bash
cortextos bus send-message <worker-name> normal 'PLAN_REJECTED. Revise: <specific feedback>. Resend when updated.'
```

The worker will not write any source files until it receives `PLAN_APPROVED`. Do not leave it waiting — review promptly.

### Handling Stuck States

If the worker appears stuck (no bus messages, no new git commits > 15 minutes):

1. Send a bus message: `cortextos bus send-message <worker-name> normal 'Continue with the M2C1 workflow. What phase are you on?'`
2. Check git: `cd $PROJECT_DIR && git log --oneline | head -5`
3. Inject directly into the PTY if still unresponsive: `cortextos inject-worker <worker-name> "Continue with the M2C1 workflow. What phase are you on?"`
4. Check worker status: `cortextos list-workers`
5. If halted: `cortextos terminate-worker <worker-name>` then re-spawn


### Handling Worker Stuck Alerts (worker-initiated)

The worker self-monitors for repeated tool call loops and will send you a `STUCK ALERT` message proactively when it detects one. These arrive as urgent priority bus messages.

**When you receive a STUCK ALERT:**

1. Read the alert carefully — it includes the tool name and arguments that are looping
2. Diagnose the cause:
   - Permission error? The tool may need a different approach
   - File not found? The path may be wrong — check it
   - Infinite retry on a transient error? Tell worker to skip and continue
   - Wrong approach entirely? Redirect with a different strategy

```bash
# If the approach is wrong — redirect:
cortextos bus send-message <worker-name> normal 'Understood. Stop that approach. Instead: <alternative>. Continue from there.'

# If it is a transient error — tell worker to skip:
cortextos bus send-message <worker-name> normal 'Skip that step for now and continue to the next task. We will revisit.'

# If you need to inspect first:
cd $PROJECT_DIR && git log --oneline | head -5
# Then respond with a specific directive
cortextos bus send-message <worker-name> normal '<directive>'
```

**Do not send a generic 'continue' message.** The worker is paused because it is genuinely stuck — it needs a specific direction change, not permission to loop again.

---

## Phase 3: Tool Setup Support (CRITICAL - Act Like a Human)

This is one of the most important phases. You act exactly like a human developer setting up a project: installing tools, configuring MCPs, setting env variables, logging into services, testing that everything works. The worker cannot do this itself — it needs you to configure its environment.

### Think Holistically About Tools

Before the worker starts building, ask yourself:
- What MCPs would help? (Playwright for browser testing, etc.)
- What accounts/services does the project need? (APIs, hosting, etc.)
- What CLI tools should be installed? (expo, vercel, railway, etc.)
- What env variables does the worker need? (API keys, tokens, etc.)
- What skills could help the worker? (existing cortextOS skills)
- What testing tools are needed? (iOS Simulator, Playwright, etc.)

### MCP Configuration

```bash
# 1. Create or update the worker's MCP config
mkdir -p "$PROJECT_DIR/.claude"
# For browser automation, use the agent-browser CLI (replaces the
# previous Playwright MCP server). Install once on the worker host:
which agent-browser || npm install -g agent-browser
agent-browser install   # Downloads Chrome from Chrome for Testing

# Copy the agent-browser SKILL.md into the worker's plugins/cortextos-agent-skills/skills/ so
# it is teachable to the worker session:
mkdir -p "$PROJECT_DIR/plugins/cortextos-agent-skills/skills/agent-browser"
cp "$CTX_FRAMEWORK_ROOT/templates/agent-codex/plugins/cortextos-agent-skills/skills/agent-browser/SKILL.md" \
   "$PROJECT_DIR/plugins/cortextos-agent-skills/skills/agent-browser/SKILL.md"

# 2. Worker can use agent-browser via Bash (no MCP restart required):
cortextos bus send-message <worker-name> normal \
  'agent-browser is available globally. Test by running: agent-browser open https://example.com && agent-browser get title && agent-browser close. Use snapshot-then-ref pattern for AI-driven flows. The plugins/cortextos-agent-skills/skills/agent-browser/SKILL.md was added — invoke `agent-browser skills get <name>` for current per-version command syntax.'
```

### Iterative Tool Verification

Do NOT assume tools work after installation. For each tool:
1. Install/configure it in the project directory
2. Tell the worker via bus to restart and test the tool
3. Worker reports result via bus
4. If failed: fix config, repeat
5. If succeeded: move to next tool

### Environment Variables and Credentials

```bash
# Check what is available
grep -v "^#" "$CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/.env" | cut -d= -f1

# Write a .env file the worker can source
cat > "$PROJECT_DIR/.env" << 'EOF'
ANTHROPIC_API_KEY=<from org .env>
GEMINI_API_KEY=<from org .env>
EOF
chmod 600 "$PROJECT_DIR/.env"

# Tell the worker via bus to source it
cortextos bus send-message <worker-name> normal 'Source .env in your project dir before running any API calls.'
```

### Skills for the Worker

Copy relevant cortextOS skills to the worker's project:
```bash
# If the worker needs browser automation knowledge, the agent-browser skill
# is already in templates/agent-codex/plugins/cortextos-agent-skills/skills/agent-browser/SKILL.md and
# was copied into $PROJECT_DIR above during MCP/tool setup.
```

---

## Phase 4: Autonomous Execution

Once the worker is past discovery and tool setup, it should run autonomously:

### Set Up Auto-Iteration

Register a daemon cron on the worker so it polls its task queue every 10 minutes:
```bash
cortextos bus add-cron <worker-name> task-poll 10m \
  'Check START.md for pending tasks. If not working on a task, pick the next one.'
```

This survives worker restart, works on both `claude-code` and `codex-app-server` runtimes, and the daemon owns dispatch — no session-local schedulers required.


### Periodic Check-ins

Check in every 30-60 minutes:
```bash
# Check bus for worker updates
cortextos bus check-inbox

# Check git progress
cd $PROJECT_DIR && git log --oneline | head -5

# Check orchestration progress
cat $PROJECT_DIR/.claude/orchestration-*/PROGRESS.md 2>/dev/null | tail -20
```

### When NOT to Intervene
- Worker sent a bus update and is actively building
- Worker is in a research subagent phase
- Worker sent you a question and is waiting — check inbox first

### When to Intervene
- No bus messages AND no new git commits > 15 minutes
- Worker is looping on the same error (reported via bus)
- Worker went off-scope (building wrong thing)

---

## Phase 5: Validate the Output

### Synergy Review (before execution)
Verify the worker's task files are coherent:
```bash
ls $PROJECT_DIR/.claude/orchestration-*/tasks/
# Read a few task files — do they reference each other correctly?
# Are there gaps? Overlaps?
```

### Per-Task Testing
After each phase of execution, verify:
```bash
# Do tests pass?
cd $PROJECT_DIR && npm test 2>/dev/null

# Does it build?
cd $PROJECT_DIR && npm run build 2>/dev/null

# Check git for clean commits
git log --oneline | head -10
```

### Final E2E Testing
The worker's last phase should be comprehensive testing. Verify:
1. The software actually runs
2. It connects to real systems (if applicable)
3. Core user flows work end-to-end
4. Edge cases are handled

If tests fail, tell the worker:
```bash
cortextos bus send-message <worker-name> normal \
  'E2E test failed: <specific failure>. Fix it and re-test.'
```

---

## Phase 6: Cleanup

### On Success
```bash
# Log the milestone
cortextos bus log-event milestone m2c1_complete info \
  --meta '{"project":"<name>","location":"<path>","tasks":<count>,"tests":<count>}'

# Notify orchestrator
cortextos bus send-message $CTX_ORCHESTRATOR_AGENT normal \
  'M2C1 build complete: <project>. Location: <path>. <summary>'

# Clean up worker inbox
rm -rf "$CTX_ROOT/inbox/<worker-name>"
rm -rf "$CTX_ROOT/state/<worker-name>"

cortextos terminate-worker "$WORKER_NAME"
```

### On Failure
```bash
# Log what happened
cortextos bus log-event action m2c1_failed info \
  --meta '{"project":"<name>","phase":"<where it failed>","reason":"<why>"}'

# Keep the directory for debugging
# Report to orchestrator
cortextos bus send-message $CTX_ORCHESTRATOR_AGENT normal \
  'M2C1 build FAILED: <project>. Failed at phase <N>. Reason: <why>. Directory preserved at <path>.'
```

---

## Key Principles

1. **You are the human.** The worker treats you as the decision-maker. Answer questions decisively.
2. **Do not micro-manage.** Let the worker run. Check in periodically, not constantly.
3. **Intervene on stuck states.** If the worker is blocked > 15 minutes, help it via bus message.
4. **Validate at phase gates.** Check PRD, discovery, task plans, and final output.
5. **The worker spawns its own subagents.** You do not manage them directly.
6. **Keep the scope tight.** If the worker goes off-scope, redirect it immediately.
7. **Testing is non-negotiable.** Do not accept "it should work" — verify it works.
8. **Log everything.** Tasks, events, milestones. Invisible work does not exist.

---

## Anti-Patterns

- **Doing the work yourself** instead of letting the worker do it
- **Answering "ask the user"** for decisions you can make (only escalate truly human-only decisions)
- **Not checking the worker** for hours (it may be stuck)
- **Skipping the synergy review** (tasks will conflict)
- **Accepting untested output** (always verify E2E)
- **Running multiple workers in the same directory** (git conflicts)
