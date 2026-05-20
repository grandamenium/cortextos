---
name: security-audit
description: "You need to assess the security posture of a Claude Code / cortextOS agent installation — its own files, skills, scripts, secrets, network surface, and autonomous blast radius. Use when asked to run a security audit, harden an agent, check for prompt-injection or exfiltration risk, before adding a new agent or skill, or periodically as a baseline. This audits the AGENT SYSTEM itself, not application/product code (use /security-review for app code)."
triggers: ["security audit", "audit the agent", "audit security", "harden the agent", "prompt injection check", "secrets audit", "exfiltration risk", "blast radius", "agent security", "is the agent safe", "check for vulnerabilities", "security posture", "audit installation", "review approval gates"]
external_calls: []
---

# Security Audit

Comprehensive security audit of a Claude Code agent installation. This audits
the **agent system itself** — cortextOS framework, agent files, skills, scripts,
secrets, network surface, MCP tools, memory, and the autonomous action surface.
It is distinct from `/security-review`, which audits application/product code.

You are acting as a security auditor specializing in AI coding agents and
autonomous AI systems. Examine every file in the target agent directory and its
parent cortextOS installation, then produce a structured security report
covering all ten vectors below. Do not skip any vector. For each finding,
identify the exact file and line where possible.

**IMPORTANT — do not leak secrets in the report.** When a finding involves a
secret, record its *location* (file:line) and *type*, never its value. The
report itself must never reproduce an API key, token, or password.

---

## SETUP

`AGENT_DIR` = the absolute path to the agent directory being audited
(e.g. `orgs/<org>/agents/<name>`).

Read and analyze the following in `AGENT_DIR` and up to two levels above it:
- All `.md` files (CLAUDE.md, MEMORY.md, GUARDRAILS.md, TOOLS.md, SYSTEM.md, SOUL.md, ONBOARDING.md, AGENTS.md)
- All skill files in `.claude/skills/`
- All script files
- `.env`, `secrets.env`, `.cortextos-env`, `config.json`
- Log files and state files in the state directory
- Any `templates/` or `community/` directories

---

## VECTOR 1 — PROMPT INJECTION

Examine every skill and script that fetches external content: web scraping, RSS
feeds, API responses, file reads, GitHub webhooks, email ingestion.

- External content passed directly into agent context without sanitization
  (skills that call curl, fetch, or Playwright and inject raw HTML/JSON)
- Indirect injection: a web page containing "Ignore previous instructions..." —
  is there a sanitization step before this reaches the LLM?
- System prompt leakage: can an external actor cause the agent to print
  CLAUDE.md, MEMORY.md, or SYSTEM.md by crafting malicious input?
- Skills that read community-authored files and execute instructions from them
  without review
- Inbox skills that process sender-controlled content as instructions

## VECTOR 2 — SECRETS MANAGEMENT

- Hardcoded API keys, tokens, passwords in non-`.env` files (patterns like
  `sk-`, `Bearer `, `token=`, `password=`, `secret=`, `api_key=`)
- Secrets appearing in MEMORY.md, logs, or state files
- Secrets passed as tool-call arguments that land in context and logs
- Whether `.env` / `secrets.env` are in `.gitignore`
- Whether any skill or script echoes or logs secret values
- Secret rotation practices — static indefinitely, or refreshed?
- Secrets in git history (`git log --all -- .env` where possible)

## VECTOR 3 — NETWORK SECURITY

- Open ports: HTTP server, webhook listener, MCP server — bound to `0.0.0.0`
  or `127.0.0.1`?
- Outbound HTTP: arbitrary outbound calls via Bash/fetch? Any allowlist?
- Webhook endpoints: are inbound webhooks (Telegram, GitHub) signature/token
  verified before the payload is processed?
- SSRF risk: can a user-controlled URL reach internal addresses
  (169.254.x.x, 10.x.x.x, localhost)?
- DNS rebinding: any re-validation of destination IP after DNS resolution?
- TLS verification: any `curl -k` or equivalent disabling cert validation?

## VECTOR 4 — AUTHENTICATION AND AUTHORIZATION

- Telegram bot: token stored safely? Webhook handler verifies the request is
  from Telegram (secret_token or IP allowlist)?
- Multi-agent trust: when this agent receives a bus message from another
  agent, does it blindly execute? Is sender identity verified?
