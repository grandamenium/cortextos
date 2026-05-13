---
name: eyes
description: HARPAL can see screens and reason about them. Local vision (qwen2.5-vl via Ollama) + macOS native screencapture. No external API, no quota walls. Three sub-skills: screen-question, see-diff, ui-from-screenshot.
allowed_tools: [Bash, Read, Edit]
---

# eyes — Computer Vision for HARPAL

> **Why this exists.** HARPAL needs to look at things and decide. A static dashboard tells you state; vision lets the agent reason about *what looks wrong* without you describing it. Pair with Peekaboo for actions (separate skill once installed).

## Components

| Tool | Purpose | Inputs | Outputs |
|---|---|---|---|
| `bin/screen-question.sh` | Capture screen, ask local vision model an open question | URL/window/region, question | text answer + saved screenshot |
| `bin/see-diff.sh` | Compare a reference image to a live capture, get structured diff JSON | ref.png + (URL or screen) + qwen2.5-vl | JSON `{differences: [{element, expected, actual, fix}]}` |
| `bin/ollama-vision-to-code.py` | Generate React/Tailwind from a single screenshot (Mode C of ui-generation) | screenshot + stack | TSX file |

All three call qwen2.5-vl:7b on local Ollama. Default endpoint `http://127.0.0.1:11434`. Override with `OLLAMA_HOST=http://mac-mini.local:11434` (or tailnet IP) for cross-host routing.

## Dependencies

| Tool | Required | Status |
|---|---|---|
| `screencapture` | yes | built-in macOS |
| `ollama` + `qwen2.5vl:7b` model | yes | confirmed (Mac mini + MacBook local both have it) |
| `peekaboo` | optional | NOT installed — used for click/type/AX actions only, not screenshots. See [HUMAN] install task. |
| `auto-image-diff` | optional | NOT installed — vision LLM does diff reasoning directly; pixel-diff helper not needed for v1 |

## Quick recipes

```bash
# Screenshot full screen + ask a question
./bin/screen-question.sh "What state is the HUD currently showing?"

# Screenshot a specific window (Chrome HUD on port 3010) + open question
./bin/screen-question.sh --window "Google Chrome for Testing" "Is the orb pulsing?"

# Diff live HUD against reference image
./bin/see-diff.sh --reference /tmp/harpal-hud-polished.png \
                 --target-window "Google Chrome for Testing" \
                 --out /tmp/eyes-diff.json

# Generate page.tsx from a design screenshot
./bin/ollama-vision-to-code.py --screenshot /path/design.png \
                               --stack react_tailwind \
                               --out /tmp/page.tsx
```

## Vision LLM defaults

- **Model:** `qwen2.5vl:7b` (8.3B params, Q4_K_M, ~6GB on disk, ~5-10 tok/s on M-series)
- **Temperature:** 0.2 (structured-output tasks)
- **num_predict:** 4096 (enough for component-sized code or detailed diff JSON)
- **Cold-start:** first call ~30s to load weights; subsequent ~5-20s

## Limits / TODO

- **No click/type.** Pure-vision only. Add Peekaboo MCP integration for action capability — gated on `[HUMAN] install peekaboo` task.
- **No persistent session.** Each call sends image fresh; no memory across calls in the same loop. The see-diff-fix outer loop (in calling code) maintains state.
- **Single-image input today.** see-diff sends both reference and target in one prompt but they share one image slot in Ollama's REST API — we currently inline the two as base64 concatenated. Quality is acceptable for diff use; for more demanding side-by-side reasoning consider Anthropic Vision (paid) once API key lands.
- **No streaming.** Each call returns full JSON response. Suitable for tool use; not for interactive UI.

## See-diff-fix loop (calling-code pattern)

```bash
#!/bin/bash
# Outer loop — drive 3 iterations of design-match polish
for i in 1 2 3; do
  ./bin/see-diff.sh --reference $REF --target-window "$WIN" --out /tmp/diff-$i.json
  test "$(jq '.differences | length' /tmp/diff-$i.json)" -eq 0 && { echo "converged"; break; }
  # Apply suggested fixes via Edit tool (agent loops back here)
  echo "iteration $i: $(jq '.differences | length' /tmp/diff-$i.json) deltas — apply fixes then re-shoot"
  read -p "press enter when fixes applied + HMR refreshed..."
done
```
