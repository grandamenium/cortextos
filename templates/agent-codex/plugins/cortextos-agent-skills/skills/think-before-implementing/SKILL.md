---
name: think-before-implementing
description: "MANDATORY pre-implementation checklist. Forces logical thinking about edge cases, data shape, user-facing behavior, and integration points BEFORE writing code. Prevents 'I built it, looks right to me, ship it' that then fails in production."
triggers: ["think before implementing", "plan this feature", "design check", "pre-impl check", "validate approach"]
---

# Think Before Implementing

> The user said: "gib den agenten tasks auch selbstverbesserend damit die
> keine kacke dumm implementieren was nicht funktioniert."
>
> This skill is the antidote to dumb implementations. Run the checklist
> BEFORE writing code. Fixing at this stage costs minutes; fixing in
> production costs the user's trust.

---

## The Checklist (10 questions, answer all)

Before writing the first line of code for ANY task that touches user-facing
behavior, write answers to these 10 questions into the task description
or a scratch file. Don't skip. Don't compress.

### 1. What does the user actually want to do?

Re-read the task. Describe the USER JOURNEY in 3 sentences. Not the
technical change — the human flow. If you can't state the user flow
clearly, you don't understand the task yet.

Example bad: "Add a slug column to products."
Example good: "A user clicks a product card in /medizin/produkte. They
expect to land on a URL like /medizin/produkte/london-pound-cake that's
shareable, readable, and returns the product. Currently they get
/medizin/produkte/fp%3At9x068 which is ugly and not SEO-friendly."

### 2. What's the happy path?

Write the 4-7 steps of the ideal flow, each step as a single sentence.

### 3. What are the edge cases?

List at minimum:
- Empty data (no products, no items, no results)
- Single item case
- Large item case (100+ items — pagination? virtualization?)
- Anonymous user vs signed-in user vs admin
- Mobile viewport vs desktop
- Slow network / loading state
- Offline / failed network request
- User goes back button, forward, refresh mid-flow
- Two tabs / two windows concurrently

### 4. What data shape do I actually need?

Look at the Convex schema. Look at existing queries. Write down the
EXACT shape of what you'll render. If a field might be undefined, say so.
If a number could be negative/zero/huge, handle it.

### 5. Where does this integrate?

- Routes that link to this
- Routes this links to
- Cart/auth/session state it reads
- Analytics events it fires
- Permissions it checks
- Other agents' work it depends on

### 6. What could break?

Write 3-5 specific failure modes with a 1-sentence mitigation each.
Example:
- "Cannabis strain has no parents → show 'Unknown genetics' not empty graph"
- "Slug collision → append -2, -3 in migration helper"
- "User navigates away during mutation → useEffect cleanup with AbortController"

### 7. What's the smallest useful first version?

Define the MVP. Then define the stretch. Start with MVP. If you think
you can do stretch in the same PR, you're wrong 80% of the time —
split it.

### 8. How will I verify it works?

Before writing code:
- Which page will I open in Mode A Playwright?
- What will I click?
- What will I expect to see?
- What console errors would invalidate it?

Write the Playwright steps (Mode A) you'll run. If you can't, the scope
is too vague.

### 9. What's the rollback plan?

- Is this schema change backward-compatible?
- If I deploy this and it breaks, what's the 1-line revert?
- Does this need a feature flag?

### 10. Who else needs to know?

- Does another agent need a new query? message them
- Does this change an API contract? update the type + notify consumers
- Does this change a user-facing URL? update sitemap + any hardcoded links

---

## Anti-Patterns

Red-flag thoughts that mean STOP and re-plan:

| Thought | Why it's a red flag |
|---------|---------------------|
| "I'll just…" | "Just" means you're skipping steps. Re-do the checklist. |
| "Probably works" | Probably = untested. Run Playwright Mode A NOW. |
| "Can't think of edge cases" | You didn't think hard enough. List 5 now. |
| "User didn't specify, I'll assume…" | Ask. Or write your assumption into the PR description. |
| "The test doesn't cover this, oh well" | Add the test. |
| "Greptile will catch it if I missed something" | Greptile is a safety net, not a design tool. |
| "The old code did it this way so…" | The old code might be buggy. Verify. |
| "This duplicates some existing function but mine is slightly different" | Use or extend the existing one. |
| "I'll refactor this huge file while I'm in there" | No. Scope creep kills reviews. |

---

## Output format

For each task, add this block to the PR description BEFORE the "what
I changed" section:

```markdown
## Design Check

**User flow:** [3 sentences]

**Happy path:** [numbered steps]

**Edge cases handled:**
- Empty data: [how]
- Large data: [how]
- Anon vs signed-in: [how]
- Mobile: [how]
- Network failure: [how]

**Failure modes considered:**
- [failure]: [mitigation]

**MVP scope:** [what's IN this PR]
**Deferred:** [what's NOT in this PR — future task IDs if applicable]

**Verified in browser:**
- [ ] Page loads
- [ ] No console errors
- [ ] No 404/500 network calls
- [ ] Data renders (no undefined/NaN/€0.00)
- [ ] User flow works end-to-end
```

---

## When to skip

You can skip the full checklist ONLY for:
- Pure refactoring (no behavior change)
- Bumping a dependency version
- Fixing a typo in a comment
- Adding a missing field to a type that's already used

For anything else: checklist, then code. No shortcuts.

---

## Self-improvement hook

After every merged PR, spend 2 minutes on a "retro":
1. Did I catch all edge cases in the checklist?
2. Did Greptile or production find an edge case I missed?
3. If yes: add that class of edge case to this skill's question 3 list.

This file improves over time. Find a pattern you got wrong → document it
so the next agent (or you, next session) doesn't repeat it.

---

*Single source of truth for pre-implementation thinking.*
