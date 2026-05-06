# Project Setup

> Scaffolds a complete AI-assisted development environment for a new project.
> Implements the 9-step pre-build framework: PRD → CLAUDE.md → agents/skills/MCPs →
> path rules → negative constraints → progress/learnings files → TDD → issue tracking → load testing.

Trigger: "Run project setup" or "/project-setup" or "Set up this project for AI development"

---

## What This Skill Builds

```
project-root/
├── CLAUDE.md                    # Agent instructions (auto-generated, links everything)
├── docs/
│   ├── prd.md                   # Product Requirements Document (filled via interview)
│   ├── progress.md              # Feature completion tracker
│   ├── learnings.md             # Error log and fixes
│   ├── constraints.md           # Negative constraints (what NOT to do)
│   └── rules/
│       └── [component].md       # Path-specific rule files (one per major area)
└── tests/
    └── [spec-derived tests]     # Written from PRD before implementation
```

---

## Phase 0: Identify Project Root

```bash
# Confirm where we are
pwd
ls -la

# If not in the project root, ask the user:
# "What directory should I set this up in?"
```

Set `$PROJECT_ROOT` to the confirmed directory. All files write here.

---

## Phase 1: PRD Interview

Do NOT skip this phase. Do not assume requirements.

Ask the user these questions one at a time (wait for each answer before asking the next):

1. **What does this project do?** (one-paragraph description)
2. **Who are the users?** (persona, technical level, size)
3. **What are the 3-5 core features?** (list them)
4. **What should it NOT do?** (scope boundaries, out-of-scope features)
5. **What tech stack?** (languages, frameworks, database, hosting)
6. **How many simultaneous users do you expect at launch?**
7. **What does success look like?** (key metrics or user outcomes)
8. **What integrations are needed?** (external APIs, services, MCPs)

After collecting answers, write `docs/prd.md`:

```markdown
# Product Requirements Document

## Overview
[one-paragraph from answer 1]

## Users
[from answer 2]

## Core Features
[numbered list from answer 3]

## Out of Scope
[from answer 4]

## Tech Stack
[from answer 5]

## Scale Target
[from answer 6 — number of simultaneous users]

## Success Criteria
[from answer 7]

## Integrations
[from answer 8]

## Implementation Phases
Phase 1: [core features — MVP]
Phase 2: [secondary features]
Phase 3: [scale and polish]
```

---

## Phase 2: Negative Constraints File

Ask the user:
- "What should the agent absolutely NOT do on this project? Think about design choices, libraries to avoid, patterns to never use, things that are out of scope."

Write `docs/constraints.md`:

```markdown
# Negative Constraints

This file defines what the agent must NOT do on this project.
Reference this file frequently. When in doubt, do NOT implement — ask first.

## Design
- [from user input]
- Do not use AI-generated default color schemes without explicit approval

## Architecture
- [from user input]

## Libraries / Dependencies
- [from user input]

## Scope
- [from user input — out-of-scope features]

## Behavior
- Do not commit without running the test suite
- Do not modify files outside the project root without explicit instruction
- Do not add dependencies not present in the PRD without asking first
```

---

## Phase 3: Path-Specific Rules

Ask the user:
- "What are the major sections of this codebase? For example: frontend, API, database, auth, etc."

For each section they name, create `docs/rules/[section].md`:

```markdown
# [Section] Rules

**Applies to:** [path pattern, e.g., src/components/**, app/api/**]

## Conventions
[Ask user: "Any specific conventions for the [section] layer?"]

## Patterns to Use
[Ask user: "What patterns or approaches should the agent always use here?"]

## Patterns to Avoid
[Ask user: "What should the agent never do in this section?"]

## Key Files
[Agent fills this in as the codebase grows]
```

If the user has no specific conventions yet, create skeleton files with the structure and note "To be filled in — add rules here as you discover what the agent needs to know."

---

## Phase 4: Progress and Learnings Files

Write `docs/progress.md`:

```markdown
# Project Progress

Last updated: [date]

## Completed
_(nothing yet — agent updates this after every feature implementation)_

## In Progress
_(agent updates this when starting a feature)_

## Pending
[List all Phase 1 features from PRD here as unchecked items]
- [ ] [Feature 1]
- [ ] [Feature 2]
- [ ] [Feature 3]

## Blocked
_(agent lists blockers here with context)_
```

Write `docs/learnings.md`:

```markdown
# Project Learnings

A running log of errors, unexpected behavior, and how they were resolved.
Agent: add an entry every time you fix a non-trivial bug.

## Format
### [Date] — [Brief description]
**What happened:** [symptom]
**Root cause:** [why it happened]
**Fix:** [what resolved it]
**Prevention:** [how to avoid this in future]

---
_(no entries yet)_
```

---

## Phase 5: Generate CLAUDE.md

Write `CLAUDE.md` at the project root. Do NOT use `claude init` — write it directly.

