---
name: architecture-map
description: Build a single self-contained, interactive HTML architecture map of this codebase. Clusters of nodes (entry / routes / services / data / external) with critical-path highlighting, plain-English explanations, click-to-detail sidebar, feature filters, pan + zoom, and optional fixes/bugs overlays. Outputs one HTML file you can open directly in a browser.
---

# Architecture Map

You will produce one self-contained HTML file (default: ./architecture-map.html) that renders this codebase as an interactive graph. No build step, no framework, no external assets, open the file directly, or serve with python3 -m http.server 4747.

The goal is not a pretty diagram. The goal is a map a non-engineer could open and understand the system from, AND that a future maintainer could spot dead code / hot paths / weak seams from at a glance.

---

## What you're building

A dark-themed HTML page with:

1. Left-to-right column clusters. Typical six: Client · Server entry · Routes · Services · Data · External APIs. Adapt to the actual stack you find:
   - CLI app, Entry · Commands · Core · Storage · External
   - Frontend-only, Pages · Components · State · API clients · External
   - Library, Public API · Core · Helpers · Tests · External

   Don't force the six-column template if it doesn't fit. Pick clusters that match the codebase you read.

2. Nodes, one per significant file, function, or table. Each node carries: a real file path (with line numbers when relevant), a one-sentence technical role, a plain-English version of the same, 2 to 4 bullet notes (line numbers, gotchas, library specifics), and feature tags.

3. Edges between nodes labeled with what flows (function call, HTTP, DB read/write, external API), color-coded by kind.

4. Filter chips at the top: "Overview" (default), one per major feature, one for the critical user-flow path, "Show all wires", and (optional) "Roadmap & bugs".

5. Right-hand sidebar that updates on hover/click: shows role + plain English + path + notes + incoming/outgoing edges + any per-node fixes/bugs.

6. Pan + zoom, mouse-drag pan, wheel zoom anchored to cursor, Fit/+/- buttons.

7. Optional badges on each node: green circle with fix count, red circle with bug count.

---

## Method (do these in order, do not skip)

### 1. Map the stack first
Read README, every package manifest (package.json, pyproject.toml, Cargo.toml, go.mod, etc.), and the entry point. Identify clusters from what you actually see. Only after that, decide your column layout.

### 2. Identify the seam
Find the single most important code path. For an LLM app, it's the prompt-assembly function. For a web app, the request-handler chain for the headline feature. For a CLI, the main loop. Mark every node on this path critical: true and every edge on it kind: 'critical'. This is the spine, everything else is decoration around it.

### 3. For each node, open the file and read it
Do not guess. Do not summarize from filename alone. For each node capture:
- path, relative path; include :line when the most important callsite is at a known line
- role, one technical sentence
- plain, the same idea, written for someone who has never seen the codebase. No jargon, no unexpanded acronyms. Imagine you're explaining it to a smart friend who isn't an engineer.
- notes, 2 to 4 bullets of concrete facts: line numbers, model/library versions, surprising couplings
- tag, array of feature-filter chip ids this node belongs to (always include 'all')

### 4. Find dead code
For every top-level export of every service-layer file, grep for callers. Anything with zero live callers gets a node with 'DEAD, zero callers' as its sub-label. Do not silently omit dead code, surfacing it is half the value of the map.

### 5. Label every edge with what flows
Examples: 'POST /api/foo', '1 · getContext', 'messages.stream → sonnet-4-6', 'DB write', 'cron · nightly'. Pick an edge kind:
- critical (red), on the main seam
- api (orange), call to an external service
- db (amber), DB read/write
- mount (sky blue), entry → route mounts
- normal (grey), everything else

### 6. Tag nodes and edges for filters
Every node and edge gets a tag: [...] array of feature-filter chip ids. Always include 'all' so the "show all wires" view works. Pick chips from the actual feature surface (e.g. auth, chat, billing, documents, comms), don't invent chips for things that don't exist.

### 7. (Optional) FIXES + KNOWN_BUGS registries
If the user has a roadmap or a known-bug list, populate two registries keyed by node id:

