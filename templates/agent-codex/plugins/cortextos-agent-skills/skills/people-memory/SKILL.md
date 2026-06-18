---
name: people-memory
description: "Per-person memory system. Each person you interact with gets a memory file in memory/people/. Load it when they message you, update it after meaningful interactions. This is how you remember who people are, what you discussed, and their preferences — without cluttering every session with everyone's context."
triggers: ["people memory", "person memory", "who is this person", "what did I discuss with", "remember person", "per-person context", "conversation history with"]
---

# People Memory

Each person you interact with gets their own memory file. This gives you continuity across sessions — you remember what you discussed, their preferences, and your working relationship — without loading everyone's context into every session.

---

## File Location

```
memory/people/{slug}.md
```

Slug = lowercase first name or username, ASCII-safe. Examples: `ilya.md`, `nikita.md`, `olesya.md`.

If two people share a name, append last initial or username: `david_m.md`.

---

## When to Load

**On message arrival from a person:**

```bash
# Extract person slug from message header
# === TELEGRAM from Никита (chat_id:182191847) ===
# → slug = nikita

PERSON_FILE="memory/people/nikita.md"
if [[ -f "$PERSON_FILE" ]]; then
  cat "$PERSON_FILE"
fi
```

Load BEFORE you respond. This is your context about them.

Do NOT load all people files at session start — only load the file for whoever is messaging you right now.

---

## When to Write/Update

After a **meaningful** interaction — not every single message. Write when:

- You learn something new about the person (role, preference, skill)
- You complete a task for them
- They give you feedback or a correction
- A significant decision is made together
- First interaction ever (create the file)

Do NOT write for: routine greetings, single-word acknowledgments, forwarded cron output.

---

## File Format

```markdown
---
name: <display name>
telegram_id: <id>
role: <their role in the org>
language: <preferred language>
first_seen: <YYYY-MM-DD>
---

# <Display Name>

## Profile
- Role: <what they do>
- Communicates in: <language preference>
- Style: <brief/detailed, formal/casual, technical/non-technical>
- Preferences: <anything learned about how they like to work>

## Interaction Log

### YYYY-MM-DD — <topic>
<2-3 sentences: what was discussed, what was decided, what you delivered>

### YYYY-MM-DD — <topic>
<2-3 sentences>
```

---

## Rules

1. **Brevity over completeness.** Each log entry = 2-3 sentences max. Capture the *what* and *decision*, not the full conversation.

2. **Profile section is living.** Update it whenever you learn something new. Don't duplicate info — overwrite stale facts.

3. **No sensitive data.** Do not store passwords, tokens, API keys, or personal contact info beyond what's in the message header. Telegram IDs are OK (they're in every message already).

4. **One file per person.** Don't split by topic or date. The file IS the person's context.

5. **Prune old entries.** If a person's file exceeds ~50 lines of log entries, summarize older entries into a "Summary of earlier interactions" section and remove the individual entries.

---

## Creating a New Person File

First time you interact with someone new:

```bash
mkdir -p memory/people
TODAY=$(date -u +%Y-%m-%d)
cat > "memory/people/${SLUG}.md" << 'PERSONEOF'
---
name: <Name>
telegram_id: <id>
role: <role if known>
language: <language>
first_seen: YYYY-MM-DD
---

# <Name>

## Profile
- Role: <observed or stated role>
- Communicates in: <language>
- Style: <first impression>

## Interaction Log

### YYYY-MM-DD — First interaction
<what happened>
PERSONEOF
```

---

## Querying People Memory

To recall what you know about someone without a live message:

```bash
cat memory/people/<slug>.md 2>/dev/null || echo "No memory for this person"
```

To find who you've interacted with:

```bash
ls memory/people/ 2>/dev/null
```

---

## Integration with Company KB

After updating a person's memory, if the interaction produced a **company-relevant learning** (not just personal preference), also ingest it into the shared KB:

```bash
cortextos bus kb-ingest memory/people/<slug>.md \
  --org $CTX_ORG --agent $CTX_AGENT_NAME \
  --scope private --force
```

This keeps your people-memory private to you — each agent stores its own observations about people (interaction context differs between agents, e.g. gc-admin vs designer).

---

*This is the single source of truth for per-person memory.*