```markdown
# [Project Name] — Agent Instructions

## Project Overview
[One-sentence from PRD overview]

## Required Reading (read these before starting any task)
- [docs/prd.md](docs/prd.md) — Full product requirements and implementation phases
- [docs/constraints.md](docs/constraints.md) — What you must NOT do
- [docs/progress.md](docs/progress.md) — Current implementation status
- [docs/learnings.md](docs/learnings.md) — Known issues and fixes

## Path-Specific Rules
[For each rules file created in Phase 3:]
- [docs/rules/[section].md](docs/rules/[section].md) — Rules for [path pattern]

## Coding Conventions
[From tech stack and any user-specified conventions]
- Language: [from PRD]
- Framework: [from PRD]
- [Any specific style rules the user specified]

## Mandatory Behaviors
- After implementing any feature: update `docs/progress.md`
- After fixing any non-trivial bug: add an entry to `docs/learnings.md`
- Before starting any task: check `docs/progress.md` to confirm it is not already done
- Commit after every completed feature using conventional commit format: `feat|fix|refactor|test|docs(scope): description`
- Before committing: run the test suite

## Issue Tracking
[Fill in based on user's chosen system from Phase 7:]
- Use [GitHub Issues / Notion MCP / Trello MCP] for all bugs and design decisions
- Label bugs as `bug`, enhancements as `enhancement`, blockers as `blocked`

## What NOT to Do
See [docs/constraints.md](docs/constraints.md) for the full list.
Never implement features not in the PRD without asking first.

## Agents Available
[List any specialized agents configured for this project]

## MCPs Connected
[List MCPs configured for this project]
```

---

## Phase 6: Agent and MCP Checklist

Present this checklist to the user and configure what they confirm:

```
Agent/MCP Setup Checklist:

AGENTS (specialized Claude instances):
[ ] Planner agent     — PRD creation for future features
[ ] Commit agent      — conventional commits + pre-checks
[ ] Refactoring agent — code quality and performance
[ ] Verification agent — browser testing (requires agent-browser or Playwright MCP)

MCPs (external service connections):
[ ] Database MCP      — e.g., Supabase, PlanetScale
[ ] UI component MCP  — e.g., Shadcn UI
[ ] Browser testing   — agent-browser or Playwright MCP
[ ] Issue tracking    — GitHub Issues, Notion MCP, or Trello MCP
[ ] [Other MCPs from PRD integrations list]

For each checked item, configure now or note in CLAUDE.md as "to be added."
```

Add any confirmed agents and MCPs to the `## Agents Available` and `## MCPs Connected` sections of `CLAUDE.md`.

---

## Phase 7: Issue Tracking Setup

Based on team type:

**Technical team:**
```bash
# Ensure git is initialized
git init 2>/dev/null || true
git add .
git commit -m "chore: project setup scaffolding"
```
Add to `CLAUDE.md`: "Use GitHub Issues for all bugs. Reference issue numbers in commit messages: `fix: resolve login timeout (#12)`"

**Non-technical or mixed team:**
Ask: "Do you use Notion or Trello for project management?"
Add the appropriate MCP instructions to `CLAUDE.md`.

---

## Phase 8: TDD Setup

Ask the user: "What testing framework does this project use?" (e.g., Vitest, Jest, Pytest, RSpec)

Then instruct the agent (not the user — do this yourself):
- Read `docs/prd.md`
- For each Core Feature, generate a test file stub with:
  - A describe block named after the feature
  - Test cases derived from the requirements (not the implementation)
  - Each test marked as `todo` / `pending` / `skip` until implementation begins

Write test stubs to `tests/` following the project's testing framework conventions.

Tell the user: "Test stubs created from the PRD. The agent will fill these in as it builds each feature. Run tests after each feature to catch spec deviations early."

---

## Phase 9: Load Testing Plan

Using the simultaneous user count from Phase 1 (answer 6):

Write `docs/load-testing-plan.md`:

```markdown
# Load Testing Plan

## Target Scale
[X] simultaneous users at launch

## Test Scenarios
1. [Core feature 1] under [X] concurrent users
2. [Core feature 2] under [X] concurrent users
3. Authentication flow under [X] concurrent users
4. [Peak usage scenario — e.g., all users loading dashboard simultaneously]

## Tool
K6 (recommended for Node.js/Next.js projects)
Installation: npm install -g k6

## Success Criteria
- p95 response time < 500ms
- Error rate < 0.1% under target load
- No memory leaks over 10-minute sustained load test

## When to Run
- Before any production deployment
- After any change to database queries or API endpoints

## Implementation
[Agent: after core features are built, write K6 scripts for each scenario above]
```

Add to `CLAUDE.md`: "Before any production deploy, run load tests per `docs/load-testing-plan.md`."

---

## Phase 10: Final Confirmation

Show the user a summary of what was created:

```
Project setup complete.

Created:
✓ docs/prd.md              — Product requirements
✓ docs/constraints.md      — Negative constraints
✓ docs/progress.md         — Progress tracker
✓ docs/learnings.md        — Learnings log
✓ docs/rules/[section].md  — Path-specific rules (one per section)
✓ docs/load-testing-plan.md — Load testing plan
✓ tests/[stubs]            — Spec-derived test stubs
✓ CLAUDE.md                — Agent instructions (links everything above)

Next steps:
1. Review CLAUDE.md and adjust anything that doesn't fit
2. Add any MCPs and agents from the checklist you haven't configured yet
3. Start building — the agent now has full context before the first prompt

Tip: As you build, keep docs/progress.md and docs/learnings.md up to date.
CLAUDE.md is a living document — add to it whenever you discover something the agent needs to know.
```

---

## Per-Project Onboarding (Existing Project)

If the project already has some files, adapt rather than overwrite:

```bash
# Check what exists
ls docs/ 2>/dev/null
cat CLAUDE.md 2>/dev/null | head -20
```

- If `CLAUDE.md` exists: audit it against the framework and add missing sections (do not replace it)
- If `docs/` exists with partial files: create only missing files, fill in from existing context
- If tests exist: review whether they are spec-derived or code-derived; note the distinction in `CLAUDE.md`
- If no PRD exists: run the Phase 1 interview to create one, then link it in `CLAUDE.md`

---

## Reference

Full framework doc: `state/research/project-setup-framework.md` (cortextOS boss agent)
Source video: https://youtu.be/ywIhw15za9Y
