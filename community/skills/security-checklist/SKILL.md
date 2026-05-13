---
name: security-checklist
effort: medium
description: "Structured OWASP Top 10 + STRIDE threat-modeling checklist for security-vp and blueteam. Two modes: daily (8/10 confidence gate, zero-noise) and comprehensive (2/10 confidence, monthly deep-scan). Includes 17 calibrated false-positive exclusions + HARPAL-specific exclusions. Use when asked to 'security audit', 'threat model', 'OWASP review', 'CSO review', 'pentest review'. Adapted from gstack /cso (Garry Tan / YC, MIT) per research-output/2026-05-12-gstack-adoption-roadmap.md §1.3."
triggers: ["security audit", "threat model", "owasp review", "cso review", "pentest review", "vulnerability scan", "security check", "stride"]
---

# security-checklist

Structured security audit + threat-modeling workflow. Two modes. Calibrated for HARPAL's surface (multi-agent system + daemon + KB + bus + voice + Telegram bots) instead of gstack's web-app default.

| Mode | Confidence gate | Cadence | Use |
|---|---|---|---|
| **Daily** (default) | 8/10 | Per-PR / per-dispatch | Zero-noise gate; only confirmed bugs reach the report. |
| **Comprehensive** | 2/10 | Monthly | Deep-scan; surface tentative findings; security-vp reviews appendix in addition to main report. |

Audit phases combine OWASP Top 10 + STRIDE + HARPAL-specific surfaces (bus message integrity, agent settings.json supply chain, cron-prompt poisoning, KB ingest sanitization).

