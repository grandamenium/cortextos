# cortextOS Wave 1 — Substrate + Architectural Fixes Design Document

**Covers: Tier 0.3, Tier 0.5, Tier 1.1, Tier 1.3, Tier 2.4 preview**
**Author: feature-dev:code-architect | Date: 2026-05-17 | Status: For implementation**

---

## Codebase Facts Grounding These Designs

**Spawn path:** `AgentManager.startAgent()` (src/daemon/agent-manager.ts:170) calls `AgentProcess.start()` (src/daemon/agent-process.ts:80) which calls `AgentPTY.spawn()` (src/pty/agent-pty.ts:52). Node-pty receives an explicit `ptyEnv` dict. `HOME` is inherited from the daemon's environment via `getBaseEnv()` at agent-pty.ts:350 — all agents resolve `~/.claude/settings.json` identically.

**Auth injection:** CLAUDE_CODE_OAUTH_TOKEN is resolved at agent-pty.ts:139-167: agent `.env` > org `secrets.env` > macOS keychain fallback. Failures are logged but non-fatal — the PTY still spawns, Claude boots with "Not logged in", and the session burns silently.

**Agent config today:** Each agent has `config.json` (AgentConfig type) and `.env`. No unified per-agent registry. Telegram creds are in `.env`; warden-mb has empty BOT_TOKEN/CHAT_ID as confirmed by reading `orgs/subbu-ops/agents/warden-mb/.env`.

**Per-agent `.claude/settings.json`:** Both warden-mb and sam have one at `{agentDir}/.claude/settings.json`. These control hooks and project-scoped permissions. Claude Code reads them from the project directory but `enabledPlugins` is only read from the global `~/.claude/settings.json` (HOME-resolved).

**MCP scoping:** sam uses `{agentDir}/.mcp.json` for custom MCP servers (mempalace, playwright). The global `~/.claude/settings.json` `enabledPlugins` map governs official plugins and is a separate mechanism.

**Bus message format:** `InboxMessage` type in src/types/index.ts. Event log is JSONL. Heartbeat is `{stateDir}/heartbeat.json` (Heartbeat type in types/index.ts).

---

## Design 1 — `agents.yaml` v1 Schema (Tier 0.3)

### Problem

There is no single source of truth for per-agent capabilities. Telegram enablement is scattered across per-agent `.env` files (BOT_TOKEN/CHAT_ID), `config.json` (telegram_polling), and agent-manager.ts logic. MCP plugin scope is nonexistent — every agent inherits the full global `enabledPlugins` set. Role descriptions exist only in GOALS.md and IDENTITY.md as free-text. When auth-doctor (Tier 2.1) or the insights dashboard needs to understand fleet composition, it must reconstruct this from five separate files per agent.

### Options Considered

**Option A: Extend config.json.** Add new fields directly to the existing per-agent `config.json`. Already parsed, already loaded by the daemon. Downside: `AgentConfig` interface becomes a kitchen sink. Harder to validate across the fleet without a tool that knows the schema. No global defaults block.

**Option B: New per-agent `agent-meta.yaml` file.** Keeps config.json clean. Downside: yet another file per agent; no inheritance, no global defaults.

**Option C: Single fleet-level `agents.yaml` with global defaults + per-agent overrides.** One file to audit, one schema to validate, one place for auth-doctor and the insights pipeline to read. Supports inheritance via a `defaults` block. Forward-compat via `schema_version`. This is the recommended option.

**Option D: JSON equivalent of Option C.** YAML is more readable for operators writing it by hand; JSON requires escaping. YAML wins for a config file humans will edit.

### Recommended Option: C

Single file at `~/cortextos/orgs/subbu-ops/agents.yaml`. Daemon reads it at startup alongside `enabled-agents.json`. Validation runs in the CLI `cortextos doctor` command.

### Schema Specification

