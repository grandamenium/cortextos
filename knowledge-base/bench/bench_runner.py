#!/usr/bin/env python3
"""
KB pipeline benchmark: Gemini (old) vs Cohere vector-only vs Cohere+rerank (new).

Methodology follows servicenow-rag bench v9: fixed corpus, ground-truth query set,
rank-based metrics (Hit@k, MRR), plus the production-relevant zero-result rate
(the false-negative class that motivated the pivot).

Usage:
    python3 bench_runner.py --bench-dir <dir> --mmrag <path-to-mmrag.py> \
        --venv-python <path> --gemini-key-file <secrets.env> --cohere-key-file <.env>
"""
import argparse
import json
import statistics
import subprocess
import sys
import time
from pathlib import Path

# ---------------------------------------------------------------------------
# Query set: (query, [expected file substrings — any match counts], tier)
# T1 = lexical overlap (easy), T2 = conceptual/paraphrase, T3 = hard semantic
# (T3 includes the production false-negative class)
# ---------------------------------------------------------------------------
QUERIES = [
    ("how do I broadcast an announcement to every agent in the org", ["activity-channel"], "T2"),
    ("agent goals and responsibilities", ["GOALS", "SOUL"], "T3"),
    ("what should I do when a telegram message arrives", ["comms"], "T1"),
    ("set up a recurring scheduled task", ["cron-management"], "T1"),
    ("how do I tell the system I am still alive and running", ["heartbeat", "HEARTBEAT"], "T2"),
    ("I need a person to make a payment I cannot do myself", ["human-tasks"], "T2"),
    ("search previously stored research before searching the web", ["knowledge-base"], "T2"),
    ("first boot setup for a brand new agent", ["onboarding", "ONBOARDING"], "T1"),
    ("tasks are stuck and agents have gone quiet, how do I investigate", ["system-diagnostics"], "T2"),
    ("spawn an isolated session to work on something in parallel", ["worker-agents"], "T2"),
    ("morning briefing routine", ["morning-review"], "T1"),
    ("end of day wrap up and summary", ["evening-review"], "T2"),
    ("share a skill I built with the community", ["community-publish"], "T2"),
    ("what skills are available to install", ["catalog-browse"], "T2"),
    ("pull the latest changes from the upstream framework", ["upstream-sync", "framework-upstream"], "T1"),
    ("write my notes into the obsidian vault", ["obsidian-log"], "T1"),
    ("create an excel spreadsheet from the command line", ["officecli"], "T2"),
    ("which agent should handle which type of work", ["delegation-matrix"], "T2"),
    ("weekly retrospective process", ["weekly-review"], "T1"),
    ("rules I must never break under any circumstances", ["GUARDRAILS"], "T3"),
    ("what tools and commands do I have access to", ["TOOLS"], "T2"),
    ("how should I behave and what are my core principles", ["SOUL"], "T3"),
    ("communicating between agents running on different machines", ["multi-machine-network-bus"], "T2"),
    ("exposing agents to external systems through a standard protocol", ["a2a-adapter"], "T3"),
    ("who is the user and what do they care about", ["USER"], "T3"),
    ("how often do agent sessions restart automatically", ["CLAUDE", "AGENTS"], "T2"),
    ("what tone of voice should written content use", ["brand-voice"], "T3"),
    ("facts and background knowledge about the organisation", ["knowledge"], "T2"),
]


def load_env_line(path, key):
    for line in Path(path).read_text().splitlines():
        if line.startswith(key + "="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit(f"{key} not found in {path}")


def run_query(venv_python, mmrag, kb_dir, query, extra_args, env_extra):
    """Run one mmrag.py query, return (results list of source paths, latency_s, n_results)."""
    import os
    env = dict(os.environ)
    env.update({
        "MMRAG_DIR": str(kb_dir),
        "MMRAG_CONFIG": str(kb_dir / "config.json"),
        "MMRAG_CHROMADB_DIR": str(kb_dir / "chromadb"),
    })
    env.update(env_extra)
    cmd = [venv_python, mmrag, "query", query, "--collection", "bench", "--top-k", "5", "--json"] + extra_args
    t0 = time.time()
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120, env=env)
    latency = time.time() - t0
    out = proc.stdout
    start = out.find("{")
    if start == -1:
        return [], latency, 0, out[:200] + proc.stderr[:200]
    try:
        data = json.loads(out[start:])
    except json.JSONDecodeError:
        return [], latency, 0, out[:200]
    sources = [r.get("source", "") for r in data.get("results", [])]
    return sources, latency, len(sources), None


def find_rank(sources, expected_substrings):
    """1-based rank of the first result matching any expected substring, else None."""
    for i, src in enumerate(sources):
        if any(exp.lower() in src.lower() for exp in expected_substrings):
            return i + 1
    return None


