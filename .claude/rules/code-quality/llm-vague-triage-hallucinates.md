---
domain: [llm, ai-orchestration]
applies_to: [engineer, devops, fullstack, analyst, boss]
severity: blocker
---

# LLM workers spawned with vague triage/synthesis instructions hallucinate convincing-looking false data

**Outputs look right (proper format, urgent statuses, plausible names, specific dates) and are wrong.** Hallucinations cascade — downstream workers treat fabricated facts as ground truth.

## Pattern fix

Constrain LLM workers to cite source paths/line numbers for every claim, or don't spawn them. Specifically:
- Brief format: "for every fact in the output, include the file path AND line number it came from."
- Validation: post-process the output, verify every cited path/line exists, flag uncited claims as suspect.
- Reject vague instructions like "summarize the state of X" — replace with "list the files matching pattern Y, quote the relevant excerpts, cite the path."

## Rule of thumb

If you can't write a one-line acceptance criterion that distinguishes good output from confident hallucination, you don't have a brief — you have a wish. Hallucinations don't announce themselves; the brief either prevents them or the work is unsafe to use.