```yaml
# ~/cortextos/orgs/subbu-ops/agents.yaml
# JSON Schema: ~/cortextos/schemas/agents-v1.json
schema_version: 1

defaults:
  telegram_enabled: false
  notification_capability_status: missing
  mcp_plugins_needed: []

agents:
  chief:
    role_summary: "Mac mini orchestrator, morning cascade, fleet health, primary Telegram bot"
    telegram_enabled: true
    bot_token_env_var: BOT_TOKEN
    chat_id_env_var: CHAT_ID
    notification_capability_status: configured
    mcp_plugins_needed:
      - telegram@claude-plugins-official

  sam:
    role_summary: "MacBook co-CEO, voice-first interface, cross-instance coordination"
    telegram_enabled: true
    bot_token_env_var: BOT_TOKEN
    chat_id_env_var: CHAT_ID
    notification_capability_status: configured
    mcp_plugins_needed:
      - telegram@claude-plugins-official

  warden-mb:
    role_summary: "MacBook state-parity guard, mutual-monitoring with warden-mm"
    telegram_enabled: false
    notification_capability_status: disabled-by-design
    mcp_plugins_needed: []

  analyst:
    role_summary: "Research, metrics, OAuth rotation, ChromaDB sync"
    telegram_enabled: false
    notification_capability_status: missing
    mcp_plugins_needed: []
```

### JSON Schema for Validation (`~/cortextos/schemas/agents-v1.json`)

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["schema_version", "agents"],
  "properties": {
    "schema_version": { "type": "integer", "enum": [1] },
    "defaults": { "$ref": "#/$defs/agentEntry" },
    "agents": {
      "type": "object",
      "additionalProperties": { "$ref": "#/$defs/agentEntry" }
    }
  },
  "$defs": {
    "agentEntry": {
      "type": "object",
      "properties": {
        "role_summary": { "type": "string" },
        "telegram_enabled": { "type": "boolean" },
        "bot_token_env_var": { "type": "string" },
        "chat_id_env_var": { "type": "string" },
        "mcp_plugins_needed": {
          "type": "array",
          "items": { "type": "string" }
        },
        "notification_capability_status": {
          "type": "string",
          "enum": ["configured", "missing", "disabled-by-design"]
        }
      },
      "additionalProperties": false
    }
  }
}
```

**Defaults resolution:** Daemon merges `defaults` block with per-agent entry at load time. Any field missing from the per-agent block inherits from `defaults`. This means adding a v2 field to `defaults` gives all agents a sane value without touching each entry.

**Forward-compat rule:** v2 additions go into `defaults` first with a safe value. Per-agent entries opt in explicitly. The `additionalProperties: false` in v1 schema is relaxed to `true` in v2 to allow unknown fields to pass through without breaking v1 validators.

### Migration Path

1. Ship `agents.yaml` with only the 4-6 agents that exist today. No daemon changes required yet — the file is read by CLI tools only in v1.
2. CLI `cortextos doctor` reads and validates it. Fails fast with agent name + missing field.
3. Daemon reads it in Tier 1.1 (bootstrap skill) to determine which steps are applicable per agent.
4. No running agent sees any change at this stage.

---

## Design 2 — Per-Agent enabledPlugins Scoping (Tier 0.5)

### Problem

`AgentPTY.spawn()` passes `HOME` from the daemon process into `ptyEnv` (agent-pty.ts:350, keepVars includes `HOME`). Claude Code resolves `~/.claude/settings.json` using this `HOME`. Every agent inherits the full global `enabledPlugins` map — 60+ plugins — including `serena`, `playwright`, `mempalace` etc. that only sam needs. warden-mb gets 7 MCPs it will never use, loading overhead and surface area for unexpected behavior.

### Options Considered

**Option A: Write per-agent `settings.local.json` in the agent cwd before spawning.** Claude Code does not recognize a `settings.local.json` convention. No documented support. Would require parsing and merging inside Claude Code itself. Infeasible without upstream changes.

**Option B: CLAUDE_* env var override.** No `CLAUDE_SETTINGS_FILE` or equivalent env var exists in Claude Code's current CLI surface. Checked against documented flags in `buildClaudeArgs` at agent-pty.ts:254. Not supported today. Could work in a future Claude Code version but is speculative.

**Option C: Override `HOME` per-agent in `ptyEnv`.** `ptyEnv` is built explicitly — `HOME` is set from `getBaseEnv()` at line 67 but can be overridden before the spawn call at line 176. Setting `HOME` to a per-agent fake home directory (e.g., `~/.cortextos/agent-homes/{agentName}`) causes Claude Code to read `~/.cortextos/agent-homes/{agentName}/.claude/settings.json` — a scoped file we control. This is fully supported behavior, no undocumented APIs, and is reversible by removing the override.

**Option D: Symlink `~/.claude/settings.json` to a per-agent file pre-spawn.** Race condition: the daemon spawns multiple agents concurrently. Symlink flips between spawns would cause agents to read each other's settings. Unacceptable blast radius.

### Recommended Option: C — Override HOME per-agent in ptyEnv

**Feasibility:** Confirmed. `ptyEnv` is a plain `Record<string, string>`. Adding `HOME: agentHomeDir` after line 78 and before line 176 in `agent-pty.ts` is a 3-line change.

**Complexity:** Low. The fake home only needs `.claude/settings.json`. All other home-dir operations (PATH, TMPDIR, etc.) still work because only Claude Code reads settings from HOME.

**Blast radius if broken:** Claude Code falls back to clean defaults (no plugins) if settings.json is absent or malformed. Agents continue to run. The blast radius is "agent has no MCP plugins" not "agent crashes".

**Reversibility:** Remove the HOME override to restore global behavior instantly.

### Implementation Specification

**New file:** `~/cortextos/agent-homes/{agentName}/.claude/settings.json` — generated by the daemon at startup from `agents.yaml` `mcp_plugins_needed` field.

**Generation logic** (new function in `src/utils/agent-settings.ts`):

```typescript
export function writeAgentSettings(
  agentName: string,
  agentHomesRoot: string,
  pluginsNeeded: string[],
  globalSettings: Record<string, unknown>,
): void {
  const agentHome = join(agentHomesRoot, agentName);
  const settingsDir = join(agentHome, '.claude');
  ensureDir(settingsDir);

  // Start from global settings, override only enabledPlugins
  const agentSettings = {
    ...globalSettings,
    enabledPlugins: buildScopedPlugins(pluginsNeeded, globalSettings.enabledPlugins as Record<string, boolean>),
  };

  atomicWriteSync(
    join(settingsDir, 'settings.json'),
    JSON.stringify(agentSettings, null, 2),
  );
}

