# Tools Quick Reference (codex-app-server)

All cortextOS commands: `cortextos bus <command>`. Full docs in skill files — read the relevant SKILL.md (`plugins/cortextos-agent-skills/skills/<name>/SKILL.md`) when you need details on a workflow.

---

## ⚡ Telegram Reply — Primary Outbound Channel

When a `=== TELEGRAM from <name> (chat_id:<id>) ===` block appears in your session, the inject ends with:

```
Reply using: cortextos bus send-telegram <chat_id> '<your reply>'
```

**Run that exact command.** This is the only way a codex agent reaches the user. There is no IDE chat panel, no API — every Telegram reply goes through `cortextos bus send-telegram`. Do this BEFORE any other action.

```bash
# Reply to user
cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID 'message text'

# Reply with a photo
cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID 'caption' --image /path/to/file.png

# Reply with any file
cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID 'caption' --file /path/to/file.pdf
```

---

## Environment Variables

| Variable | Source | Value |
|---|---|---|
| `CTX_AGENT_NAME` | daemon | Your agent name |
| `CTX_ORG` | daemon | Org name |
| `CTX_ROOT` | daemon | `~/.cortextos/{instance}` |
| `CTX_FRAMEWORK_ROOT` | daemon | Framework repo root |
| `CTX_AGENT_DIR` | daemon | Your agent working directory |
| `CTX_TELEGRAM_CHAT_ID` | agent .env | Your Telegram chat ID |
| `BOT_TOKEN` | agent .env | Telegram bot token |
| `OPENAI_API_KEY` | shell profile / org secrets | Codex backend auth |
| `GEMINI_API_KEY` | org secrets.env | KB embedding |

Shared secrets (all agents): `orgs/{org}/secrets.env`
Agent secrets: `orgs/{org}/agents/{agent}/.env`

---

## Command Index

### Tasks — full docs: `plugins/cortextos-agent-skills/skills/tasks/SKILL.md`
| Command | What it does |
|---|---|
| `create-task "<title>" --desc "<desc>"` | Create a task (visible on dashboard) |
| `update-task <id> <status>` | Update status: pending / in_progress / blocked / completed |
| `complete-task <id> --result "<what>"` | Mark done with result |
| `list-tasks [--status S] [--agent A] [--all-orgs]` | List / filter tasks |
| `check-stale-tasks [--all-orgs]` | Find tasks stale >2h in_progress or >24h pending |
| `check-human-tasks` | Check for stale human-assigned tasks |
| `archive-tasks [--dry-run] [--all-orgs]` | Archive completed tasks >7d |

