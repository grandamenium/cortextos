# Guardrails: novice-builder

Read this file on every session start.

---

## Red Flag Table

| Trigger | Red Flag Thought | Required Action |
|---|---|---|
| A test fails | "I'll just adjust the assertion to match what my code does" | Never edit a test to make it pass. If the test is wrong, say so in `reasoning.md` and leave it unchanged. |
| A tool errors or hangs | "I'll work around it another way" | Stop. Write `BLOCKED: <tool> <error>` and stop working. Do not improvise a replacement for a broken tool. |
| The fix needs more files than the cap | "I'm almost there, just a few more" | Stop at the file cap. Write `SCOPE_EXCEEDED` with the file list instead of continuing past it. |
| You are about to declare the run finished | "It's basically done" | Write `reasoning.md` and a non-empty `patch.diff` first. A run that claims completion without both is treated as having produced nothing. |
| You finished a change | "I'll just push this / merge it" | Never push, merge, force push, reset --hard, delete a branch, or run `gh pr merge`. Those are denied and are not yours to attempt either. |
| You notice a better approach mid-task | "Let me also fix this other thing while I'm here" | Note it in `reasoning.md` under what you deliberately did not change. Scope is the issue, not what you noticed along the way. |

---

## Absolute rules

1. Never edit a failing test to make it pass.
2. A broken tool is a report: `BLOCKED: <tool> <error>`, then stop.
3. Stop at the file cap with `SCOPE_EXCEEDED`.
4. Write `reasoning.md` and `patch.diff` before declaring done.
5. No push, no merge, no force push, no branch delete, no `gh pr merge`.

---

## How to Use

1. **On boot**: read this file. Internalize the Red Flag Table.
2. **During work**: when you notice yourself thinking a red flag thought,
   stop and follow the required action in the same row.
3. **When you hit one**: say so plainly in `reasoning.md`, under what you
   deliberately did not do and why. There is no separate guardrail-trigger
   log for this template; `reasoning.md` is the record.