function buildScopedPlugins(
  needed: string[],
  global: Record<string, boolean>,
): Record<string, boolean> {
  // Start with all plugins disabled
  const scoped: Record<string, boolean> = {};
  for (const key of Object.keys(global)) {
    scoped[key] = false;
  }
  // Enable only what the agent needs
  for (const plugin of needed) {
    scoped[plugin] = true;
  }
  return scoped;
}
```

**Spawn-time change** in `agent-pty.ts` after line 126 (after agent `.env` is loaded), add:

```typescript
// Scope enabledPlugins by overriding HOME to a per-agent fake home.
// Claude Code resolves ~/.claude/settings.json via HOME — we control that file.
if (process.env['CTX_AGENT_HOMES_ROOT']) {
  const agentHome = join(process.env['CTX_AGENT_HOMES_ROOT'], this.env.agentName);
  if (existsSync(join(agentHome, '.claude', 'settings.json'))) {
    ptyEnv['HOME'] = agentHome;
  }
}
```

**Daemon startup** calls `writeAgentSettings()` for each agent before `discoverAndStart()`. Agent-homes directory: `~/.cortextos/{instanceId}/agent-homes/`.

### Migration Path

1. Run in opt-in mode first: only set `HOME` override if agent-home dir exists.
2. Generate agent-homes for warden-mb (zero plugins) and sam (telegram + mempalace) as the first two.
3. Remaining agents fall through to global settings — no regression.
4. After one week of stability, generate agent-homes for all agents.

---

## Design 3 — `/bootstrap` Skill Structure (Tier 1.1)

### Problem

Each agent's boot prompt (built in `buildStartupPrompt()` and `buildContinuePrompt()` at agent-process.ts:513-553) already injects some bootstrap steps — but they are text embedded in TypeScript strings, not referenceable, not testable, and not idempotent from the agent's perspective. Each agent's CLAUDE.md also has a 13-step session start checklist that partially overlaps. When a step fails (auth check, inbox read), there is no structured skip-vs-abort decision — the agent improvises. The 5-step bootstrap protocol needs to be a first-class, idempotent, agent-readable skill.

### Shell Script vs Claude Skill

A plain `bin/bootstrap.sh` could execute steps 1, 3, and 4 (auth check, inbox check, telegram). But step 2 (reload configs — read AGENTS.md and all bootstrap files) requires Claude's reasoning to confirm files are current and meaningful. Step 5 (resume cron) requires the agent to confirm daemon-managed crons are visible. A shell script cannot make these confirmations. The skill is the right abstraction because it gives the agent a checklist to execute with structured failure handling, while the daemon handles the mechanical parts (cron loading, env injection). What is gained over a shell script: idempotency markers, per-step skip logic, structured status report, and `agents.yaml` awareness.

### Skill File Structure

```
~/.claude/skills/bootstrap/
  SKILL.md          -- The skill protocol (agent reads and executes this)
  checklist.md      -- Machine-readable step registry (for status reporting)
