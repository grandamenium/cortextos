---
name: dream
description: "Memory consolidation skill for Claude Code. Scans session transcripts for corrections, decisions, preferences, and patterns, then merges findings into persistent memory files. Auto-triggers via native Stop hook every 24hrs. Inspired by how sleep consolidates human memory."
tags: [memory, maintenance, consolidation, autonomous, hook]
---

# Dream - Memory Consolidation for Claude Code

> Your AI agent dreams like you do. Consolidates memory while you sleep.

---

## ONBOARDING (delete this section after setup is complete)

**Welcome! Follow these steps in order. After setup is verified, delete everything between `## ONBOARDING` and `## END ONBOARDING` from this file as the final step.**

### Step 1: Detect memory system

Before anything else, detect which memory system is in use. Run these checks:

```bash
# Check 1: Native Claude Code auto-memory
ls ~/.claude/projects/*/memory/MEMORY.md 2>/dev/null && echo "DETECTED: native-claude-code"

# Check 2: OpenClaw-style (memory/ folder in project root with daily logs)
ls ./memory/20*.md 2>/dev/null && echo "DETECTED: openclaw-daily-logs"

# Check 3: Project-root MEMORY.md (custom setup)
ls ./MEMORY.md 2>/dev/null && echo "DETECTED: project-root-memory"

# Check 4: Nothing found
echo "If none detected above: no memory system found"
```

**Based on what you detect, set DREAM_MEMORY_TYPE:**

| Detection | DREAM_MEMORY_TYPE | Memory location | Session transcripts |
|-----------|-------------------|-----------------|-------------------|
| `~/.claude/projects/*/memory/MEMORY.md` exists | `native` | `~/.claude/projects/<project>/memory/` | `~/.claude/projects/<project>/sessions/*.jsonl` |
| `./memory/20*.md` daily log files exist | `openclaw` | `./memory/` (project root) | `~/.claude/projects/<project>/sessions/*.jsonl` |
| `./MEMORY.md` exists in project root | `project-root` | `./` (project root, MEMORY.md + topic files) | `~/.claude/projects/<project>/sessions/*.jsonl` |
| Nothing found | `native` (default) | `~/.claude/projects/<project>/memory/` | `~/.claude/projects/<project>/sessions/*.jsonl` |

**If no memory system is found, default to native Claude Code memory.** This is the standard and requires no extra setup - Claude Code creates the directory automatically when auto-memory is enabled.

Write the detected type to the config so dream knows where to look:
```bash
echo "DREAM_MEMORY_TYPE=native" > ~/.claude/skills/dream/.dream-config
echo "DREAM_MEMORY_PATH=~/.claude/projects" >> ~/.claude/skills/dream/.dream-config
```

Replace `native` with `openclaw` or `project-root` if that's what was detected. For `openclaw` or `project-root`, also set the path:
```bash
# For openclaw:
echo "DREAM_MEMORY_TYPE=openclaw" > ~/.claude/skills/dream/.dream-config
echo "DREAM_MEMORY_PATH=$(pwd)/memory" >> ~/.claude/skills/dream/.dream-config

# For project-root:
echo "DREAM_MEMORY_TYPE=project-root" > ~/.claude/skills/dream/.dream-config
echo "DREAM_MEMORY_PATH=$(pwd)" >> ~/.claude/skills/dream/.dream-config
```

### Step 2: Install the Stop hook

Add the dream trigger to your Claude Code settings:

```bash
SETTINGS="$HOME/.claude/settings.json"
[ ! -f "$SETTINGS" ] && echo '{}' > "$SETTINGS"

python3 -c "
import json
with open('$HOME/.claude/settings.json') as f:
    s = json.load(f)
s.setdefault('hooks', {}).setdefault('Stop', [])
if not any('dream' in h.get('command','') for h in s['hooks']['Stop']):
    s['hooks']['Stop'].append({
        'type': 'command',
        'command': 'bash \$HOME/.claude/skills/dream/should-dream.sh && touch \$HOME/.claude/.dream-pending || true'
    })
with open('$HOME/.claude/settings.json', 'w') as f:
    json.dump(s, f, indent=2)
    f.write('\n')
print('Stop hook installed')
"
```

