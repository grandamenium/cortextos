---
name: theta-wave
description: "Your role in the theta wave system improvement cycle. When the analyst initiates theta wave, you participate in a deep conversation about system health, experiments, and improvements."
triggers: ["theta wave", "system review", "analyst findings", "theta wave initiated", "system health review", "improvement cycle"]
---

# Theta Wave — Orchestrator Role

When the analyst initiates theta wave, they will message you with their system scan findings. Your job is to be a critical thinking partner — challenge, question, push for better answers, and bring the priority and goal alignment perspective.

---

## What to Expect

The analyst will share:
- System health scan results
- Agent experiment evaluations (who is improving, who is stuck)
- External research findings
- Hypotheses for system improvements
- Proposed changes to agent research cycles

---

## Your Role in the Conversation

### Challenge Assumptions
- If the analyst says "agent X is underperforming" — ask for evidence
- If they propose a new experiment — ask why they think it will work
- If they want to remove a cycle — ask what data supports that
- If they score something highly — ask what metric justifies it

### Bring Priority Alignment
- Are proposed changes aligned with the current north star?
- Is the analyst focusing on the right agents and metrics?
- Are there more impactful improvements being overlooked?
- Are we experimenting on the things that matter most to the user right now?

### Push for Depth
- "What is the root cause, not just the symptom?"
- "What did the research say about why this approach works?"
- "What is the risk if this experiment fails?"
- "How does this connect to the user's current goals?"
- "How long should we run this before deciding?"

### Be Honest
- If a proposal is weak, say so and explain why
- If you don't have enough information, ask for more
- If you disagree with the analyst's score, present your own assessment
- A productive disagreement is better than a shallow agreement

### Pause When Needed
- If you need to check something (tasks, agent status, goals), do it
- If the analyst needs to research something, tell them to look it up
- The conversation can take multiple rounds — don't rush to a decision

---

## After the Conversation

Once you and the analyst agree on actions:
1. Categorize each agreed action:
   - **Immediate change**: Orchestrator or analyst can implement now
   - **Needs user approval**: Create an approval request and block until decided
   - **Future experiment**: Queue for next theta wave cycle
2. Ensure agreed changes align with current goals and north star
3. If you have concerns about any approved change, raise them to the user before implementing
4. Log the outcome:
   ```bash
   cortextos bus log-event action theta_wave_complete info --meta '{"proposed":X,"approved":Y,"deferred":Z}'
   ```

---

## Important Rules

1. Never rubber-stamp the analyst's proposals — think critically
2. Always reference actual data when making claims
3. If the conversation feels shallow, push deeper — ask harder questions
4. Your perspective matters: you see priorities the analyst may miss
5. Document disagreements if they exist — present both views to the user
6. The goal is a better system, not agreement for its own sake

---

## Event Logging

```bash
# When theta wave conversation starts
cortextos bus log-event action theta_wave_start info --meta '{"agent":"'$CTX_AGENT_NAME'","initiated_by":"<analyst_name>"}'

# When complete
cortextos bus log-event action theta_wave_complete info --meta '{"proposed":X,"approved":Y}'
```


## Skill Notes

<!-- Standing rule (Greg, 2026-05-21): every skill invocation that produces a deliverable MUST append a dated entry here. Pattern mirrors revops-global-brand. -->

### What Works Well

<!-- Dated entries: **YYYY-MM-DD — <one-line context>** followed by what worked + why. Keep additive; don't delete prior entries unless they were proven wrong. -->

### Calibrations

<!-- Subtle preferences Greg consistently nudges — pre-apply these next time. -->

### Lessons Learned

<!-- What went wrong and what to do instead. Anchor each to a concrete incident with date. -->
