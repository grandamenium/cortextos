---
name: multi-perspective-grilling
description: "Pressure-test a plan, idea, or active strategy by walking it through a fixed roster of distinct skeptical perspectives. Use when: a decision feels too settled to be safe, an idea passed grooming and needs a second-order stress test, or a recurring weekly review wants fresh angles. Personas defined here, domain customization in agent config."
---

# Multi-Perspective Grilling

You take a target (an idea, a plan, an active strategy, a draft) and run it through a **rotating roster of skeptical perspectives**. Each perspective has its own posture, set of questions, and failure modes it's looking for. The output is the union of every perspective's pushback, filtered by your judgment for which pushbacks are actually load-bearing.

This is **not "give me three opinions"**. It's a structured grilling where each persona is sharp in a specific direction — the financial-analyst is looking for unit-economics fragility, the historian is looking for "this exact thing failed in 2014 because Y", the contrarian VC is looking for "why isn't a smarter team already doing this." Different personas catch different bugs.

---

## Inputs

- **Target**: path to the markdown file or a verbatim text block to grill
- **Mode**: one of `single-pass` (run all personas in one prompt, one synthesis), `rotating` (one persona per scheduled run, output appends), `tournament` (each persona runs independently, you summarize)
- **Persona set**: which personas to invoke — defaults to the canonical roster below; agent config can override or extend

Read your agent's config for:
- `personas_default: [<list>]` — which personas to use when the operator doesn't specify
- `personas_<domain>: [<list>]` — domain-specific persona overrides (e.g. for financial: `[financial-analyst, market-historian, contrarian-vc, compliance-officer]`; for perfumery: `[perfumer-master, retail-buyer, regulatory-fda, niche-blogger]`)

---

## Canonical persona roster

The skill ships with these personas defined. Each is a posture + a set of pressure questions. Domain configs can swap in domain-specific replacements.

### Financial Analyst

- Posture: trained to spot unit-economics fragility, hidden customer-acquisition costs, churn assumptions that don't survive contact with reality
- Pressure questions: "What's CAC over LTV at year 1 vs year 3?" "Where does the cost curve bend negative?" "What's the realistic churn at month 6?" "Show me the sensitivity to a 20% price drop."

### Market Historian

- Posture: pattern-matches against past attempts in adjacent spaces; default skepticism around "this time it's different"
- Pressure questions: "Who tried this in 2015 / 2008 / 1999, and what killed them?" "What's the analogue from a different industry where the same dynamic played out?" "What did the survivors do that the failures didn't?"

### Contrarian VC

- Posture: trained on "why isn't a smarter team already doing this"; looks for the trade you're making with second-order effects
- Pressure questions: "If this is so obvious, why isn't [established player] already shipping it?" "What does the smartest version of this look like, and how does ours compare?" "Where's the hidden trade — what are we giving up that we don't realize?"

### Customer

- Posture: lives in the user's chair; asks the questions the user actually asks
- Pressure questions: "Why do I care?" "What did I have to do BEFORE this existed, and is the new thing actually less work?" "Why should I trust you (a 2-person op) over [incumbent]?" "How does this fail me on a Tuesday?"

### Compliance/Regulator

- Posture: paid to find the regulatory gotcha; default to "if you have to ask whether this is legal, it isn't yet"
- Pressure questions: "What licenses does this require?" "What's the failure mode if a regulator audits in year 2?" "Where do you cross from editorial to advice to recommendation?" "What disclosures are missing?"

### Pessimist Engineer

- Posture: spent 20 years debugging production at scale; assumes the happy path doesn't exist
- Pressure questions: "What breaks at 10x scale?" "What's the SLO and who's on call?" "What's the data-loss exposure?" "What dependencies have we just bet the company on?"

(Domain configs can add: `perfumer-master`, `niche-blogger`, `regulatory-fda`, `accessibility-advocate`, etc.)

---

## Modes

### `single-pass`

Run all personas in one prompt. Output one synthesis section per persona, then a final "Operator decision points" section listing the top 3-5 pressure points across all personas that the operator should actually act on.

Use when: an idea is fresh and we want a thorough first pressure-test.

### `rotating`

One persona per run. Cron-driven, e.g. financial-analyst Monday, market-historian Wednesday, contrarian-VC Friday. Output appends to the target file (or a sibling Grilling Log) with date + persona + their pressure points.

Use when: ongoing pressure-test cadence, want fresh angles over time without overloading the operator.

### `tournament`

Each persona runs in its own independent invocation. Outputs are then synthesized into a single "What broke under grilling" doc with: most-common pressure points (multiple personas hit), unique-but-load-bearing pressure points (only one persona hit but it's serious), pressure points to dismiss (one persona raised, doesn't survive scrutiny).

Use when: a major decision is on the table and you want maximum coverage with internal cross-validation.

---

## Output rubric

For each persona run, write:

```markdown
### <Persona name> — <YYYY-MM-DD>

**Posture:** <one line>

**Pressure points raised:**
1. <Pressure point in plain English. Specific, not generic.>
2. ...

**Strongest single objection:** <the one the operator should think hardest about>

**Verdict from this perspective:** strong / has-concerns / fragile / doesn't-survive
```

Single-pass + tournament modes add a final synthesis:

```markdown
## Synthesis

**Pressure points raised by 2+ personas (high confidence):**
- ...

**Unique pressure points worth taking seriously:**
- ...

**Pressure points to dismiss:**
- ...

**Operator decision points (top 3):**
1. ...
2. ...
3. ...
```

---

## Posture across all personas

- **Each persona stays in character.** The financial analyst doesn't soften because the market historian made a kill point; they each surface what they see from their vantage.
- **Specificity > generality.** "Customer acquisition will be hard" is filler. "If you're trying to convert DIY Money's existing 12k podcast listeners to paid newsletter subs, the historical conversion ceiling for podcast→email→paid is 2-4% which gives you 240-480 paid subs at $X — does that math close?" is a pressure point.
- **Don't manufacture pressure.** If the financial analyst genuinely sees no fragility, say "no material concerns from this angle" and move on. Padding personas with weak objections is worse than a short output.
- **Surface tension between personas.** If the contrarian VC says "no one's doing this because the regulatory cost is too high" but the compliance officer says "the regulatory cost is overstated, here's the precedent" — say so. The operator's job is to resolve the tension; yours is to surface it.

---

## Cross-skill links

- Pressure points raised by a grilling pass on a `pursue` idea may trigger the `idea-grooming` skill to re-run with the new info baked in
- The `business-news-monitor` skill output is a critical input to the `market-historian` and `contrarian-vc` personas — read the latest log before grilling
