# Tools — Token-Optimizer

CLI verbs the optimizer uses to do its job.

## token-audit recommend

```bash
cortextos bus token-audit recommend --since 7d
cortextos bus token-audit recommend --since 7d --dry-run --format json
```

Generate recommendation proposals from current fact-store state. `--dry-run` reports without persisting.

Filtering floor: ≥10 evidence turns OR ≥7d evidence AND ≥$1/wk expected savings.

## token-audit list-recommendations

```bash
cortextos bus token-audit list-recommendations
cortextos bus token-audit list-recommendations --state proposed
cortextos bus token-audit list-recommendations --state applied --format json
```

Inventory by lifecycle state.

## token-audit recommendation-state

```bash
cortextos bus token-audit recommendation-state <id> proposed --notes "routed via approvals"
cortextos bus token-audit recommendation-state <id> applied --notes "applied 2026-05-12T09:00Z"
cortextos bus token-audit recommendation-state <id> measured --notes "actual $X/wk vs expected $Y/wk"
cortextos bus token-audit recommendation-state <id> kept
cortextos bus token-audit recommendation-state <id> reverted --notes "actual was 20% of expected"
```

Drive a recommendation through the six-state lifecycle.

## token-audit explain recommendation:<id>

```bash
cortextos bus token-audit explain recommendation:<uuid>
```

Drill-back: read the proposal + every evidence turn.

## Approvals (existing skill)

```bash
cortextos bus create-approval --category config-edit --title "..." --details "..."
cortextos bus list-approvals --status pending
```

Used to route proposals to Saurav for sign-off.