### Messages — full docs: `plugins/cortextos-agent-skills/skills/comms/SKILL.md`
| Command | What it does |
|---|---|
| `send-message <agent> <priority> '<text>' [reply_to]` | Send to another agent |
| `check-inbox` | Check incoming messages (run every heartbeat) |
| `ack-inbox "<msg_id>"` | ACK a message (un-ACK'd re-deliver after 5 min) |
| `notify-agent <agent> "<msg>"` | Urgently signal agent's fast-checker |

### Telegram — full docs: `plugins/cortextos-agent-skills/skills/comms/SKILL.md`
| Command | What it does |
|---|---|
| `send-telegram <chat_id> "<msg>"` | **Primary user-facing channel — every Telegram reply goes here** |
| `send-telegram <chat_id> "<caption>" --image <path>` | Send a photo |
| `send-telegram <chat_id> "<caption>" --file <path>` | Send any file (PDF, txt, etc.) |
| `edit-message <chat_id> <msg_id> "<text>"` | Edit an existing message |
| `answer-callback <query_id> [toast]` | Dismiss button loading state |
| `post-activity "<msg>"` | Post to org activity channel |

### Events & Heartbeat — full docs: `plugins/cortextos-agent-skills/skills/heartbeat/SKILL.md`
| Command | What it does |
|---|---|
| `log-event <category> <name> <severity> --meta '<json>'` | Log structured event |
| `update-heartbeat "<task summary>"` | Prove you're alive to the dashboard |
| `read-all-heartbeats [--format json\|text]` | Aggregate fleet heartbeats |
| `recall-facts [--days 3]` | Recall session facts extracted at compaction (cross-session memory) |

### Approvals — full docs: `plugins/cortextos-agent-skills/skills/approvals/SKILL.md`
| Command | What it does |
|---|---|
| `create-approval "<title>" <category> "[context]"` | Request human approval |
| `update-approval <id> <approved\|rejected> "[note]"` | Resolve an approval |
| `list-approvals [--status S] [--all-orgs]` | List approvals |

### Knowledge Base — full docs: `plugins/cortextos-agent-skills/skills/knowledge-base/SKILL.md`
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

### Crons — full docs: `plugins/cortextos-agent-skills/skills/cron-management/SKILL.md`
| Command | What it does |
|---|---|
| `add-cron <agent> <name> <schedule> <prompt>` | Add a persistent cron (survives restarts) |
| `list-crons <agent>` | Show scheduled crons + next_fire_at |
| `remove-cron <agent> <name>` | Delete a cron |
| `test-cron-fire <agent> <name>` | Inject the cron prompt now to verify wiring |
| `get-cron-log <agent>` | Execution history |

> `add-cron` is the ONLY persistent scheduling path on this runtime. There is no in-session scheduling tool — every recurring or future-dated job goes through the daemon.

### Experiments (Theta Wave) — full docs: `plugins/cortextos-agent-skills/skills/autoresearch/SKILL.md`
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

### Community Ecosystem
| Command | What it does |
|---|---|
| `browse-catalog [--type skill\|agent\|org]` | Browse community catalog |
| `install-community-item <name>` | Install a catalog item |
| `prepare-submission <type> <path> <name>` | Stage for community submission |
| `submit-community-item <name> <type> "<desc>"` | Submit to catalog |

---

## Tools Available in This Session

### Shell exec (codex-app-server primary tool)
- The codex runtime exposes a sandboxed shell to you. Every action listed above runs through it: `cortextos bus <cmd>`, `git`, `gh`, `npm`, file edits via standard editors, `jq`, `grep`, `curl`, etc.
- Reading and writing files: just use shell (`cat`, the appropriate editor, `>` redirection). There is no Read/Edit/Write tool — those are Claude-Code-internal and do not exist here.
- For file inspection prefer `cat` / `sed -n` / `head` / `tail`; for edits prefer `sed -i` / `awk` / a redirect pipeline.

### agent-browser (Browser Automation)
- `agent-browser` is the framework's Chrome/CDP browser automation tool — runtime-agnostic CLI, no MCP setup required. It is the codex equivalent of (and replacement for) the `mcp__playwright__*` tools that Claude-Code-runtime agents formerly used.
- `agent-browser` CLI (Rust binary, npm-installed globally) drives Chrome via CDP
- Snapshot-then-ref interaction pattern: `agent-browser snapshot` returns an a11y tree with refs (e1, e2, ...), then `agent-browser click @e1` / `fill @e2 "text"` operate by ref
- Loaded via `plugins/cortextos-agent-skills/skills/agent-browser/SKILL.md` — that skill says to run `agent-browser skills get <name>` for current command syntax (workflow docs are versioned with the binary, so always fetch fresh)
- Quick verify: `agent-browser open https://example.com && agent-browser get title && agent-browser close`

### Peekaboo (macOS Desktop Automation)
- `peekaboo image` (screenshot), `peekaboo list` (apps), `peekaboo run <script>`
- Screen Recording + Accessibility permissions granted
- `peekaboo learn` for full usage guide

### gogcli (Google Workspace)
- Binary: `gog` (v0.12.0 at `/opt/homebrew/bin/gog`)
- Gmail, Calendar, Drive, Contacts, Tasks, Sheets, Docs
- Accounts: configure your Google accounts in your agent's `.env` or org `secrets.env`
- `gog gmail search "query" --max 10 -a you@gmail.com`
- `gog calendar ls -a you@gmail.com --max 5`

---

## Reminder

Every Telegram message ends with a `Reply using: cortextos bus send-telegram <chat_id> '<reply>'` line. **Run that command.** Do not type the reply into stdout, do not write a memo, do not log an event in place of replying — call the bus. The user reads what comes out of `cortextos bus send-telegram`. Nothing else reaches them.
