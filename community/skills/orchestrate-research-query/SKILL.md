---
name: orchestrate-research-query
description: Load-bearing orchestrator for the multi-agent research team. Dispatches research-claude + research-codex in parallel, runs synth-compare, drafts via research-director, runs synth-bias-check + synth-principle in parallel, consolidates final report. Includes --fast flag to skip codex on simple queries.
allowed_tools: [Bash, Read]
---

# orchestrate-research-query

The driver for the multi-agent research pipeline. Owned by research-director; not invoked by user-facing agents.

## Pipeline graph

```
                            QUERY (from user/chief)
                                     │
                                     ▼
                            research-director receives
                                     │
              ┌──────────────────────┼──────────────────────┐
              │                                             │
              ▼                                             ▼
     research-claude                                research-codex (skip if --fast)
     (claude lane,                                  (gpt-5.5 via codex CLI;
      existing `research` agent)                     ssh-fallback to MacBook)
              │                                             │
              └──────────────────┬──────────────────────────┘
                                 ▼
                          synth-compare
                  (claims-decomposition + AGREE/DISAGREE/
                   CLAUDE-ONLY/CODEX-ONLY/REPHRASE table)
                                 │
                                 ▼
                     research-director drafts
                  (uses synth-compare verdict + raw lanes)
                                 │
              ┌──────────────────┴──────────────────┐
              ▼                                     ▼
      synth-bias-check                       synth-principle
      (PASS/WEAK/FAIL                        (ALIGNED/MIXED/MISALIGNED
       audit_score)                           against orgs/<org>/principles.md)
              │                                     │
              └──────────────────┬──────────────────┘
                                 ▼
                     research-director consolidates
                          (final markdown report)
                                 │
                                 ▼
                            DELIVERY
                  (Telegram + KB ingest + bus reply)
```

## Usage

```bash
bin/orchestrate.sh "<query text>" \
  [--fast]                  # skip codex lane (claude only); for simple/factual queries
  [--no-synth]              # skip all synth layers (raw claude output direct)
  [--principles <path>]     # explicit principles doc path
  [--out <path>]            # final report destination (default /tmp/research-<ts>.md)
  [--timeout <s>]           # max wall-time before partial-result return (default 300s)
```

Or via the bus from another agent:

```bash
cortextos bus send-message research-director high \
  '{"type":"research-query","query":"<text>","fast":false,"timeout":300}'
```

## Flags

| Flag | Effect | When to use |
|---|---|---|
| `--fast` | Skip research-codex + synth-compare. Claude-only. | Simple factual queries, latency-sensitive paths, debugging. |
| `--no-synth` | Run both research lanes but skip ALL synth layers. Raw outputs concatenated. | Triage / spike work where you want both raw views. |
| `--principles` | Override default principles doc path | Non-subbu-ops orgs |
| `--out` | Custom output path | Integration tests, comparison runs |
| `--timeout` | Wall-time budget. On timeout: return partial result with `verdict: "partial"`. | Long-tail queries that may stall on slow LLM. |

## Output

Markdown report with frontmatter:

```markdown
---
query: "the original query"
verdict: "ok | partial | failed"
elapsed_s: 47
mode: "full | fast | no-synth"
lanes: ["claude", "codex"]
synth: {
  compare: { agree_rate: 0.78, disagree_count: 1, recommended_action: "resolve-disagreements" },
  bias:    { audit_score: "PASS", must_fix: [] },
  principle: { alignment_score: "ALIGNED", violations: [] }
}
ship_recommendation: "ship | rework | manual-review"
---

# <query as title>

[Final synthesized report from research-director, organized in sections per the
director's judgment. Inline citations as [N]; references list at the end.]

## Open disagreements (from synth-compare)
[Only if any DISAGREE items remained unresolved. Otherwise omitted.]

## Audit summary
[Bias + principle scores collapsed to 2-3 sentences each.]

## References
[1] url — 1-line context
...
```

## Robustness rules

1. **Timeout safety** — Each stage has a sub-timeout. If a research lane stalls > 120s, mark its output `{"verdict": "timeout"}` and continue with the other lane. Synth-compare can handle a missing lane (it switches to single-lane mode).

2. **Lane-failure tolerance** — If research-codex fails (auth issue, rate limit), the pipeline downgrades to `--fast` mode automatically and notes `lanes: ["claude"]` in the output frontmatter. Failure of research-claude is FATAL (no orchestrator without primary lane).

3. **Synth-layer failure** — If any synth layer fails, the orchestrator continues with the synth results it has. `verdict: "partial"` in frontmatter. Director drafts using whatever synth output is available.

4. **No silent drops** — every stage emits a JSON envelope. Failures are explicit. `verdict: "ok"` only if ALL non-bypass stages returned ok.

## Anti-pattern

Do NOT swallow research-lane output if synth-compare flags DISAGREE — escalate to the user/director, do not auto-resolve. Disagreements between Claude and gpt-5.5 on factual claims are exactly the signal we built this pipeline to surface.

Do NOT call research-claude or research-codex from inside synth-compare / synth-bias-check / synth-principle. Those layers must be independent; cross-calling produces feedback-loop bias.

## See also

- community/skills/synth-compare/SKILL.md
- community/skills/synth-bias-check/SKILL.md
- community/skills/synth-principle/SKILL.md
- community/skills/multi-llm-bridge/bin/ask-codex-remote.sh
- community/skills/bias-auditor/SKILL.md
