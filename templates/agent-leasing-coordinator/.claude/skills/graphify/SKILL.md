---
name: graphify
effort: low
description: "Navigate the codebase using a pre-built knowledge graph instead of reading source files. Use before exploring unfamiliar code, tracing a bug, or understanding how two components connect. Reduces token cost by 10–466x vs naive file reading."
triggers: ["graphify", "knowledge graph", "code graph", "how does X work", "find path between", "explain node", "codebase navigation", "token efficient", "graph query"]
---

# Graphify — Code Knowledge Graph

> Query a pre-built AST-based knowledge graph instead of reading raw source files. 22x average token reduction. No LLM tokens consumed to build or update the graph.

---

## Setup (one-time, per project)

### 1. Install

```bash
pip install graphifyy
graphify install   # registers the /graphify skill in Claude Code
```

### 2. Build the graph

```bash
graphify update <project-root>
# e.g. graphify update /Users/yourname/cortextos
```

Outputs to `<project-root>/graphify-out/`:
- `graph.json` — queryable node/edge data
- `GRAPH_REPORT.md` — community hubs and unexpected connections
- `cache/` — SHA256-based change detection for incremental updates

### 3. Install git hooks (auto-update on commit)

```bash
cd <project-root>
graphify hook install
```

After this, `graph.json` rebuilds automatically on every `git commit` and `git checkout`.

### 4. (Optional) Wire to Obsidian vault

```bash
mkdir -p <vault>/graphify/<project-name>
cp <project-root>/graphify-out/GRAPH_REPORT.md <vault>/graphify/<project-name>/
cp <project-root>/graphify-out/graph.json <vault>/graphify/<project-name>/
```

---

## Usage

### Query (replaces reading source files)

```bash
graphify query "how does <topic> work" \
  --graph <project-root>/graphify-out/graph.json \
  --budget 2000
```

### Explain a node

```bash
graphify explain "<ClassName or FunctionName>" \
  --graph <project-root>/graphify-out/graph.json
```

### Find the path between two concepts

```bash
graphify path "ComponentA" "ComponentB" \
  --graph <project-root>/graphify-out/graph.json
```

### Benchmark token reduction

```bash
graphify benchmark <project-root>/graphify-out/graph.json
```

---

## When to use

- Before exploring an unfamiliar subsystem
- Tracing how data flows from A to B
- Understanding what calls what before editing
- Any time you would otherwise read 3+ source files to answer one question

## When not to use

- When you already know the exact file and line to edit
- For very small codebases (<20 files) where reading is faster
- When you need the actual source code to make an edit (use Read for that)

---

*Deployment note: replace `<project-root>` with your actual project path. The graph persists across sessions — no rebuild needed unless the codebase changes significantly.*