def compute_metrics(rows):
    """rows: list of dicts with rank (int|None), n_results, latency."""
    n = len(rows)
    hits1 = sum(1 for r in rows if r["rank"] == 1)
    hits3 = sum(1 for r in rows if r["rank"] is not None and r["rank"] <= 3)
    hits5 = sum(1 for r in rows if r["rank"] is not None and r["rank"] <= 5)
    mrr = sum(1.0 / r["rank"] for r in rows if r["rank"] is not None) / n
    zero_results = sum(1 for r in rows if r["n_results"] == 0)
    misses = sum(1 for r in rows if r["rank"] is None)
    return {
        "queries": n,
        "hit@1": round(hits1 / n, 3),
        "hit@3": round(hits3 / n, 3),
        "hit@5": round(hits5 / n, 3),
        "mrr": round(mrr, 3),
        "zero_result_rate": round(zero_results / n, 3),
        "miss_rate": round(misses / n, 3),
        "mean_latency_s": round(statistics.mean(r["latency"] for r in rows), 2),
        "p95_latency_s": round(sorted(r["latency"] for r in rows)[int(n * 0.95) - 1], 2),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bench-dir", required=True)
    ap.add_argument("--mmrag", required=True)
    ap.add_argument("--venv-python", required=True)
    ap.add_argument("--gemini-key-file", required=True)
    ap.add_argument("--cohere-key-file", required=True)
    ap.add_argument("--pipelines", help="comma list of pipelines to run (default: all)")
    args = ap.parse_args()

    bench = Path(args.bench_dir)
    gemini_key = load_env_line(args.gemini_key_file, "GEMINI_API_KEY")
    cohere_key = load_env_line(args.cohere_key_file, "COHERE_API_KEY")

    pipelines = {
        # The OLD production pipeline exactly: gemini embeddings, cosine, 0.5 threshold
        "gemini-vector": {
            "kb": bench / "gemini-kb",
            "extra_args": ["--threshold", "0.5"],
            "env": {"GEMINI_API_KEY": gemini_key},
        },
        # Cohere embeddings only (isolates embedding-model quality, same 0.5 cosine threshold)
        "cohere-vector": {
            "kb": bench / "cohere-kb",
            "extra_args": ["--no-rerank", "--threshold", "0.5"],
            "env": {"COHERE_API_KEY": cohere_key},
        },
        # The NEW production pipeline: cohere embeddings + rerank-v3.5
        "cohere-rerank": {
            "kb": bench / "cohere-kb",
            "extra_args": [],
            "env": {"COHERE_API_KEY": cohere_key, "GEMINI_API_KEY": gemini_key},
        },
        # Contextual chunking variants (markdown-aware + [filename > heading] headers)
        "gemini-ctx-vector": {
            "kb": bench / "gemini-ctx-kb",
            "extra_args": ["--threshold", "0.5"],
            "env": {"GEMINI_API_KEY": gemini_key},
        },
        "cohere-ctx-rerank": {
            "kb": bench / "cohere-ctx-kb",
            "extra_args": ["--no-hybrid"],
            "env": {"COHERE_API_KEY": cohere_key, "GEMINI_API_KEY": gemini_key},
        },
        # Hybrid BM25 + dense + RRF fusion feeding the reranker
        "cohere-ctx-hybrid": {
            "kb": bench / "cohere-ctx-kb",
            "extra_args": [],
            "env": {"COHERE_API_KEY": cohere_key, "GEMINI_API_KEY": gemini_key},
        },
    }
    if args.pipelines:
        wanted = set(args.pipelines.split(","))
        pipelines = {k: v for k, v in pipelines.items() if k in wanted}

    all_results = {}
    per_query = {}
    for name, cfg in pipelines.items():
        print(f"\n=== pipeline: {name} ===", file=sys.stderr)
        rows = []
        details = []
        for query, expected, tier in QUERIES:
            sources, latency, n_results, err = run_query(
                args.venv_python, args.mmrag, cfg["kb"], query, cfg["extra_args"], cfg["env"])
            rank = find_rank(sources, expected)
            rows.append({"rank": rank, "n_results": n_results, "latency": latency})
            details.append({
                "query": query, "tier": tier, "expected": expected,
                "rank": rank, "n_results": n_results, "latency_s": round(latency, 2),
                "top_source": sources[0].split("/")[-1] if sources else None,
                "error": err,
            })
            status = f"rank={rank}" if rank else ("ZERO-RESULTS" if n_results == 0 else "MISS")
            print(f"  [{tier}] {status:<14} {query[:55]}", file=sys.stderr)
        all_results[name] = compute_metrics(rows)
        # Per-tier breakdown
        for tier in ("T1", "T2", "T3"):
            tier_rows = [r for r, (_, _, t) in zip(rows, QUERIES) if t == tier]
            if tier_rows:
                all_results[name][f"{tier}_hit@3"] = round(
                    sum(1 for r in tier_rows if r["rank"] and r["rank"] <= 3) / len(tier_rows), 3)
                all_results[name][f"{tier}_zero_rate"] = round(
                    sum(1 for r in tier_rows if r["n_results"] == 0) / len(tier_rows), 3)
        per_query[name] = details

    print(json.dumps({"metrics": all_results, "per_query": per_query}, indent=2))


if __name__ == "__main__":
    main()
