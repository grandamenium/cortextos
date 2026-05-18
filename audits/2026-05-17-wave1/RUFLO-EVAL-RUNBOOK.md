# ruflo Alpha-Eval Runbook (canonical at /Users/hari/installs/ruflo-eval-workspace/EVAL-RUNBOOK.md)

This is a pointer-doc — full runbook lives with the eval workspace so it travels with the install.

## Quick status (2026-05-17)
- `claude-flow` installed via `npm install -g claude-flow@alpha` → `ruflo v3.7.0-alpha.67`
- Eval workspace at `/Users/hari/installs/ruflo-eval-workspace/`
- `claude-flow doctor` reports 9 passed / 8 warnings / 0 errors
- Backup at pinned alpha.33: `/Users/hari/installs/ruflo-eval/` (kept in case of regression)

## Two issues caught in first smoke test
1. Memory backend not actually persisting after `memory init` — `status` reports `Backend: none, Entries: 0` even after `memory store`. Needs explicit backend config in `.claude-flow/config.yaml`. Wire to qdrant (already on :6333) or the bundled agentdb.
2. Federation plugin not bundled — `doctor` reports it as optional. Install it; it's the reason ruflo earned its P1 promotion in Phase 7. Without it the 7-day soak can't validate the marquee capability.

## The 7-day federation soak (the real gate)
Full procedure in `/Users/hari/installs/ruflo-eval-workspace/EVAL-RUNBOOK.md`. Summary:
- **Capability 1**: cross-machine federation (sam ↔ analyst over Tailscale, 100 round-trips, p99 latency <5s)
- **Capability 2**: HNSW vector index over Hari's notes (vs qdrant baseline, >80% top-3 overlap)
- **Capability 3**: GOAP A* planner (≥4 of 5 test plans reachable + minimal)
- **Capability 4**: Queen-OMC collision check (zero observable interference)

Pass → narrow integration (federation only); fail → ruflo stays internal-only, revisit at v3.8.0-stable.

## Why ruflo at all
Phase-7 audit promoted P3 → P1 specifically for native cross-machine federation (sam-mini ↔ pa-mini), bundled HNSW + Graph RAG, GOAP A* planner. None of these are covered by the rest of the stack (mem0/letta/agno/openai-agents). If the gate passes, ruflo becomes the federation primitive; otherwise existing stack covers everything except federation, which we keep doing via cortextOS bus + framework-relay.