const FIXES      = { 'node-id': [{n: 1, t: 'short fix description'}, ...] };
const KNOWN_BUGS = { 'node-id': [{sev: 'high'|'med'|'low', ref: 'optional-code', t: '...'}, ...] };

A single fix can appear under multiple node ids, that's expected and useful (it shows everywhere the fix touches). Render fix count + bug count as small circular badges in the top-right corner of each node, and a "Roadmap & bugs" filter chip that dims everything except nodes with badges.

### 8. Sidebar default view earns the map its keep
The default sidebar (no node selected) must contain a "Notable findings from this map" section with at least one of: dead code located, unexpectedly heavy hot paths, schema/code mismatches, libraries or models you didn't expect to find, fields that get re-rendered into the same prompt twice, services that look duplicated. This is the section a maintainer reads first.

---

## Visual / technical contract

- One HTML file. Embedded <style> and <script>. No external scripts, no fonts, no images, no D3, no React. Vanilla SVG.
- Hand-positioned layout. Each node has explicit x, y, w, h. Do not pull in an auto-layout library, manual positions make the map readable and stable across edits. Leave clear vertical channels between clusters so edges curve through gutters instead of crossing nodes.
- Edges are cubic beziers: M x1 y1 C cx1 y1, cx2 y2, x2 y2 with arrowhead markers at the destination end. Stagger labels on shared gutters so they don't pile up.
- Pan/zoom: apply transform: translate(tx, ty) scale(s) to the SVG; anchor zoom to the wheel cursor.
- Click on canvas background clears selection. Click on a node selects it and dims unconnected nodes. Hover behaves like a temporary selection.

### Required script shape
The user must be able to edit the map by hand later. The script section must follow this shape exactly:

const clusters = [
  { id, label, x, y, w, h },   // one column box per cluster
  ...
];

const N = (id, cluster, label, sub, x, y, w, h, color, opts = {}) => ({
  id, cluster, label, sub, x, y, w, h, color, ...opts
});

const nodes = [
  N('node-id', 'cluster-id', 'label.js', 'sub-label', x, y, w, h, 'service', {
    role:  'one technical sentence',
    plain: 'plain-English version',
    path:  'relative/path/to/file.js:42',
    notes: ['line:N, note', 'line:N, note'],
    tag:   ['overview', 'feature-name', 'all'],
    critical: true,   // optional, marks node on the spine
  }),
  ...
];

const edges = [
  { from: 'a', to: 'b', kind: 'critical', label: '1 · doThing', tag: ['overview','feature','all'] },
  ...
];

const FIXES      = { /* optional */ };
const KNOWN_BUGS = { /* optional */ };

### Color palette (CSS vars)

--bg        #0F0F0F   --panel     #161616
--panel-2   #1c1c1c   --border    #2a2a2a
--text      #e8e8e8   --muted     #8a8a8a
--client    #4ea1ff   --route     #7bd389
--service   #c792ea   --db        #ffb86b
--external  #ff6b9d   --critical  #ff3860
--accent    #f5b942   --accent-2  #ff7a45

Cluster fill is a darker tint of the cluster's color; node stroke uses the color directly. Critical nodes get a thicker stroke (about 2.2px) to stand out.

---

## Rules

- One file. No build step. Opens in any modern browser.
- Every label is a real file or function name from the repo. Every path is real. Every line number you cite must have been confirmed by reading the file at that line.
- No invented bugs. KNOWN_BUGS only includes things you can cite with file:line.
- Plain-English text in plain: is readable by someone who has never seen the codebase. No jargon, no unexpanded acronyms.
- Preserve the script shape above so the user can edit nodes/edges by hand without reverse-engineering your structure.
- No emojis in node labels or sub-labels. Use them only in section headers or the legend if they aid scanning.

---

## Deliverables

1. The HTML file at the path the user requested (default ./architecture-map.html).
2. A short reply summarizing: how many nodes / edges, the critical path you identified, any dead code you found, and the top 3 surprises.
3. How to view it: open the file directly, or python3 -m http.server 4747 and visit http://localhost:4747/architecture-map.html.
