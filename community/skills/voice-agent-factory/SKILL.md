---
name: voice-agent-factory
description: "Turn ANY cortextOS agent into a live ElevenLabs voice agent: mine its skills, CLIs, MCPs, and transcripts into a tool catalog, distill its skills into a voice persona, dynamically generate a policy-gated gateway and all code per target (NO pre-built scripts), test exhaustively on probe-shaped fixtures, provision on ElevenLabs with automatic tier fallback, and verify end-to-end with real conversations before shipping a link."
triggers: ["voice agent", "elevenlabs", "voice surface", "talk to my agent", "conversational ai", "voice gateway", "give my agent a voice", "voice tools", "el agent", "convai", "speech interface", "tap to talk"]
external_calls: ["api.elevenlabs.io", "unpkg.com (EL widget embed)", "trycloudflare.com (quick tunnel)"]
---

# voice-agent-factory — cortextOS agent -> ElevenLabs voice agent

Run this skill against a target agent and it produces a live, policy-gated voice
surface: a zero-dependency Node gateway exposing the agent's real capabilities as
ElevenLabs tools, a widget page, a generated test harness, provisioning scripts,
and an auditable discovery record.

**ALL CODE IS WRITTEN DYNAMICALLY PER RUN.** There is NO pre-built script library
or template to copy. The agent running this skill reads the bundled `resources/`
docs (verified ElevenLabs API surface), then writes every file — gateway, tools,
tests, provisioning calls — fresh, fit to the target agent's actual capabilities
as discovered. Two agents with different jobs get completely different tool
catalogs from the same skill.

## Prerequisites

- A cortextOS install with the target agent onboarded (`<agentDir>` = the agent's
  workspace, e.g. `orgs/<org>/agents/<name>/`), and the `cortextos` CLI on PATH.
- Node >= 18 (the generated gateway and tests are zero-dependency `node:` builtins).
- An ElevenLabs account + `ELEVENLABS_API_KEY` in your org secrets file. Any paid
  tier works; the skill tier-detects and picks the right provisioning path. Voice
  minutes are billed by ElevenLabs — see `resources/GAPS.md` pricing table.
- For remote reach: `cloudflared` (quick tunnel). Localhost-only runs skip it, but
  then ElevenLabs webhook tools cannot reach the gateway — server-tools mode
  REQUIRES a public HTTPS URL. A reverse proxy or other tunnel works equally well.
- A process manager (pm2 or equivalent) for the gateway. The quick tunnel itself
  must NOT be process-managed (lesson 8).
- Browser page: the generated widget page loads the EL embed from unpkg.com at
  runtime (the one external browser dependency). If you need a no-CDN deployment,
  vendor `@elevenlabs/convai-widget-embed` locally and point the script tag at it.

## How to run

Tell the agent running this skill: the target agent name + org, the operator
contact, and (optionally) a voice id. Then follow the phases in order. Minimal
invocation: "Run voice-agent-factory against <agent> in <org>; I'm the operator."

## What this writes / creates

- Files: `<agentDir>/voice/` (gateway, tools, tests, page, provisioning scripts,
  `.env` chmod 600 + gitignored, `voice-profile.json`) and an append-only audit
  log under the agent's docs. Nothing outside the target agent's workspace.
- Local: one listening port you choose (track one port per agent), a process-manager
  entry `<agent>-voice-gateway`, optionally a quick-tunnel process.
- External (ONLY after the Phase 5 gate): an ElevenLabs agent, one EL webhook tool
  per gateway tool (or an MCP server attachment), and EL voice-minute usage.

Read `resources/REPORT.md` before any ElevenLabs API call: EL is mid-rename
(ConvAI -> ElevenAgents), doc URLs drift, and the API surface in REPORT is the
verified one. `resources/GAPS.md` has the server-tool webhook schema + pricing.
`resources/SOURCES.md` lists primary sources.

## Non-negotiable lessons (each one was hit live during the reference builds)

1. **PROBE, never map from docs.** Every CLI's JSON output shape MUST be captured
   by running a real safe command before writing a field mapping. (An email tool
   shipped with empty from/subject because the CLI nests `{headers:{from,...},
   message:{snippet}}`; a calendar create wraps its response as `{event:{id}}`
   not `{id}`.)