```

The skill lives in the global `~/.claude/skills/` so it is available to all agents. Agent-specific overrides (if ever needed) go in `{agentDir}/.claude/skills/bootstrap/SKILL.md`.

### SKILL.md Protocol Specification

```markdown
---
name: bootstrap
description: "Session resumption protocol. Run at every session start. Idempotent — safe to re-run."
triggers: ["bootstrap", "session start", "resume session", "boot sequence", "startup check"]
---

# Bootstrap

Run these 5 steps in order. Each step is idempotent. Skip conditions are explicit.

## Step 1: Auth Check

```bash
# Verify Claude Code is authenticated
claude --version 2>&1 | head -1
# If output includes "Not logged in" → ABORT with Telegram alert if configured, else log to stderr
```

**On failure:** ABORT. Log `bootstrap_step1_fail` event. Send Telegram if `notification_capability_status: configured` in agents.yaml. Do not proceed.

## Step 2: Reload Configs

Read these files in order (skip missing files, note which were missing):
1. AGENTS.md
2. IDENTITY.md, SOUL.md, GUARDRAILS.md, GOALS.md, MEMORY.md, USER.md, TOOLS.md, SYSTEM.md
3. HEARTBEAT.md

**On failure of any file read:** WARN and continue. Log which files were missing.

**Skip condition:** If session mode is `continue` and last-reload timestamp (from memory/YYYY-MM-DD.md header) is < 4h ago, skip reads of files that haven't changed (check mtime).

## Step 3: Check Inbox

```bash
cortextos bus check-inbox
```

**On failure:** WARN and continue. Log `bootstrap_step3_fail`. Do not abort — inbox failure must not block the session.

## Step 4: Telegram Notification (if configured)

Check `agents.yaml` `notification_capability_status` for this agent:
- `configured` → send: `cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID "online"`
- `missing` → log warning, skip
- `disabled-by-design` → skip silently

## Step 5: Confirm Cron Set

```bash
cortextos bus list-crons $CTX_AGENT_NAME
```

Verify expected crons are present (cross-reference against config.json crons array).
**On missing cron:** WARN with cron name. Do not add crons — daemon owns them.

## Status Report

