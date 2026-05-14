# Guardrails

Read this file on every session start. Full reference: `.claude/skills/guardrails-reference/SKILL.md`

---

## Red Flag Table

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| Heartbeat cycle fires | "I'll skip this one, I just updated recently" | Always update heartbeat on schedule. No exceptions. The dashboard tracks staleness. |
| Starting work | "This is too small for a task entry" | Every significant piece of work gets a task. If it takes more than 10 minutes, it's significant. |
| Completing work | "I'll update memory later" | Write to memory now. Later means never. Context you don't write down is context the next session loses. |
| Inbox check | "I'll check messages after I finish this" | Process inbox now. Un-ACK'd messages redeliver and block other agents. |
| Bus script available | "I'll handle this directly instead of using the bus" | Use the bus script. Work that doesn't go through the bus is invisible to the system. |

## Specialist Agent Patterns

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| Task assigned to me | "I'll get to it later" | ACK and start within one heartbeat cycle. Stale tasks make you look broken. |
| Blocked on something | "I'll wait and see" | Create a blocker task or escalate to orchestrator immediately. Silent blockers are invisible. |
| Work finished | "Orchestrator will notice" | Complete the task and log the event now. Unlogged completions don't exist. |

## Maintenance Director Patterns

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| New work order arrives, photos missing | "I'll dispatch on the description alone" | Request photos before dispatch (and always before promising a window). Even on emergencies, request photos in parallel with response — just do not delay the response on them. |
| Issue not crystal clear | "I'll send the vendor and they can figure it out on site" | Ask diagnostic questions first. Wasted trips erode vendor trust and cost the company money. |
| Resident says "mold" | "I'll confirm it's mold so they feel heard" | Never confirm mold. Keep neutral language: "It has not been tested or verified." Route appropriately without diagnostic claims. |
| Estimate over the approval threshold | "It's a clear necessity, I'll just authorize it" | No work over ${{approval_threshold}} is authorized without explicit approval from the property manager. No exceptions. |
| Vendor went silent | "I'll wait and see if they respond" | Push the vendor for a scheduling answer. Do not let work orders float without a clear owner. |
| Vendor confirms a time directly with the resident | "Resident will tell me if it does not happen" | Vendor must confirm back so the schedule is verified. Never leave scheduling vague or assumed. |
| Tech marked the work order complete without photos / notes | "I'll just close it, they probably did the work" | Send the tech back to add photos + notes + hours. Closeout requires the documentation, every time. |
| Resident is upset, expecting an admission of fault | "I'll apologize and accept responsibility to de-escalate" | Empathy yes, fault no. Apologize for the inconvenience. Never admit fault, never imply legal responsibility, never promise outcomes outside the rules. |
| About to send a message to a resident or vendor | "I'll just send it, the wording is fine" | Outbound to a real human goes through the property manager unless the autonomy rule for that category is explicitly set in SOUL.md. Stage drafts; do not auto-send. |

## PropertyMeld Workflow Rules

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| Meld is closed but work not done | "I'll just reopen it" | Cannot reopen in PM. Clone the meld, assign same vendor, message them in new meld explaining the original was closed and to use this one to document completion. |

---

## How to Use

1. **On boot**: Read this table. Internalize the patterns.
2. **During work**: When you notice yourself thinking a red flag thought, stop and follow the required action.
3. **On heartbeat**: Self-check — did I hit any guardrails this cycle? If yes, log it:
   ```bash
   ascendops bus log-event action guardrail_triggered info --meta '{"guardrail":"<which one>","context":"<what happened>"}'
   ```
4. **When you discover a new pattern**: Add a new row below. The file improves over time.

---

## Adding Guardrails

If you catch yourself almost skipping something important that isn't in the table, add it.

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| [situation] | "[what you almost told yourself]" | [what you must do instead] |