Pattern source: gstack `/cso` (https://github.com/garrytan/gstack/tree/main/cso, MIT, May 2026). Adapted by stripping web-app-default phases (CORS / CSP headers / CSRF token rotation) and adding HARPAL-specific phases.

---

## When to invoke

- Pre-enable security-vp gate review (e.g., warden pair, research agent, future agents)
- Post-incident review when a finding is reported (escalates from daily-mode to comprehensive-mode)
- Monthly fleet-wide audit (security-vp cron)
- After significant infra change (KB embedder swap, bus relay change, new template field)

## Phases

### Phase 0 — Inventory

Identify the surface to audit. For HARPAL agents typically:
- `agent_name/.claude/settings.json` (hook scripts, MCP servers, permissions)
- `agent_name/.env` (BOT_TOKEN, CHAT_ID, ALLOWED_USER, etc.)
- `agent_name/config.json` (cron prompts — content is executed)
- `agent_name/*.md` framework files (IDENTITY, SOUL, USER, GUARDRAILS, GOALS, CLAUDE, AGENTS)
- `agent_name/.claude/skills/` (skill files are executable instructions)
- `agent_name/.mcp.json` (MCP server entries — these are code-execution paths)
- `agent_name/memory/*.md`, MEMORY.md (memory files agent ingests on boot)
- `agent_name/outputs/*.md` (artifacts agent produces)

### Phase 1 — Secrets

| Check | Where |
|---|---|
| Hardcoded API keys / tokens NOT in `.env` | grep `.md`, `.json`, `.py`, `.ts` files |
| `.env` not git-ignored | `git check-ignore .env` |
| `.env` permissions `rw-------` (600) | `ls -la` |
| Token rotation policy documented | KB / knowledge.md |
| Tokens accidentally committed in git history | `git log -p -- '*.env'` |

**HARPAL-specific:** BOT_TOKEN + CHAT_ID + ALLOWED_USER in `.env` are intentional configuration, NOT secret-leak. Flag only if these are committed OR if `.env` is world-readable.

### Phase 2 — Supply chain (skills + MCP)

| Check | Where |
|---|---|
| `.mcp.json` MCP servers — what code does each path execute? | `cat .mcp.json` |
| `.claude/settings.json` hook scripts — what do they shell out to? | `cat .claude/settings.json` |
| `.claude/skills/` files — author and source | per-skill SKILL.md frontmatter |
| Imported skills from external repos (h1r9do, gstack) — license + recent commit | clone source if in `cortextos-tools/` |

**HARPAL-specific:** SKILL.md files are executable prompt code. Treat them with the same rigor as code, not as documentation. (Per gstack precedent — `*.md` files are NOT auto-excluded.)

### Phase 3 — Cron prompts

| Check | Where |
|---|---|
| Cron prompt content — what does it instruct the agent to do? | `config.json` crons array |
| Schedule is a valid 5-field expression or interval-shorthand (`6h`, `30m`, etc.) | `cron-management` SKILL.md |
| Cron prompt references external resources (KB, bus, web) — validation gates? | per-cron prompt text |

**HARPAL-specific:** The M-warden-6 range-step parser bug is FIXED (see cron-scheduler.ts `expandField`, 2026-05-13). All standard cron forms now work correctly: `*/N`, `H M * * *`, comma-lists (`0,15,30,45`), ranges (`8-10`), AND range-steps (`8-18/2`). The prior "use ONLY `*/N` or `H M * * *`" guidance is RETIRED. New regression coverage: `tests/unit/daemon/cron-scheduler.test.ts` "M-warden-6 range-step parser fix" describe block (3 cases).

### Phase 4 — Bus integrity

| Check | Where |
|---|---|
| HMAC signing key present + permissioned 600 | `${CTX_ROOT}/config/bus-signing-key` |
| Same HMAC key across instances (Mac mini ↔ MacBook) | scp both files, SHA-256 compare |
| Bus message ALLOWED_USER scope enforced | agent-manager.ts logic |
| Cross-instance relays loaded launchctl-side | `launchctl list \| grep relay` |

### Phase 5 — KB ingest sanitization

| Check | Where |
|---|---|
| Ingest pathway sanitizes content before embedding | `kb-ingest` command |
| Markdown content with prompt-injection payloads → no auto-execute | document corpus chunks |
| Cross-instance KB sync respects access scope | analyst's chromadb-sync |

### Phase 6 — Telegram-enabled agents

| Check | Where |
|---|---|
| ALLOWED_USER is numeric user-id (not chat-id) | `.env` |
| CHAT_ID is single-user private chat (not group) — unless explicitly approved | bot getUpdates probe |
| `telegram_polling: true` only on agents with valid BOT_TOKEN | `config.json` |
| Bot's "Group Privacy" setting (BotFather) — off only if group reception is intended | bot configuration |

### Phase 7 — Voice pipeline (when active)

| Check | Where |
|---|---|
| Mic permission scope — single daemon with continuous mic access | `wake_word_daemon` or equivalent |
| Audio frame retention — discard if no wake word detected | daemon source |
| `/tmp/capture-*.wav` cleanup after STT consumes | mic_capture_daemon |
| Model integrity (HF SHA verify on download) | model download step |
| Network egress — loopback-only for all voice services | lsof check |
| Plist permissions — user-level (Hari-owned) for voice; no system-wide root | `~/Library/LaunchAgents/` perms |

### Phase 8 — OWASP Top 10 (compressed to HARPAL surface)

| OWASP | HARPAL applicability |
|---|---|
| A01 Broken Access Control | Agent inbox routing (ALLOWED_USER), KB scope (private vs shared collection) |
| A02 Cryptographic Failures | Bus HMAC signing key, .env perms |
| A03 Injection | Prompt injection via memory/KB/bus content (NOT SQL; HARPAL has no SQL) |
| A04 Insecure Design | Approval workflow gates (always_ask list in config.json) |
| A05 Security Misconfiguration | Loopback-only bind on local services; dashboard 0.0.0.0 only on tailnet (chief override of security-vp loopback ruling, documented in knowledge.md) |
| A06 Vulnerable Components | Skill / MCP server / Python dep versions — supply-chain audit |
| A07 Authentication Failures | ALLOWED_USER enforcement; mempalace-mcp auth |
| A08 Software/Data Integrity | Framework-relay --update preserves intentional divergence; agents shouldn't silently overwrite each other's state |
| A09 Logging Failures | Event log (cortextos bus log-event) present for security-relevant actions |
| A10 SSRF | Cross-instance HTTP calls (Tailscale SOCKS5 proxy 1055) — what hosts reachable? |

### Phase 9 — STRIDE per component

For each major component (chief / sam / dev / security-vp / KB / bus relay / voice daemon):

```
COMPONENT: <name>
  Spoofing             — Can an attacker impersonate another agent on the bus?
  Tampering            — Can an in-flight bus message be modified?
  Repudiation          — Are actions audit-trailed? Memory + event log?
  Information Disclosure — Can a private-scope KB chunk leak to a different agent?
  Denial of Service    — Can a flooded bus inbox stall an agent? (Not auto-discarded — see Hard Exclusion 1)
  Elevation of Privilege — Can a non-orchestrator agent dispatch as if it were chief?
```

### Phase 10 — False positive filtering + active verification

#### Hard exclusions — automatically discard findings matching these:

1. Denial of Service, resource exhaustion, or rate limiting issues — **EXCEPTION:** LLM cost/spend amplification findings (unbounded LLM calls, missing cost caps) are NOT DoS — they are financial risk and must NOT be auto-discarded under this rule.
2. Secrets or credentials stored on disk if otherwise secured (encrypted, permissioned)
3. Memory consumption, CPU exhaustion, or file descriptor leaks
4. Input validation concerns on non-security-critical fields without proven impact
5. GitHub Action workflow issues unless clearly triggerable via untrusted input
6. Missing hardening measures — flag concrete vulnerabilities, not absent best practices
7. Race conditions or timing attacks unless concretely exploitable with a specific path
8. Vulnerabilities in outdated third-party libraries (handled at supply-chain phase, not as individual findings)
9. Memory safety issues in memory-safe languages (Rust, Go, Java, C#)
10. Files that are only unit tests or test fixtures AND not imported by non-test code
11. Log spoofing — outputting unsanitized input to logs is not a vulnerability
12. SSRF where attacker only controls the path, not the host or protocol
13. User content in the user-message position of an AI conversation (NOT prompt injection)
14. Regex complexity in code that does not process untrusted input
15. Security concerns in documentation files (*.md) — **EXCEPTION:** SKILL.md, CLAUDE.md, AGENTS.md, IDENTITY.md, SOUL.md, GUARDRAILS.md, USER.md, GOALS.md are NOT documentation. They are executable prompt code (agent + skill definitions) that control AI agent behavior. Findings in these files must NEVER be excluded under this rule.
16. Missing audit logs — absence of logging is not a vulnerability (BUT — flag missing event-log on a NEW security-relevant action as Phase 9 finding)
17. Insecure randomness in non-security contexts

#### HARPAL-specific additions

18. **Telegram BOT_TOKEN / CHAT_ID / ALLOWED_USER in `.env`** — config, not secret-leak. Only flag if committed to git OR if `.env` is world-readable.
19. **Bus messages between in-org agents** — trusted by design (HMAC-signed, ALLOWED_USER-gated). NOT a vector unless a non-org agent is added to the bus.
20. **Agent settings.json hook scripts pointing to gstack/h1r9do canonical paths** — trusted source. The skill came from the audited repo; not arbitrary code injection.
21. **mempalace-mcp running on loopback :11434 / per-agent palaces** — config, not security boundary breach. Each palace is dev-owned + permissioned.
22. **cortextos crons.json schedules** — daemon parser handles all standard cron forms correctly as of 2026-05-13 (`*/N`, `H M * * *`, comma-lists, ranges, range-steps `lo-hi/N`). M-warden-6 fix landed; no remaining schedule-form restrictions.

#### Precedents (carry across reviews)

1. Logging secrets in plaintext IS a vulnerability. Logging URLs is safe.
2. Environment variables and CLI flags are trusted input.
3. Client-side JS does not need auth — that's the server's job (rarely applies to HARPAL; mostly dashboard).
4. Shell script command injection needs a concrete untrusted input path.
5. Subtle web vulnerabilities only if extremely high confidence with concrete exploit.
6. iPython notebooks — only flag if untrusted input can trigger the vulnerability.
7. Logging non-PII data is not a vulnerability.
8. Lockfile not tracked by git IS a finding for app repos, NOT for library repos.
9. Containers running as root in `docker-compose.yml` for local dev are NOT findings; in production Dockerfiles ARE.
10. Memory file content (research dossiers, daily memory) is treated as TRUSTED ingest source — security review covers ingestion path, not content (content is reviewed at artifact-write time by the authoring agent + at gate-review time by security-vp before enable).

#### Active verification

For each finding that survives the confidence gate:
- **Secrets:** Validate format (correct length, valid prefix). DO NOT test against live APIs.
- **Bus integrity:** Trace HMAC-signing path. DO NOT inject test bus messages without explicit approval.
- **Skill supply chain:** Verify SKILL.md author + source URL HTTP 200 + license. (Mirror cortextOS research's two-gate citation check.)
- **Cross-instance:** Confirm Tailscale tailnet reachability + ALLOWED_USER scope.

#### Confidence gate

| Score | Meaning | Display rule |
|---|---|---|
| 9-10 | Verified by reading specific code or config. Concrete bug or exploit demonstrated. | Show normally |
| 7-8 | High confidence pattern match. Very likely correct. | Show normally |
| 5-6 | Moderate. Could be a false positive. | Show with caveat. |
| 3-4 | Low confidence. Pattern is suspicious but may be fine. | Suppress from main report; appendix only. |
| 1-2 | Speculation. | Only report if severity would be P0. |

### Phase 11 — Findings report

```
SECURITY FINDINGS — <agent-name> review <date>
══════════════════════════════════════════════
#  Sev   Conf  Status      Category         Finding                          Phase   File:Line
1  CRIT  9/10  VERIFIED    Bus integrity    HMAC key permissions 644          P4       config/bus-signing-key
2  HIGH  8/10  VERIFIED    Cron-prompt      Schedule "5-59/10" mis-fires      P3       config.json:33
3  HIGH  9/10  UNVERIFIED  Skill supply     New skill loaded w/o sig check    P2       .claude/skills/...
```

Each finding includes:
- Concrete exploit scenario (step-by-step)
- File:line reference
- Confidence score 1-10
- Status (VERIFIED / UNVERIFIED / TENTATIVE)
- Remediation steps
- Variant-search note (if pattern likely repeats — search elsewhere)

## Adoption notes (for the registrar)

- Invocable by: **security-vp** (primary — replaces ad-hoc adversarial review with structured pass) + **blueteam** (defensive cross-check)
- NOT for: chief / sam / dev — they consume security-vp's verdicts; they don't run the audit themselves
- Telemetry log path: `~/.cortextos/default/state/security-vp/security-checklist-runs.jsonl`
- Cadence: per-agent gate-review (daily mode); monthly fleet-wide (comprehensive mode)

## Provenance

- gstack source: https://github.com/garrytan/gstack/tree/main/cso (MIT, May 2026, 94.6k stars)
- Local clone: /Users/subbu_ai_assistant/cortextos-tools/gstack/cso/SKILL.md
- Adoption roadmap: research-output/2026-05-12-gstack-adoption-roadmap.md §1.3
- Chief approval: msg 1778617954499
- HARPAL adaptations: 5 additions to exclusion list (#18-#22), web-app phases (CORS / CSP / CSRF) deleted, replaced with multi-agent-specific phases (bus integrity, cron prompts, skill supply chain, voice pipeline). Phase numbering preserves the gstack baseline for cross-reference.