After all 5 steps, output one line:
`[BOOTSTRAP] steps: 1=OK 2=OK(7 files) 3=WARN(inbox empty) 4=SKIP(missing) 5=OK(2 crons)`
```

### `agents.yaml` Integration

Step 4 reads `notification_capability_status` from agents.yaml. The skill uses:

```bash
cortextos bus agent-meta $CTX_AGENT_NAME --field notification_capability_status
```

New CLI command `agent-meta` reads `agents.yaml` and returns a specific field for the named agent. Falls back to `missing` if agents.yaml or the field is absent.

### Failure Handling Table

| Step | Failure Mode | Action |
|------|-------------|--------|
| 1 Auth | Not logged in | ABORT, alert if Telegram configured |
| 2 Config reload | File missing | WARN, continue |
| 3 Inbox | Bus error | WARN, continue |
| 4 Telegram | Not configured | SKIP silently |
| 5 Cron | Missing cron | WARN with cron name |

### Migration Path

1. Write `~/.claude/skills/bootstrap/SKILL.md`. No agent restarts needed — skills are read on demand.
2. Each agent picks it up on next session start. The existing 13-step CLAUDE.md checklist stays as documentation; the bootstrap skill is authoritative for mechanics.
3. After 2 weeks of stability, remove the duplicated boot steps from individual agent CLAUDE.md files.

---

## Design 4 — Rate-Limit vs Auth Circuit Breaker (Tier 1.3)

### Problem

A 401 from the Anthropic API means two very different things: (a) token is valid but the account is rate-limited under the OAuth/Pro system (requires backoff + rotation), or (b) token is invalid (requires auth repair). Currently no code distinguishes them. Both land in `AgentProcess.handleExit()` as a crash, triggering exponential backoff. A genuine auth failure loops forever; a rate-limit self-resolves but wastes recovery time. The circuit breaker must classify, route, and emit metrics for each type.

### Language: TypeScript

cortextOS is a TypeScript codebase (src/ is all .ts, strict mode, built to dist/). Introducing a separate language for this library would fragment the build, add a cross-language IPC boundary, and break the existing import graph. TypeScript is the correct choice.

### State Machine

```
CLOSED ──[threshold]──▶ OPEN ──[timeout]──▶ HALF_OPEN ──[probe OK]──▶ CLOSED
   ▲                       │                     │
   └──────────────────────[probe fail]───────────┘
```

- CLOSED: calls pass through normally
- OPEN: calls fail immediately with `CircuitOpenError` (do not hit the API)
- HALF_OPEN: one probe call allowed; success → CLOSED, failure → OPEN with doubled timeout
- Default thresholds: 3 failures in 60s → OPEN; timeout: 30s → HALF_OPEN

### API Surface

New file: `src/utils/circuit-breaker.ts`

```typescript
export type FailureClass =
  | 'rate-limit'      // 401 with valid token per introspection, or 429
  | 'auth-failure'    // 401 with invalid token
  | 'server-error'    // 5xx
  | 'network'         // ECONNREFUSED, timeout
  | 'unknown';

export interface CircuitBreakerOptions {
  failureThreshold?: number;    // defaults: 3
  successThreshold?: number;    // defaults: 1
  timeoutMs?: number;           // defaults: 30_000
  onStateChange?: (state: CircuitState, reason: string) => void;
  onMetric?: (event: CircuitMetricEvent) => void;
}

export interface CircuitMetricEvent {
  type: 'rate-limit-recovery' | 'auth-failure' | 'server-error' | 'circuit-open' | 'circuit-closed';
  agentName: string;
  timestamp: string;
  details?: Record<string, unknown>;
}

export class CircuitBreaker {
  constructor(agentName: string, opts?: CircuitBreakerOptions);

  async call<T>(
    fn: () => Promise<T>,
    classify: (err: unknown) => FailureClass,
  ): Promise<T>;