2. **Verb-set completeness.** For every NOUN a tool touches, generate the full
   verb set — list/get/create/update/delete — or record an explicit exclusion
   with a reason. (A build shipped calendar WRITE with no READ; the operator hit
   the gap in his first minute of talking.)
3. **The agent states its limits truthfully — make the truth complete.** The
   prompt carries an auto-generated "I cannot X from voice" section built from
   the exclusion list, each with a relay path (usually create_task to the real
   agent).
4. **Tier-detect before MCP — and probe the POST, not the GET.** Some tiers
   return `convai_mcp_servers_disabled` on `POST /v1/convai/mcp-servers` while
   the GET still 200s. The POST is the gate; fall back to webhook server tools
   (same gateway, `/tool/<name>` REST skin) without redesign.
5. **Compact returns.** Voice latency stacks per tool round-trip. Returns carry
   ids + summaries, bodies capped (~1500 chars), lists capped (~8-15 items), and
   an `as_of` UTC stamp on anything time-sensitive (the voice LLM does not
   reliably know today's date).
6. **Timezone offsets are required in every time input** (description-level
   rule); the server parses RFC3339 and rejects unparseable times.
7. **Hard invariants live server-side, not in the prompt.** Draft-only mail (no
   send path in the code at all), pinned resource ids (not parameters),
   append-only updates, recipient whitelists. Verbal confirmation is a persona
   rule; safety is code.
8. **Tunnel URL is load-bearing.** EL webhook tool URLs embed the tunnel
   hostname. Never process-manage or casually restart a quick tunnel; on
   rotation, re-register tools with the new URL and delete the orphans.
9. **Signed URLs expire (~15 min).** The page mints on load; document the
   refresh-if-idle quirk to the user.
10. **Secrets discipline.** API key in org secrets + gateway `.env` (chmod 600,
    gitignored — verify with `git check-ignore`); the browser only ever sees
    signed URLs; the gateway bearer secret is generated per deployment
    (`openssl rand -hex 24`).
11. **simulate-conversation MOCKS tools — never use it as E2E proof.** EL's
    `POST /v1/convai/agents/<id>/simulate-conversation` returns `"Tool Called."`
    for every tool (ToolMockConfig default) and the sim LLM then FABRICATES
    plausible results — it spoke a member count 2.4x the real number with zero
    gateway hits in the audit log. Use it for persona/flow checks only. Real
    verification = text-only WebSocket session (lesson 12).
12. **Real headless E2E = text-only WS session on the signed URL.** Mint
    `/api/signed-url`, connect a WebSocket client, send
    `{"type":"conversation_initiation_client_data","conversation_config_override":
    {"conversation":{"text_only":true}}}`, then `{"type":"user_message","text":...}`;
    answer `ping` events with `{"type":"pong","event_id":...}`. Watch for
    `agent_tool_response` events AND assert the gateway audit log recorded each
    call with real args. Spoken numbers must match the live data exactly.
13. **Targets may already have a voice scaffold — coexist, never clobber.** Check
    `<agentDir>/voice/` first. If occupied, pick new filenames + a free port,
    reuse existing modules by import only, and append to the existing README
    rather than overwriting. Also probe `--json` claims in agent docs: some
    commands emit JSON with no flag at all, some documented flags don't exist.
14. **Mock and live must share the param-handling path.** Apply filters and
    transforms AFTER the fixture-or-file load fork so mock tests exercise the
    same logic (a keyword filter shipped broken in mock because the mock
    returned early). If a run is halted, write a discovery record (probe shapes,
    planned catalog, exclusions) before pivoting — it makes the run resumable
    without re-mining.

## Phase 0 — Inputs and account

- Target agent name + org. Operator contact for the ASK phase.
- `ELEVENLABS_API_KEY` present (org secrets). Verify: `GET /v1/user` -> tier.
  Log the tier; it picks the provisioning path (lesson 4).
- Voice: operator picks, or default `21m00Tcm4TlvDq8ikWAM` (Rachel) — give each
  agent in a fleet a DISTINCT voice; swappable later via agent PATCH.

## Phase 1 — DISCOVER (the tool engine, part 1: inventory)

FIRST detect the target's runtime from its `config.json` (`runtime` field).
The discovery paths below are for `claude-code` agents. For `codex-app-server`
agents, substitute: skills under the agent's plugin skills dir (e.g.
`plugins/cortextos-agent-skills/skills/`), identity from AGENTS/IDENTITY/SOUL/
TOOLS files, and the runtime's own session/transcript store if one exists. If no
transcript source can be found for the runtime, STOP with an explicit
unsupported-runtime error naming what was looked for — do not silently
under-mine the agent (frequency ranking and anchor workflows would be fiction).

