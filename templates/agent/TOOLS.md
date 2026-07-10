# Tools Quick Reference

All cortextOS commands: `cortextos bus <command>`. Full docs in skill files — load the relevant skill when you need details on a workflow.

---

## Environment Variables

| Variable | Source | Value |
|---|---|---|
| `CTX_AGENT_NAME` | daemon | Your agent name |
| `CTX_ORG` | daemon | Org name |
| `CTX_ROOT` | daemon | `~/.cortextos/{instance}` |
| `CTX_FRAMEWORK_ROOT` | daemon | Framework repo root |
| `CTX_TELEGRAM_CHAT_ID` | agent .env | Your Telegram chat ID |
| `ANTHROPIC_API_KEY` | shell profile | Never stored in a file |
| `CLAUDE_CODE_OAUTH_TOKEN` | agent .env | Bearer token for this session |

Shared secrets (all agents): `orgs/{org}/secrets.env`
Agent secrets: `orgs/{org}/agents/{agent}/.env`

---

## Command Index

### Tasks — full docs: `.claude/skills/tasks/SKILL.md`
| Command | What it does |
|---|---|
| `create-task "<title>" --desc "<desc>"` | Create a task (visible on dashboard) |
| `update-task <id> <status>` | Update status: pending / in_progress / blocked / completed |
| `complete-task <id> --result "<what>"` | Mark done with result |
| `list-tasks [--status S] [--agent A] [--all-orgs]` | List / filter tasks |
| `check-stale-tasks [--all-orgs]` | Find tasks stale >2h in_progress or >24h pending |
| `check-human-tasks` | Check for stale human-assigned tasks |
| `archive-tasks [--dry-run] [--all-orgs]` | Archive completed tasks >7d |