  getState(): CircuitState;
  getMetrics(): { failures: number; successes: number; lastFailureClass: FailureClass | null };
}
```

### Classification Logic

```typescript
export function classifyError(err: unknown, tokenValidator?: () => Promise<boolean>): FailureClass {
  if (err instanceof Response || (err as any).status) {
    const status = (err as any).status;
    if (status === 429) return 'rate-limit';
    if (status === 401) {
      // Introspection: if we have a token validator (async), callers handle this
      // synchronously we default to 'auth-failure'; async path can reclassify
      return 'auth-failure';  // conservative — auth-doctor handles reclassification
    }
    if (status >= 500) return 'server-error';
  }
  if ((err as any).code === 'ECONNREFUSED') return 'network';
  return 'unknown';
}
```

**401 disambiguation:** A 401 MAY be a rate-limit masquerading as auth failure under Claude's OAuth system (confirmed by the insights report). The token validator is: call `checkUsageApi()` from `src/bus/oauth.ts` with the current token. If it returns successfully, the token is valid → reclassify to `rate-limit`. If it throws → genuine `auth-failure`. This introspection call is async and optional; callers may skip it for performance.

### Integration Point: Session-Level, Not Per-Call

The circuit breaker wraps at the session level in `AgentProcess` — specifically, in `handleExit()`. Rather than wrapping individual API calls (which happen inside the Claude Code subprocess, not in daemon code), the breaker classifies exit events.

```typescript
// In AgentProcess.handleExit():
const failureClass = this.circuitBreaker.classifyExit(exitCode, this.lastErrorFromLog);
if (failureClass === 'auth-failure') {
  this.circuitBreaker.recordFailure('auth-failure');
  // Emit metric for auth-doctor consumption
  logEvent(this.paths, this.name, this.env.org, 'error', 'auth_failure_detected', 'error', {
    exitCode, failureClass,
  });
  // Do NOT restart — wait for auth-doctor
  this.status = 'halted';
  return;
}
if (failureClass === 'rate-limit') {
  // Existing backoff is correct; emit metric and continue
  logEvent(this.paths, this.name, this.env.org, 'metric', 'rate_limit_recovery', 'warning', {
    exitCode, backoffMs: backoff,
  });
}
```

**Auth-doctor consumption:** auth-doctor (Tier 2.1) reads the event log JSONL and looks for `auth_failure_detected` events. No additional IPC needed — the existing event log infrastructure (`src/bus/event.ts`) is the telemetry bus.

### Metrics Emitted

| Event name | Category | Severity | Trigger |
|---|---|---|---|
| `rate_limit_recovery` | metric | warning | 429 or reclassified 401 |
| `auth_failure_detected` | error | error | genuine 401 |
| `circuit_opened` | error | error | threshold crossed |
| `circuit_closed` | metric | info | probe succeeded |

### Migration Path

1. Add `src/utils/circuit-breaker.ts` as a standalone module with no changes to existing code.
2. Wire `classifyExit()` into `AgentProcess.handleExit()` behind a feature flag (`CTX_CIRCUIT_BREAKER=1`).
3. Run on warden-mb for one week (lowest risk — telegram disabled, small surface). Verify metrics appear in event log.
4. Remove feature flag and enable fleet-wide.

---

## Design 5 — Bus Message JSON Schemas (Tier 2.4 Preview)

### Context

These seed schemas exist so the circuit breaker (Design 4) and auth-doctor (Tier 2.1) can reference message shapes in their telemetry contracts. Tier 2.4 will fully formalize. The schemas describe what IS emitted today based on reading `src/bus/heartbeat.ts`, `src/types/index.ts`, and the event log format.

### Schema 1: `context-manifest` (warden-mb publishes every 10 min)

```typescript
// Published to: {stateDir}/context-manifest.json (warden agent writes)
// Consumed by: peer warden via bus relay
interface ContextManifest {
  schema: "context-manifest/v1";
  agent: string;                    // "warden-mb"
  org: string;                      // "subbu-ops"
  host_instance: string;            // "macbook-m4max"
  generated_at: string;             // ISO 8601 UTC
  surfaces: {
    memory: MemorySurface[];
    framework: FrameworkSurface[];
    kb: KBSurface;
    relays: RelaySurface[];
    heartbeats: HeartbeatSurface[];
  };
}

interface MemorySurface {
  agent: string;
  file: string;             // relative path e.g. "memory/2026-05-17.md"
  sha256: string;
  mtime: string;            // ISO 8601
  size_bytes: number;
}

interface HeartbeatSurface {
  agent: string;
  last_heartbeat: string;   // ISO 8601, from heartbeat.json
  status: string;
  stale: boolean;           // > 6h without update
}

interface KBSurface {
  collections: Array<{ name: string; doc_count: number; last_ingest: string }>;
}