- Inbound message authorization: sender whitelist, or open to any source?
- Approval-gate bypasses: can a message from a non-human (orchestrator agent,
  relayed instruction) cause the agent to skip human-approval guardrails?
- API authentication: per-request token validation, or unauthenticated?

## VECTOR 5 — INFORMATION SOURCES

- Map every external data source: RSS, web scrape targets, GitHub repos,
  community platforms, email, social scrapers, DB queries
- For each: could a malicious actor controlling that source inject
  instructions into the agent's context?
- Community skill provenance: are skills audited before install, or pulled
  and executed without review?
- Is any file placed in the skills directory automatically executed?
- Do any skills read files from paths an external actor could write to?

## VECTOR 6 — EXTERNAL CONNECTIONS AND EXFILTRATION

- List every external API the agent can call autonomously without human
  approval (Telegram, email, Supabase, etc.)
- For each: what data could be sent out? Could the agent be instructed to
  exfiltrate MEMORY.md, credentials, or PII to an external endpoint?
- File system write scope: can the agent write outside `AGENT_DIR`?
- Shell execution scope: are Bash commands sandboxed or system-wide?
- Any skills that POST arbitrary content to external URLs where the content
  could include sensitive memory/context data?

## VECTOR 7 — CODE EXECUTION SAFETY

- Command injection: scripts interpolating user-controlled or
  externally-sourced strings into shell commands without quoting/escaping
- Path traversal: file ops using unsanitized paths that could escape
  `AGENT_DIR` (`../../etc/passwd`)
- Arbitrary file write to sensitive system paths
- Privilege escalation: sudo calls, SUID bits, scripts run as root
- Interpreter injection: eval/exec/dynamic require()/import() built from
  external data
- Can `rm -rf` or equivalent destructive commands be triggered via prompt?

## VECTOR 8 — MCP TOOL SECURITY

- List all MCP servers and their permission scopes
- For each: blast radius if compromised
- Are MCP tool permissions scoped minimally (read-only where sufficient)?
- Can MCP tools be invoked with arguments triggering SSRF, file traversal,
  or code execution?
- Is there an allowlist of approved MCP servers, or can any be added
  dynamically?

## VECTOR 9 — MEMORY AND PERSISTENCE SECURITY

- Is sensitive data written to memory (keys, PII, financial data, tokens)?
- KB ingestion: what gets indexed? Could a malicious document in the KB
  cause future prompt injection?
- Are memory files world-readable (check filesystem permissions)?
- Retention policy, or do memory files grow indefinitely with sensitive data?
- Do heartbeat/cron logs record raw API responses that could contain secrets?
- Are memory writes atomic / free of TOCTOU races?

## VECTOR 10 — APPROVAL GATES AND BLAST RADIUS

- List all actions taken WITHOUT human approval
- List all actions that DO require approval (check GUARDRAILS.md)
- For each autonomous action: worst-case outcome if triggered maliciously
- Are approval gates enforced in code/config, or prompt-only? (Prompt-only
  gates can be bypassed via injection.)
- Is there a rate limit / circuit breaker on autonomous actions?
- Identify the highest blast-radius autonomous action and assess how easily
  it could be triggered unintentionally

---

## OUTPUT FORMAT

Produce findings in this exact structure:

### SECURITY SCORE: [0-100]
(100 = no findings. Subtract: 15 per CRITICAL, 8 per HIGH, 3 per MEDIUM, 1 per LOW.)

### FINDINGS TABLE

| # | Category | Severity | Finding | Location | Recommended Fix |
|---|----------|----------|---------|----------|-----------------|

List ALL findings. Do not truncate. If a vector has no findings, include one
row for it: "No issues found".

### PRIORITIZED FIX LIST

Top findings to address first, ordered by severity then blast radius. For each:
1. [Finding title] — [Why it is urgent] — [Exact fix: file, code to add/remove]

### SUMMARY

One paragraph (4-6 sentences): overall posture, most dangerous attack surface,
whether the agent is safe to run as-is, and the single most important change
to make immediately.

---

## After the audit

- Save the report to the auditing agent's memory directory.
- Surface CRITICAL/HIGH findings to the orchestrator and user immediately;
  do not let them queue silently.
- Never include raw secret values in the report, memory, or any message.
