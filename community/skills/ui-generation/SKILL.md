---
name: ui-generation
effort: medium
description: "Generate React/Next.js UI from a screenshot or natural-language prompt. Two modes: v0.dev SDK (Mode A — Premium $20/mo, fastest, opinionated React+Tailwind output) or abi/screenshot-to-code Docker (Mode B — free, ANTHROPIC_API_KEY-powered, multi-framework). Use when asked to 'generate UI', 'screenshot to code', 'build this design', 'v0 this', or 'turn this image into a component'. Built per chief dispatch 1778631500586."
triggers: ["generate UI", "screenshot to code", "build this design", "v0 this", "turn this into a component", "ui from screenshot", "design to code"]
---

# ui-generation

Two complementary modes for turning visual designs / screenshots / natural-language prompts into React+Tailwind UI code.

| Mode | Cost | Speed | Quality | Auth | When to use |
|---|---|---|---|---|---|
| **A — v0.dev SDK** | $20/mo Premium subscription | Fast (~10-30s) | High; opinionated React+shadcn+Tailwind | `V0_API_KEY` env | Speed matters; iterating on a design lots; willing to pay |
| **B — abi/screenshot-to-code** | Free (uses Anthropic API tokens) | Medium (~30-90s) | Good; multi-framework support | `ANTHROPIC_API_KEY` env | Cost matters; need framework flexibility; OK with self-host |

Both modes return component code (TSX) the agent can review, integrate, or iterate on. Neither writes files directly without explicit approval — output goes to a staging area for human review.

---

## Mode A — v0.dev SDK

### Setup

```bash
# 1. Get v0 Premium API key from https://v0.dev/chat/settings (requires $20/mo subscription)
# 2. Add to fleet-wide secrets:
echo 'V0_API_KEY=...' >> /Users/subbu_ai_assistant/cortextos/orgs/subbu-ops/secrets.env
# 3. Install SDK in your project venv (Python) or node_modules (Node)
pip install v0-sdk  # or  npm install v0
```

### Invocation

```bash
/Users/subbu_ai_assistant/cortextos/community/skills/ui-generation/bin/v0-gen.sh \
    --prompt "HUD-style dashboard with dark cyan theme, 6 panels, status badges, radar widget" \
    --screenshot /path/to/reference.png  # optional — v0 supports image-conditioned generation
```

Output: `/tmp/ui-generation/v0-<task-id>/page.tsx` + `chat-id.txt` (for follow-up iterations).

### Follow-up iterations

v0 supports chat-style refinement. The SDK returns a `chat_id` on first call; subsequent calls with the same `chat_id` refine the same component.

```bash
/Users/subbu_ai_assistant/cortextos/community/skills/ui-generation/bin/v0-gen.sh \
    --chat-id 1234 --prompt "Make the orb pulse slower and add a mission timer top-right"
```

### Mode A status

🔴 **NOT WIRED YET.** Requires Hari to confirm v0 Premium subscription + provide `V0_API_KEY`. Skill structure ready; bin/v0-gen.sh stubbed below. Will activate on V0_API_KEY landing in secrets.env.

---

## Mode B — abi/screenshot-to-code (Docker REST endpoint)

abi/screenshot-to-code is an open-source project (https://github.com/abi/screenshot-to-code, MIT, 70k+ stars) that turns a screenshot into React/Vue/HTML code via an LLM (defaults to Claude — uses ANTHROPIC_API_KEY).

### Setup

```bash
# 1. Clone repo
git clone https://github.com/abi/screenshot-to-code.git /Users/subbu_ai_assistant/cortextos-tools/screenshot-to-code

# 2. Use Docker for one-command run (recommended)
cd /Users/subbu_ai_assistant/cortextos-tools/screenshot-to-code
echo "ANTHROPIC_API_KEY=sk-..." > .env
docker compose up -d

# 3. Verify backend health
curl http://localhost:7001/health
# Frontend (optional UI for debugging): http://localhost:5173
```

The Docker compose stack runs a Python backend on `:7001` + React frontend on `:5173`. The backend exposes a WebSocket-based code-generation API.

### Invocation

```bash
/Users/subbu_ai_assistant/cortextos/community/skills/ui-generation/bin/screenshot-to-code.sh \
    --screenshot /path/to/screenshot.png \
    --stack react-tailwind  # or: vue, html, svelte, etc.
```

Script:
1. Validates `ANTHROPIC_API_KEY` env or `.env` in screenshot-to-code dir.
2. Pings backend health on http://localhost:7001/health (waits up to 30s if Docker just started).
3. Sends screenshot + stack-preference to the backend via WS (or REST if the API supports it).
4. Captures streaming TSX output.
5. Saves to `/tmp/ui-generation/sc2c-<task-id>/page.tsx`.
6. Returns structured envelope: `{stack, output_path, elapsed_s, tokens_in, tokens_out}`.

### Mode B status

🟢 **PRIMARY READY.** Repo is open-source. Skill structure + bin/screenshot-to-code.sh in place. Requires `ANTHROPIC_API_KEY` (already in fleet config) + Docker + one-time `git clone + docker compose up`.

---

## When to use which mode

- **First-time generation from a NEW screenshot, time-critical**: Mode A (v0 is faster + more opinionated output suitable for high-fidelity iteration).
- **Cost-sensitive, batch generation, no Premium budget**: Mode B (uses existing Anthropic API key, no extra subscription).
- **Iterating on existing v0 chat**: Mode A only (v0's chat-id continuation can't be replicated by abi).
- **Non-React target (Vue / Svelte / vanilla HTML)**: Mode B only.
- **WebGL / Three.js / canvas-heavy components**: Both modes are weak here; prefer hand-coding + use these modes only for the surrounding chrome.

## Output handling

NEITHER mode writes files directly into the target project. Output goes to `/tmp/ui-generation/<task-id>/`. The CALLING AGENT reviews + decides:
- Cherry-pick into existing components
- Copy whole-cloth into a new file
- Iterate by sending the output back to the same mode for refinement
- Reject and re-prompt

This matches cortextOS's general principle: tools propose, agents decide, only the agent's Edit / Write calls go through approval workflow.

## Telemetry

Each invocation appends one JSONL line to `~/.cortextos/default/state/<agent>/ui-generation-usage.jsonl`:

```json
{
  "ts": "<ISO8601>",
  "mode": "v0|screenshot-to-code",
  "task_id": "<id>",
  "elapsed_s": <int>,
  "tokens_in": <int>,
  "tokens_out": <int>,
  "verdict": "ok|error",
  "agent": "<calling-agent>"
}
```

## Provenance

- v0.dev SDK: https://v0.dev (Vercel, paid)
- abi/screenshot-to-code: https://github.com/abi/screenshot-to-code (MIT, ~70k stars, Claude/GPT-powered)
- Chief approval: msg 1778631500586

## Adoption notes (for the registrar)

- Invocable by: dev, builder, m2c1-worker — agents that do UI work
- Setup gates: Mode A needs Hari V0_API_KEY [task #21 + new task for V0 if not yet]; Mode B needs Docker + ANTHROPIC_API_KEY (already fleet-wide)
- NOT for: backend-only agents (analyst, research, security-vp) — no UI surface
- The cortextOS dashboard (Next.js 14) is the primary current target; future targets include the HARPAL Jarvis HUD (just shipped, task #22)