interface RelaySurface {
  name: string;             // "bus-relay" | "memory-relay" | "framework-relay"
  loaded: boolean;          // launchctl loaded state
  recent_fail_count: number;
}
```

### Schema 2: `tier1-alert` / `tier2-alert`

```typescript
// Sent via cortextos bus send-message to sam/chief
// Envelope is InboxMessage (types/index.ts); text field is this JSON-stringified
interface TierAlert {
  schema: "tier-alert/v1";
  tier: 1 | 2;
  alert_id: string;         // "{agentName}-{epoch}-{rand5}"
  source_agent: string;     // "warden-mb"
  target_agents: string[];  // for tier-1: ["sam", "chief"]
  drift_type: string;       // D1-D9 per context-warden spec
  description: string;
  surfaces_affected: string[];
  first_detected_at: string;
  grace_period_expires_at: string | null;
  auto_resolved: boolean;
  metadata: Record<string, unknown>;
}
```

### Schema 3: `heartbeat`

This already exists as the `Heartbeat` type in `src/types/index.ts`. The seed schema adds the fields missing for Tier 2.4 telemetry:

```typescript
// Extension of existing Heartbeat type for Tier 2.4
interface HeartbeatV2 extends Heartbeat {
  schema: "heartbeat/v2";           // absent in v1 — used to detect legacy
  session_id?: string;              // Claude Code conversation ID if available
  bootstrap_completed_at?: string;  // ISO 8601 — set by bootstrap skill
  auth_status?: "ok" | "degraded" | "unknown";
  circuit_breaker_state?: "closed" | "open" | "half-open";
}
```

Tier 2.4 migration: `updateHeartbeat()` in `src/bus/heartbeat.ts` accepts an optional `v2Extensions` param. v1 readers ignore unknown fields (they parse JSON with no strict schema enforcement today).

---

## Implementation Order

### Why order matters

Design 1 (agents.yaml) is consumed by Design 3 (bootstrap skill step 4) and Design 2 (mcp_plugins_needed). Design 3 depends on Design 2 being stable (agents need scoped plugins before the bootstrap skill is meaningful). Design 4 (circuit breaker) is independent of 1-3 but feeds Design 5 metrics. Design 5 is a preview only — no implementation blockers, just schema files.

### Phased sequence

```
Phase 1 (no running agent changes):
  [ ] Write ~/cortextos/schemas/agents-v1.json
  [ ] Write ~/cortextos/orgs/subbu-ops/agents.yaml (4-6 agents)
  [ ] Add cortextos doctor --validate-agents-yaml to CLI
  [ ] Write ~/.claude/skills/bootstrap/SKILL.md

Phase 2 (daemon change, single agent first):
  [ ] Add src/utils/agent-settings.ts (writeAgentSettings function)
  [ ] Modify src/pty/agent-pty.ts: HOME override for warden-mb only
  [ ] Generate ~/.cortextos/default/agent-homes/warden-mb/.claude/settings.json
  [ ] Restart warden-mb — verify it boots with zero plugins
  [ ] Verify sam unaffected (still uses global HOME)

Phase 3 (fleet rollout):
  [ ] Generate agent-homes for all agents from agents.yaml
  [ ] Enable HOME override for all agents
  [ ] Fleet restart (rolling, one agent at a time via cortextos bus restart-all)

Phase 4 (circuit breaker):
  [ ] Add src/utils/circuit-breaker.ts
  [ ] Wire into AgentProcess.handleExit() behind CTX_CIRCUIT_BREAKER=1
  [ ] Deploy to warden-mb for 7-day observation
  [ ] Confirm auth_failure_detected events appear in event log
  [ ] Remove feature flag, fleet-wide enable

Phase 5 (schema files — no code):
  [ ] Write ~/cortextos/schemas/context-manifest-v1.ts (type exports)
  [ ] Write ~/cortextos/schemas/tier-alert-v1.ts
  [ ] Write ~/cortextos/schemas/heartbeat-v2.ts
```

**Critical dependency:** Phase 2 must complete before Phase 3. The HOME override needs per-agent validation before fleet rollout — a bad settings.json silently disables all plugins for an agent, which affects the bootstrap skill's ability to use telegram plugin in step 4.

**Do not parallelize:** Phase 2 and Phase 4 can run in parallel but should not share the same implementation sprint. Two daemon changes simultaneously makes root-cause analysis harder if either breaks.

---

*End of WAVE1-DESIGN.md — 5 designs, 1 implementation sequence, all grounded in source.*