Mine four sources, in this order, into `voice-profile.json` candidates:

1. **Skills.** Read every `<agentDir>/.claude/skills/*/SKILL.md` (+ org-level
   skills the agent's CLAUDE.md references). Extract per skill:
   - bash blocks -> exact CLI invocations with flags = ground-truth param usage
   - frontmatter description/triggers -> tool description language
   - numbered step sequences -> prompt procedure candidates (Phase 3)
2. **CLIs.** The agent's TOOLS.md registry + every binary the skills invoke. For
   each command: `--help` parse -> flags, required/optional, enums. Record the
   account/instance flags the agent actually uses.
3. **MCPs.** `<agentDir>/.mcp.json` and live-connected servers. `tools/list`
   each: schemas are ready-made; mark as PROXY backend (the gateway forwards
   through the same policy gate — never attach an external MCP directly to EL).
4. **Transcripts + memory.** Last ~14 days of the agent's JSONL transcripts
   (`~/.claude/projects/<wd-slug>/*.jsonl`, top-level sessions) + memory files.
   Count tool/command frequency -> rank candidates by REAL usage; extract the
   top 3 recurring workflows verbatim (they become the anchor chains in Phase
   4/6). Also: agent config.json (recipients, accounts, data paths, crons).

Fan discovery out to parallel subagents (skills / transcripts / CLI surface) —
each returns structured raw data, not prose.

## Phase 2 — ASK (only what discovery cannot answer)

3-5 questions max to the operator: top workflows confirm (from transcript
ranking), what requires verbal confirmation vs auto, anything that must be
EXCLUDED from voice entirely, voice choice, reach (localhost vs tunnel).
Propose defaults from discovery so the operator can answer with one word — and
if the operator is unavailable, proceed on stated defaults for DISCOVERY and
GENERATION only. Provisioning never proceeds on defaults (Phase 5 gate).

## Phase 3 — GENERATE (the tool engine, part 2: synthesis)

Per candidate tool, in dependency order:

1. **Backend classify**: bus-command | CLI-exec | file-access | MCP-proxy.
2. **Schema derive** from Phase-1 ground truth (flags + skill usage examples).
3. **PROBE (mandatory, lesson 1)**: run the real command (safe reads live;
   writes in a fixture/dry-run mode) with JSON output; capture the response
   shape; generate the field mapping + compact-return transform from the
   CAPTURED shape. File-backed tools: capture the actual file structure.
4. **Verb-set matrix (lesson 2)**: per noun, fill read/list/get/create/update/
   delete or record exclusion + reason in the profile.
5. **Policy class**: read | write_safe | write_confirm | excluded. Generate the
   server-side invariant for every write (pin, whitelist, append-only,
   draft-only, priority caps).
6. **Description-as-trigger**: when-to-use phrasing + id-threading guidance
   ("use the exact id returned by X") — the EL description does the job of a
   skill trigger for the voice LLM.

**System prompt construction:**
- Persona core from the agent's identity (CLAUDE.md role, SOUL/identity files).
- Per relevant skill: DISTILL (never paste) into a procedure section — trigger
  phrase, numbered steps referencing generated tool names, confirm rules.
- Tool discipline block (chain reads silently, carry ids exactly, readback
  rules, never round numbers).
- Truthful-limits section auto-generated from exclusions (lesson 3) with relay
  paths.
- Keep lean; 2MB is the EL cap but hundreds of lines is the practical target.

Generate a new voice scaffold (never copy a prior build's files) under an empty
`<agentDir>/voice/`; if that directory already exists, coexist per lesson 13 —
new filenames + a free port inside it, or a `voice/<deployment-name>/` subtree,
and append to existing docs rather than overwriting. The generated tree: `voice.config.js` (identity + persona + PINNED data paths),
`src/tools/*` (written per tool, shaped by its backend type and probe captures),
`mcp-server.js` (written for this agent's tool registry + policy classes),
`src/policy.js`, `src/session-store.js` (append-only audit JSONL), `tests/`
(Phase 4), `public/index.html`, `.env` (lesson 10), `el-provision.js` +
`el-server-tools.js`.

## Phase 4 — TEST (all auto-generated, all must pass before provisioning)

- MCP protocol suite (initialize / tools/list count / unknown-method) — write it
  fresh against the generated server.
- Policy matrix: every tool x every class, whitelist negatives, unknown-tool
  reject, plus a no-orphans check (every policy entry has a catalog tool and
  vice versa).
- Per-tool units on mock fixtures (fixtures generated from the Phase-3 probe
  captures — the mock IS the captured real shape; lesson 14 on shared paths).
- Anchor chains: the agent's top transcript workflows end-to-end on mocks with
  id threading asserted.
- Gateway HTTP: bearer 401 negative, page serves, signed-url clean pre-key state.
- Then LIVE smokes: every read tool against real data locally before any
  provisioning; writes as create-then-cleanup.

## Phase 5 — PROVISION

**OPERATOR GATE (hard stop — do not pass on defaults).** Before ANY
`api.elevenlabs.io` provisioning call, process-manager start, tunnel, or link
sharing, present the operator with: the discovered tool catalog + policy classes,
the verb-matrix exclusions, expected EL cost/tier implications (minutes billing,
concurrency), the tunnel-exposure surface (public HTTPS URL fronting the
gateway), and every write tool with its server-side invariant. Get explicit
approval. This is the conscious human checkpoint between "code generated locally"
and "external paid resources exist + a voice surface is reachable".

1. Tier probe (lesson 4, POST not GET) -> MCP path or server-tools path.
2. Start the gateway under a process manager (`<agent>-voice-gateway`); tunnel
   via a detached quick tunnel (lesson 8); verify tunnel -> gateway health.
3. Create agent: `POST /v1/convai/agents/create` — a current Claude model,
   generated prompt, voice. PATCH path for updates.
4. Tools: server-tools path = `POST /v1/convai/tools` per tool (url = tunnel
   `/tool/<name>`, bearer header, request_body_schema from the generated
   schema), then PATCH agent `tool_ids` (GET current ids first, append — never
   overwrite blind). MCP path = `POST /v1/convai/mcp-servers` with
   `require_approval_per_tool` — this only CREATES the MCP server config; the
   agent does not use it until you PATCH the agent's prompt config to include
   the returned MCP server id (`conversation_config.agent.prompt.mcp_server_ids`
   — GET current ids first and append, preserving existing entries, exactly as
   with `tool_ids`).
5. Live read smokes through the tunnel; write smokes create-then-cleanup.

## Phase 6 — VERIFY (before any link ships)

1. Drive a REAL text-only WebSocket session per top-3 workflow (lesson 12 — NOT
   simulate-conversation, which mocks tools and fabricates results, lesson 11):
   assert the expected tools fired via `agent_tool_response` events, the gateway
   audit log recorded each call with real args, AND the spoken answer matches
   the live data exactly.
2. Asymmetry audit (executable lesson-2 checklist): diff the verb-set matrix
   against the shipped catalog; any silent gap = ship-blocker.
3. Page check over the tunnel; THEN send the operator the link with: known
   quirks (15-min signed-url refresh, what voice can never do), the audit-log
   location, and the recovery runbook (tunnel rotation procedure).

## Outputs

- `<agentDir>/voice/` live gateway + page + tests, process-managed.
- `voice-profile.json` — the full discovery record (tools, probe shapes, policy
  classes, verb matrix with exclusions, EL ids, verification evidence). This is
  the auditable artifact.
- Operator link + quirks note + recovery runbook.