**What this does:** When you exit any Claude Code session, the Stop hook checks if 24+ hours have passed since the last dream. If yes, it creates a `.dream-pending` flag file. On your next session start, Claude sees the flag and runs `/dream` as a background subagent.

### Step 3: Install the session-start check

Add this to your global `~/.claude/CLAUDE.md` (or project CLAUDE.md):

```markdown
## Auto Dream
If the file `~/.claude/.dream-pending` exists at session start, run `/dream` as a subagent in the background, then delete the flag file: `rm ~/.claude/.dream-pending`. This is the memory consolidation system - it runs automatically every 24 hours.
```

### Step 4: Make should-dream.sh executable

```bash
chmod +x ~/.claude/skills/dream/should-dream.sh
```

### Step 5: Test it

Run a test dream to verify the full flow:

```bash
# Force the dream to trigger by creating the flag
touch ~/.claude/.dream-pending
```

Then tell Claude: "The .dream-pending flag exists. Run /dream now."

After it completes, verify:
- The flag file `~/.claude/.dream-pending` was deleted
- Memory files were reviewed and consolidated
- A `.last-dream` timestamp was written in the memory directory
- No relative dates remain in memory files
- MEMORY.md index is under 200 lines

### Step 6: Clean up onboarding

Everything is working. Now delete this entire ONBOARDING section from this SKILL.md file (everything between `## ONBOARDING` and `## END ONBOARDING`). The skill is fully set up and will auto-trigger every 24 hours via the Stop hook.

## END ONBOARDING

---

## How It Works

Dream runs in 4 sequential phases. Execute them in order. Do not skip phases.

```
ORIENT --> GATHER SIGNAL --> CONSOLIDATE --> PRUNE & INDEX
```

### Auto-trigger flow (native Claude Code hooks)

```
Session ends
  --> Stop hook fires should-dream.sh (~10ms)
  --> Checks: 24hrs passed? 5+ sessions?
  --> If NO: exits silently, zero overhead
  --> If YES: creates ~/.claude/.dream-pending flag
Next session starts
  --> Claude reads CLAUDE.md, sees .dream-pending exists
  --> Spawns /dream as background subagent
  --> Dream runs all 4 phases
  --> Writes .last-dream timestamp, deletes .dream-pending
  --> Timer resets for next 24hrs
```

---

## Phase 1: ORIENT

**Goal:** Understand the current state of memory before changing anything.

### Step 0: Read config

```bash
cat "$HOME/.claude/skills/dream/.dream-config" 2>/dev/null || echo "DREAM_MEMORY_TYPE=native"
```

This tells you which memory system to target:
- `native` - scan `~/.claude/projects/*/memory/`
- `openclaw` - scan the `memory/` folder in the project root (daily logs + MEMORY.md)
- `project-root` - scan MEMORY.md and topic files in the project root

### Step 0.5: First-run backup (MANDATORY on first fire)

Check if this project has ever been dreamed before. If not, back up the memory directory before any consolidation. This is non-negotiable — dream mutates memory in place.

```bash
# For openclaw type (memory/ folder in project root)
if [ ! -f "$(pwd)/memory/.last-dream" ]; then
  BACKUP_DIR="$(pwd)/memory-backup-$(date -u +%Y%m%d)"
  cp -r "$(pwd)/memory" "$BACKUP_DIR"
  echo "First-run backup written to $BACKUP_DIR"
fi

# For native type
if [ ! -f "$HOME/.claude/projects/<project>/memory/.last-dream" ]; then
  BACKUP_DIR="$HOME/.claude/projects/<project>/memory-backup-$(date -u +%Y%m%d)"
  cp -r "$HOME/.claude/projects/<project>/memory" "$BACKUP_DIR"
  echo "First-run backup written to $BACKUP_DIR"
fi
```