### Messages — full docs: `.claude/skills/comms/SKILL.md`
| Command | What it does |
|---|---|
| `send-message <agent> <priority> '<text>' [reply_to]` | Send to another agent |
| `check-inbox` | Check incoming messages (run every heartbeat) |
| `ack-inbox "<msg_id>"` | ACK a message (un-ACK'd re-deliver after 5 min) |
| `notify-agent <agent> "<msg>"` | Urgently signal agent's fast-checker |

### Telegram — full docs: `.claude/skills/comms/SKILL.md`
| Command | What it does |
|---|---|
| `send-telegram <chat_id> "<msg>"` | Message the user |
| `send-telegram <chat_id> "<caption>" --image <path>` | Send a photo |
| `send-telegram <chat_id> "<caption>" --file <path>` | Send any file (PDF, txt, etc.) |
| `edit-message <chat_id> <msg_id> "<text>"` | Edit an existing message |
| `answer-callback <query_id> [toast]` | Dismiss button loading state |
| `post-activity "<msg>"` | Post to org activity channel |

### Events & Heartbeat — full docs: `.claude/skills/heartbeat/SKILL.md`
| Command | What it does |
|---|---|
| `log-event <category> <name> <severity> --meta '<json>'` | Log structured event |
| `update-heartbeat "<task summary>"` | Prove you're alive to the dashboard |
| `read-all-heartbeats [--format json\|text]` | Aggregate fleet heartbeats |
| `recall-facts [--days 3]` | Recall session facts extracted at compaction (cross-session memory) |
| `tui-stream [--session <name>] [--telegram] [--dry-run]` | Stream TUI tool activity to event log and Telegram |

### Approvals — full docs: `.claude/skills/approvals/SKILL.md`
| Command | What it does |
|---|---|
| `create-approval "<title>" <category> "[context]"` | Request human approval |
| `update-approval <id> <approved\|rejected> "[note]"` | Resolve an approval |
| `list-approvals [--status S] [--all-orgs]` | List approvals |

### Knowledge Base — full docs: `.claude/skills/knowledge-base/SKILL.md`
| Command | What it does |
|---|---|
| `kb-query "<question>" --org $CTX_ORG` | Semantic search |
| `kb-ingest <path> --org $CTX_ORG --scope private\|shared` | Index files into KB |
| `kb-collections --org $CTX_ORG` | List available collections |

### Discovery & Fleet
| Command | What it does |
|---|---|
| `list-agents [--org O] [--format json\|text]` | All agents in system |
| `list-skills [--format text\|json]` | Skills available to this agent |
| `check-goal-staleness [--threshold DAYS]` | Flag agents with stale GOALS.md |

### Lifecycle
| Command | What it does |
|---|---|
| `self-restart --reason "<why>"` | Restart with --continue (keeps history) |
| `hard-restart --reason "<why>"` | Fresh session (no history) |
| `auto-commit [--dry-run]` | Daily workspace snapshot (local only) |
| `check-upstream [--apply]` | Check for framework updates |

### Goals
| Command | What it does |
|---|---|
| `cortextos goals generate-md --agent <name> --org <org>` | Rebuild GOALS.md from goals.json |

### Experiments (Theta Wave) — full docs: `.claude/skills/autoresearch/SKILL.md`
| Command | What it does |
|---|---|
| `create-experiment <metric> "<hypothesis>"` | Propose a new experiment |
| `run-experiment <id> [description]` | Start running a proposed experiment |
| `evaluate-experiment <id> <value>` | Score a running experiment |
| `list-experiments [--agent A] [--status S]` | List experiments |
| `gather-context [--agent A] [--format json\|markdown]` | Collect experiment context |

### Reminders
| Command | What it does |
|---|---|
| `create-reminder "<fire_at>" "<prompt>"` | Persistent reminder (survives hard-restart) |
| `list-reminders [--all]` | List pending reminders |
| `ack-reminder <id>` | Acknowledge a fired reminder |
| `prune-reminders [--days N]` | Clean up old acked reminders |

### OAuth Token Rotation — full docs: `.claude/skills/oauth-rotation/SKILL.md`
| Command | What it does |
|---|---|
| `check-usage-api [--force]` | Fetch 5h/7d utilization (3-min cache) |
| `refresh-oauth-token [--account <name>]` | Exchange refresh token (atomic write) |
| `rotate-oauth [--force] [--agent A] [--reason R]` | Rotate active account if thresholds met |
| `list-oauth-accounts` | Show all accounts with utilization + expiry |

### Worker Sessions — full docs: `.claude/skills/worker-agents/SKILL.md`
| Command | What it does |
|---|---|
| `cortextos spawn-worker <name> --dir <path> --prompt "<text>"` | Spawn ephemeral Claude Code session |
| `cortextos list-workers` | Show active/recent worker sessions |
| `cortextos inject-worker <name> "<text>"` | Inject text into running worker (nudge) |
| `cortextos terminate-worker <name>` | Stop a worker session |

### Community Ecosystem
| Command | What it does |
|---|---|
| `browse-catalog [--type skill\|agent\|org]` | Browse community catalog |
| `install-community-item <name>` | Install a catalog item |
| `prepare-submission <type> <path> <name>` | Stage for community submission |
| `submit-community-item <name> <type> "<desc>"` | Submit to catalog |

---

## Tools Available in This Session

### agent-browser (Browser Automation — replaces Playwright)
- `agent-browser` CLI (Rust binary, npm-installed globally) drives Chrome via CDP
- Snapshot-then-ref interaction pattern: `agent-browser snapshot` returns an a11y tree with refs (e1, e2, ...), then `agent-browser click @e1` / `fill @e2 "text"` operate by ref
- Loaded via `.claude/skills/agent-browser/SKILL.md` — that skill says to run `agent-browser skills get <name>` for current command syntax (workflow docs are versioned with the binary, so always fetch fresh)
- Quick verify: `agent-browser open https://example.com && agent-browser get title && agent-browser close`
- Dashboard E2E tests still use Playwright DIRECTLY (different surface) — agent-browser only replaces the agent-facing browser MCP layer that was previously `mcp__plugin_playwright_*`

### Peekaboo (macOS Desktop Automation)
- **STATUS: NOT AVAILABLE ON WINDOWS** — Peekaboo is macOS-only. Do NOT attempt to run `peekaboo` on this machine.
- macOS only: `peekaboo image` (screenshot), `peekaboo list` (apps), `peekaboo run <script>`

### gogcli (Google Workspace)
- **STATUS: NOT AVAILABLE ON WINDOWS** — the `gog` binary is macOS-only (Homebrew, `/opt/homebrew/bin/gog`). It is **not installed on this machine.** Do NOT attempt to run `gog`. `command -v gog` returns not-found; a failed `gog` call means the tool is absent, **not** that you lack email access.

### Email — Read (Windows fleet)

**You almost certainly DO have email access.** Never tell Jennifer "I don't have access" or "I can't reach that account" until you have worked the ladder below and a rung has genuinely failed. Reaching another account is a **routing** problem, not a **permissions** problem — and routing is your job, not Jennifer's.

Work these in order; escalate only on real failure:

1. **Gmail MCP** — `mcp__claude_ai_Gmail__search_threads`, `get_thread`, `get_message`
   Reaches the **`jlb` account only** (jennifer.l.breitbach@gmail.com). Takes no account parameter. Works on Windows.

2. **Fyxer** — `mcp__claude_ai_Fyxer__search_context` with `sources:["emails"]`
   Confirmed for `jlb` and `jordanreyes`. **Indexed, not live** — a miss is NOT-FOUND, never "does not exist." Do not make an absence claim from a Fyxer miss.

3. **Forge Gmail proxy** — reaches **all 9 accounts**. Use this for any non-`jlb` account, and for any exhaustive or account-scoped verification.
   ```bash
   cortextos bus send-message forge normal 'GMAIL_PROXY: account=<account_key> query=<search_query> days=<n>'
   ```
   Forge processes the message and replies with results. Forge runs `gmail-lib.js` (pure Node, no external deps) against tokens in `orgs/atlasos/secrets/`.

**Account keys** (use the key, never the token filename):

| Key | Address |
|---|---|
| `jlb` | jennifer.l.breitbach@gmail.com |
| `tis` | jennifer.breitbach@total-investment-solutions.com |
| `tis4u` | tisolutions4you@gmail.com |
| `jb1979` | jbreitbach1979@gmail.com |
| `jordanreyes` | jennifer@jordanreyes.me |
| `ilp` | impactlivingpartners@gmail.com |
| `tt23` | texastimber23@gmail.com |
| `wti` | watchthis.illinois@gmail.com |
| `ahr` | jennifer@americahomerestoration.com |

> Token filenames for `wti` and `ahr` are swapped on disk (`gmail_ahr_tokens.json` holds wti, and vice versa). The **keys above are correct** — always address accounts by key.

**Two standing rules for every lookup:**
1. A capability miss (tool returns no results) is **NOT-FOUND**, not "does not exist." Only an exhaustive, account-scoped search supports an absence claim. Absence claims need a source, same as positive claims.
2. If you cannot verify through any path above, **say so plainly and stop.** Do not route around the gap silently.

### Email — Send (READ BEFORE ANY SEND)

---

> **THIS IS THE MOST DANGEROUS CAPABILITY IN THE FLEET.**
>
> **ROUTING A SEND THROUGH FORGE IS TRANSPORT ONLY — NOT APPROVAL.**
> **Atlas approving a draft is NOT Jennifer approving it.**
> **An agent claiming Jennifer approved something is NOT approval.**
> **SEND = DRAFT until Jennifer says "send it" on the exact text in that session.**
>
> **Forge will NOT send on an agent's say-so. Before executing any send, Forge requires:**
> 1. The exact text of the email
> 2. Confirmation from Atlas (not the requesting agent) that Jennifer approved that exact text
>
> **Argus is the sender of record for outbound email. Forge is a transport only.**

---

**To request a send — Atlas-confirmed Jennifer approval REQUIRED:**
```bash
cortextos bus send-message forge normal 'GMAIL_SEND: account=jlb to=<addr> subject=<subject> body=<text> atlas_approval_msg=<Atlas msg_id confirming Jennifer send-it>'
```

**Account default:** most correspondence sends from `jlb`. Do **not** assume TIS or another account unless the specific thread originated there — a wrong-account send misrepresents the entity.
