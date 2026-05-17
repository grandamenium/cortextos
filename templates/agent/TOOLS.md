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

### Claude Code Hooks
Invoked by Claude Code via `.claude/settings.json` `hooks` config — do not call directly. Reads hook payload from stdin (JSON), exits 0 always (non-blocking).
| Command | Hook event | What it does |
|---|---|---|
| `hook-context-status` | StatusLine | Writes context window % to `state/context_status.json` |
| `hook-ask-telegram` | PreToolUse (AskUserQuestion) | Forwards question to Telegram (cross-platform) |
| `hook-permission-telegram` | PermissionRequest | Sends approve/deny request to Telegram |
| `hook-planmode-telegram` | ExitPlanMode | Sends plan to Telegram for review |
| `hook-compact-telegram` | PreCompact | Notifies user via Telegram when context compaction starts |
| `hook-extract-facts` | PreCompact | Mines compaction summary into `memory/facts/YYYY-MM-DD.jsonl` for cross-session recall |
| `hook-idle-flag` | Stop | Writes `last_idle.flag` timestamp so fast-checker knows agent finished its turn |
| `hook-episodic-post-tool` | PostToolUse | Appends structured episodic entry (tool, args_hash, importance, pain_score, reflection) to `memory/episodic/learnings.jsonl`. Reads `protocols/hook_patterns.json` for importance scoring. Bumps `state/failure-counters.json` on errors; flags rewrite at 3 failures in 14d. Adopted 2026-05-08 from agentic-stack pattern. |

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

### Peekaboo (macOS Desktop Automation — FULL Computer-Use Stack)

**Peekaboo v3.1.2 (MIT, github.com/steipete/Peekaboo) is a complete computer-use stack — NOT just a screenshot tool.** Action-first interaction model: reads the macOS AX (accessibility) tree to find elements by name/role, then acts. Synthetic input (coordinate-based) as fallback. Can reliably click "Save" in Xcode without knowing pixel coordinates.

**Required macOS permissions:** Screen Recording + Accessibility. Both granted on HARPAL.

**Capability set (full MCP tool list):**

| Tool | Purpose |
|---|---|
| `image` / `capture` / `see` | ScreenCaptureKit screenshot (window / app / display / region) |
| `click` | Left/right/double-click by element ID, fuzzy text, or coordinates |
| `type` | Human-WPM cadence text input; `--clear` / `--return` / `--tab` / `--escape` / `--delete` modifiers |
| `set-value` | Direct AX-API field set — faster than `type` for forms |
| `perform-action` | Trigger any AX action on an element (press, increment, show menu, etc.) |
| `press` / `hotkey` | Single-key press and chord combos (`Cmd+S`, `Ctrl+Shift+T`, ...) |
| `scroll` / `drag` / `swipe` / `move` | Mouse + trackpad gestures |
| `window` / `app` / `space` | Window position/size/focus, app launch/quit, macOS Spaces switching |
| `menu` / `menubar` / `dock` / `dialog` | First-class UI element interaction (menu items, dock icons, system dialogs) |
| `agent` | Natural-language multi-step automation loop with OpenAI / Anthropic / Ollama backend |

**Quick recipes:**

```bash
# Screenshot the running HUD
peekaboo image --app "Google Chrome for Testing" -o /tmp/hud.png

# Click "Save" in the focused app without coords
peekaboo click "Save"

# Type into a focused field then press Return
peekaboo type "hello world" --return

# Multi-step natural-language flow
peekaboo agent "open Notes, create a new note titled Daily Log, type today's date"
```

**See-diff-fix loop** (pattern for UI alignment work; see `community/skills/see-diff-fix/` once shipped):
1. `peekaboo image --app <App> -o /tmp/current.png`
2. `auto-image-diff reference.png /tmp/current.png -o /tmp/diff.png` (subimage-aligned, no false layout-shift positives)
3. Send `(reference, current, diff)` to Claude Vision with structured-JSON prompt
4. Apply each `code_fix` via Edit/Bash
5. `peekaboo hotkey "Cmd+R"` to hot-reload → loop until diff empty

`peekaboo learn` prints the in-binary capability guide. Use it when the AX tree is unfamiliar.

### gogcli (Google Workspace)
- Binary: `gog` (v0.12.0 at `/opt/homebrew/bin/gog`)
- Gmail, Calendar, Drive, Contacts, Tasks, Sheets, Docs
- Accounts: configure your Google accounts in your agent's `.env` or org `secrets.env`
- `gog gmail search "query" --max 10 -a you@gmail.com`
- `gog calendar ls -a you@gmail.com --max 5`
- Use `gog` instead of Gmail/Calendar MCP — more capable (send, archive, labels)