If the backup fails (permission error, disk full), ABORT the dream run. Do not proceed to Phase 2. Log the failure and surface it on the next session start.

### Steps

1. Find memory directories based on type:
```bash
# native (default)
ls -d ~/.claude/projects/*/memory/ 2>/dev/null

# openclaw
ls ./memory/ 2>/dev/null

# project-root
ls ./MEMORY.md ./memory/ 2>/dev/null
```

2. Read the memory directory for the detected type:
```bash
# native
ls ~/.claude/projects/*/memory/ 2>/dev/null

# openclaw - also list daily logs
ls ./memory/*.md 2>/dev/null
```

3. Read `MEMORY.md` (the index file) in each project's memory directory. Note:
   - How many topic files exist
   - Total line count of MEMORY.md
   - Last modified dates
   - Any entries that look stale (relative dates like "yesterday", "last week" with no anchor)

4. Read each topic file to understand what's already stored.

### Output of this phase
You should now have a mental map of:
- Which projects have memory
- What topics are covered
- How large the memory files are
- What's potentially stale or contradictory

---

## Phase 2: GATHER SIGNAL

**Goal:** Extract important information from recent sessions without reading everything.

### Where to find transcripts (own sessions)
```bash
find "$HOME/.claude/projects/"*/sessions/ -name "*.jsonl" -mtime -7 2>/dev/null | sort -t/ -k6 -r
```

This finds JSONL session files modified in the last 7 days, sorted newest first. Adjust `-mtime -7` for different windows.

### Cross-agent scan (openclaw type only)

For agents in a cortextOS org (openclaw layout: `orgs/<org>/agents/<agent>/memory/`), also scan sibling agents' memory files. Cross-agent patterns matter: the same user (Samer) works with all agents, and preferences/decisions surface asymmetrically. If Boss learned Samer's silence rule Tuesday, Nyro's dream Wednesday should absorb it.

```bash
# From this agent's project root — enumerate sibling agents
SIBLINGS=$(ls -d ../*/memory 2>/dev/null | grep -v "^../$(basename "$(pwd)")/")

for SIB in $SIBLINGS; do
  # Recent daily memory files (last 7 days)
  find "$SIB" -name "20*.md" -mtime -7 2>/dev/null
  # Sibling's MEMORY.md (long-term)
  [ -f "$SIB/../MEMORY.md" ] && echo "$SIB/../MEMORY.md"
done
```

**What to extract from siblings:**
- User preferences (any mention of Samer's likes/dislikes/rules — cross-check with your own memory)
- Corrections Samer gave the sibling that might apply to you too
- Decisions that affect the whole org (client priorities, workflow changes)
- Do NOT copy sibling-specific operational notes (their heartbeats, their cron logs)

Store cross-agent findings with clear attribution: `(source: boss session YYYY-MM-DD)` so future dreams can trace lineage.

### What to scan for

Use targeted grep, not full reads. Each pattern targets a specific signal type:

**User corrections** (highest priority):
```bash
grep -il "actually\|no,\|wrong\|incorrect\|not right\|stop doing\|don't do\|I said\|I meant\|that's not\|correction" ~/.claude/projects/*/sessions/*.jsonl 2>/dev/null
```

**Preferences and configuration:**
```bash
grep -il "I prefer\|always use\|never use\|I like\|I don't like\|I want\|from now on\|going forward\|remember that\|keep in mind\|make sure to\|default to" ~/.claude/projects/*/sessions/*.jsonl 2>/dev/null
```

**Important decisions:**
```bash
grep -il "let's go with\|I decided\|we're using\|the plan is\|switch to\|move to\|chosen\|picked\|decision\|we agreed" ~/.claude/projects/*/sessions/*.jsonl 2>/dev/null
```

**Recurring patterns:**
```bash
grep -il "again\|every time\|keep forgetting\|as usual\|same as before\|like last time\|we always\|the usual" ~/.claude/projects/*/sessions/*.jsonl 2>/dev/null
```

### How to read matches

For each file that matches, read ONLY the surrounding context of the match (not the full session). JSONL files have one JSON object per line. Focus on lines where `type` is `"human"` (user messages) and the immediately following `"assistant"` response.

```bash
grep -n "I prefer\|always use\|never use" <session_file> | head -20
```

### What to extract

For each finding, note:
- **The fact** - What was said or decided
- **The date** - Derive from the session file's modification time
- **Confidence** - Was it an explicit instruction (high) or implied preference (medium)?
- **Contradictions** - Does this conflict with anything currently in memory?

---

## Phase 3: CONSOLIDATE

**Goal:** Merge new findings into existing memory. This is the most delicate phase.

### Rules

1. **Never duplicate.** Before adding anything, check if it already exists in memory. If it does, update the existing entry rather than creating a new one.

2. **Convert relative dates to absolute.** If a session from March 15 says "yesterday I changed the API key", write "2026-03-14: Changed API key" in memory. Never store "yesterday" or "last week".

3. **Delete contradicted facts.** If memory says "Prefers tabs" but a recent session has the user saying "Use spaces", remove the old entry and write the new one. Add a note: `(Updated YYYY-MM-DD, previously: tabs)`.

4. **Preserve source attribution.** When adding a new memory entry, note where it came from: `(from session YYYY-MM-DD)`.

5. **Topic file organization.** Group related memories into topic files:
   - `preferences.md` - How the user likes things done
   - `decisions.md` - Choices and their rationale
   - `corrections.md` - Things the user corrected
   - `patterns.md` - Recurring workflows, common tasks
   - `facts.md` - Project-specific knowledge, architecture notes
   - Create new topic files only when existing ones don't fit

6. **Entry format.** Each memory entry should be concise:
```markdown
- [YYYY-MM-DD] The fact or preference. (source: session, confidence: high/medium)
```

### Aggressive noise pruning (openclaw daily logs)

Openclaw daily logs (`memory/YYYY-MM-DD.md`) accumulate high-volume, low-signal operational NOTEs from heartbeats and skipped crons. These are context poison — they inflate file size without producing durable memory. Prune them aggressively BEFORE running the extraction grep.

**Prune-first patterns** — delete matching lines from daily logs older than 3 days (keep the last 3 days intact for cold-boot resume):

```bash
# Only prune files older than 3 days
find "$(pwd)/memory" -name "20*.md" -mtime +3 -print0 | while IFS= read -r -d '' f; do
  # Remove low-signal operational noise
  sed -i.bak -E '/^NOTE .* (check-in|cron fired.*skipped silently|Night mode|weekend no-stack)/d' "$f"
  sed -i.bak -E '/skipped silently\. (Night mode|Weekend|Just heartbeat|Samer silent \d+ pings)/d' "$f"
  rm -f "$f.bak"
done
```

**Never prune:**
- Session Start/End markers (durable context)
- Heartbeat Updates that contain WORKING ON or Key decisions
- Any line with a decision, correction, or user preference
- Anything in the last 3 days (still active resume context)

**Why:** In a typical week, a Nyro daily log has ~200 lines and ~60% are `NOTE HH:MM UTC: check-in cron fired — skipped silently`. That's ~120 lines of noise per day. Pruning takes daily logs from 200 → 40 lines with no signal loss.

### How to write

Use the Edit tool to modify existing memory files, or Write to create new topic files. Always read a file before editing it.

---

## Phase 4: PRUNE & INDEX

**Goal:** Keep MEMORY.md as a lean index. Remove stale content. Enforce size limits.

### MEMORY.md rules

MEMORY.md is an **index file**, not a content store. It should contain:
- Links/references to topic files
- A brief (one-line) summary of what each topic file contains
- The last-updated date for each topic file

MEMORY.md should **never** contain:
- Full memory entries (those go in topic files)
- Verbose descriptions
- Duplicate content that exists in topic files

### Size limit: 200 lines

If MEMORY.md exceeds 200 lines after consolidation:
1. Move any inline content to the appropriate topic file
2. Replace verbose entries with one-line summaries + links
3. Remove entries that point to deleted or empty topic files
4. If still over 200 lines, demote the oldest entries to an `archive.md` topic file

### Prune stale entries

Remove or archive entries that are:
- More than 90 days old with no references in recent sessions
- Contradicted by newer entries (should have been caught in Phase 3)
- About projects/repos that no longer exist in `~/.claude/projects/`

### Final index format

```markdown
# Memory Index

Last consolidated: YYYY-MM-DD

## Topic Files

| File | Summary | Updated |
|------|---------|---------|
| preferences.md | Editor, formatting, communication style preferences | YYYY-MM-DD |
| decisions.md | Architecture choices, tool selections, project direction | YYYY-MM-DD |
| corrections.md | Past mistakes to avoid repeating | YYYY-MM-DD |
| patterns.md | Common workflows and recurring tasks | YYYY-MM-DD |
| facts.md | Project knowledge, API details, system architecture | YYYY-MM-DD |

## Quick Reference

<!-- Only the 5-10 MOST important facts that affect every session -->
- Fact 1
- Fact 2
```

The Quick Reference section is for facts so important they should be seen every time memory is loaded. Keep it to 10 items maximum.

### Re-ingest to knowledge base (semantic search freshness)

After consolidation, the KB `memory-<agent>` collection is stale — it still holds the pre-dream chunks. Re-ingest so semantic search reflects the new state:

```bash
# For openclaw type (cortextOS agents)
if [ -n "$CTX_ORG" ] && [ -n "$CTX_AGENT_NAME" ]; then
  cortextos bus kb-ingest \
    "$(pwd)/MEMORY.md" \
    "$(pwd)/memory/$(date -u +%Y-%m-%d).md" \
    --org "$CTX_ORG" \
    --agent "$CTX_AGENT_NAME" \
    --scope private \
    --force
fi
# Note: kb-ingest auto-derives the collection name from --agent (agent-<name>). Do NOT pass --collection; the flag does not exist and the command will fail.

# For native type — ingest to any KB the user has configured (skip if none)
```

Skip if `GEMINI_API_KEY` is not configured or if the org/agent env vars are empty.

### Record the dream timestamp

After completing all 4 phases, write timestamps so the auto-trigger knows when you last dreamed:
```bash
# openclaw
date +%s > "$(pwd)/memory/.last-dream"
# native
date +%s > "$HOME/.claude/projects/<project>/memory/.last-dream"

rm -f "$HOME/.claude/.dream-pending"
```

---

## Safety

- **Never delete memory without replacement.** If removing an entry, either it was contradicted (replaced by a newer entry) or it was moved (to a topic file or archive). Never just delete.
- **Back up before first run.** On the very first run against a project, copy the memory directory:
```bash
cp -r ~/.claude/projects/<project>/memory/ ~/.claude/projects/<project>/memory-backup-$(date +%Y%m%d)/
```
- **Dry run option.** On first use, read through all 4 phases but only print what you WOULD change, without writing. Confirm with the user before applying.

---

## Verification

After running, verify the consolidation:
1. `wc -l` on MEMORY.md - should be under 200 lines
2. Check that no topic file has duplicate entries
3. Confirm no relative dates remain ("yesterday", "last week", etc.)
4. Verify all topic files referenced in MEMORY.md actually exist
5. Print a summary: entries added, entries updated, entries archived, contradictions resolved
