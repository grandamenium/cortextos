# Larry UX Parity Spec — "Feels like Claude Code"

**Date:** 2026-05-15
**Owner:** Larry plans → codexer implements → Larry adversarial reviews → PR to main → Josh approves
**Goal:** Close the 4 specific UX gaps between working with Larry (via Telegram + cortextos) and working with Claude Code in a terminal.

## Why

Josh's question 2026-05-15: "can we get me to a point where working with larry feels this good as working in this terminal window?"

Today's diagnosis identified 4 mechanical gaps. None are about model intelligence — all 4 are infrastructure-level UX. Solving them makes Larry feel transparent and responsive like Claude Code in a terminal.

## Item 1: Streaming Telegram responses

**Current:** Larry's responses arrive as completed Telegram messages, sometimes with 30-60s gaps while he's still thinking/working. Reads as "Larry went away."

**Target:** First-character latency <2s. Updates smoothly while Larry generates. Mirrors the "watching tokens stream" experience of terminal Claude Code.

**Implementation:**
- Add `--streaming` flag to `cortextos bus send-telegram`
- Daemon hooks into Larry's assistant message stream; emits `Telegram.editMessageText` calls every N tokens or M ms (whichever fires first; suggest N=20 tokens or M=400ms)
- Initial send uses `sendMessage`; subsequent updates use `editMessageText` against the returned `message_id`
- Telegram API rate limit is ~1 edit/sec per chat — clamp emit cadence to ≤1 edit/sec
- Telegram strips formatting on edits — preserve markdown by re-applying on every edit

**Files:**
- `cortextos/src/daemon/telegram-streamer.ts` (new, ~150 lines)
- `cortextos/src/cli/bus.ts` (extend `send-telegram` with `--streaming` flag)
- `cortextos/src/daemon/agent-process.ts` (hook stream → telegram-streamer)

**Acceptance:**
- ☐ First character visible in Telegram within 2s of Larry starting to generate
- ☐ Updates flow smoothly (≤1 edit/sec, no rate-limit errors)
- ☐ Final message identical to non-streaming version
- ☐ Markdown formatting preserved across edits
- ☐ Works for both Telegram DMs and group chats

**Estimated effort:** ~6 agent-hours.

## Item 2: Rolling conversation buffer across restarts

**Current:** When Larry restarts (threshold trigger), he boots from handoff doc snapshot only. Josh's last 5 messages are lost — Larry only sees the handoff-doc summary of them. This causes the "Larry forgot what I just said" pattern.

**Target:** Last N turns (suggest N=20) of Josh-Larry messages preserved verbatim across restarts. Handoff doc remains a summary layer, but the buffer is the literal record. New session reads BOTH on boot.

**Implementation:**
- Bus message logger writes every Josh→Larry and Larry→Josh message to `~/.cortextos/cortextos1/state/larry/conversation-buffer.jsonl` (append-only, one JSON per line, with timestamp + sender + content)
- Buffer rotates: keep last N=20 turns; older entries archived to `conversation-buffer-archive.jsonl`
- Session bootstrap (AGENTS.md step) reads the last 20 entries and includes them in the session-start context
- Handoff doc still gets written at threshold — but now it's compression ON TOP of literal recent turns, not the sole record

**Files:**
- `cortextos/src/daemon/conversation-buffer.ts` (new, ~120 lines)
- `cortextos/src/daemon/bus-message-handler.ts` (extend: write to buffer on every Telegram exchange)
- `cortextos/orgs/clearworksai/agents/larry/AGENTS.md` (add buffer load step to session start)
- `cortextos/orgs/clearworksai/agents/frank2/AGENTS.md` (same)
- `cortextos/orgs/clearworksai/agents/codexer/AGENTS.md` (same)

**Acceptance:**
- ☐ After Larry restart, he can quote Josh's most-recent 5 messages verbatim
- ☐ Buffer file exists at expected path with N latest turns
- ☐ Archive rotation works (buffer.jsonl ≤ N entries; older in archive.jsonl)
- ☐ Session bootstrap includes buffer content in initial context
- ☐ Buffer survives daemon restart (not just session restart)

**Estimated effort:** ~6 agent-hours.

## Item 3: Defer restart while mission is in-progress

**Current:** Threshold fires regardless of in-progress mission. Today Larry restarted 5× in 44 min because thresholds fired during a single conceptual task. To Josh this reads as Larry abandoning the work mid-flight.

**Target:** Threshold-triggered restart is deferred when `state/current-mission.txt` exists AND mission is active. Hard cap at 90% absolute context to prevent runaway.

**Implementation:**
- `daemon/ctx-monitor.ts` checks for `${CTX_AGENT_DIR}/state/current-mission.txt` before triggering handoff
- If mission file exists AND mtime < 2h old AND ctx% < 90 → defer handoff trigger; log `cortextos bus log-event action restart_deferred info` with the mission summary
- If ctx% ≥ 90 → emergency restart fires regardless (with explicit Telegram alert to Josh: "Larry restarting mid-mission at 90% — mission was: <summary>")
- Mission file cleanup happens via existing protocol (Larry removes it on completion); deferred restart waits for that signal

**Files:**
- `cortextos/src/daemon/ctx-monitor.ts` (modify trigger logic)
- `cortextos/orgs/clearworksai/agents/larry/CLAUDE.md` (already documents mission file protocol — no change needed)

**Acceptance:**
- ☐ Restart frequency drops by ≥50% during normal multi-step tasks (measured: 2h sample with active mission file)
- ☐ Hard cap fires at 90% absolute context; no daemon hang at high ctx
- ☐ Telegram alert sent when emergency restart fires mid-mission
- ☐ No mission-file orphans (cleared on session end as expected)
- ☐ Works for all agents (larry, frank2, codexer) — not just Larry

**Estimated effort:** ~3 agent-hours.

## Item 4: Real-time tool result visibility

**Current:** When Larry runs `Bash`, `Read`, `Write`, `Edit` — the output/diff goes to logs that Josh has to grep. Reads as "Larry is doing... something."

**Target:** Tool call + result surfaced to chat (Telegram or dashboard) within 5s of execution. Mirrors the terminal experience of seeing what the agent runs and what comes back.

**Implementation:**
- Hook into Claude Code's `PostToolUse` event in `~/.claude/settings.json` (cortextos already uses PreToolUse for permission gates — add PostToolUse counterpart)
- Hook script `cortextos/dist/hooks/hook-tool-result-router.js` writes the tool call + result preview (first 500 chars + line count) to the agent's dispatch-events stream
- Daemon subscribes to dispatch-events; emits a "Larry ran: <tool> — output: <preview>" Telegram message
- For long outputs: emit summary in Telegram + full content in dashboard activity feed
- Suppress for trivial tools (heartbeat updates, log-event calls — already silent)

**Files:**
- `cortextos/src/hooks/hook-tool-result-router.ts` (new, ~100 lines)
- `cortextos/src/daemon/dispatch-events-router.ts` (extend: route tool results to Telegram/dashboard)
- `cortextos/orgs/clearworksai/agents/larry/.claude/settings.json` (register PostToolUse hook)

**Acceptance:**
- ☐ Josh sees a tool-call notification in Telegram or dashboard within 5s of Larry running a non-trivial tool
- ☐ Output preview (first 500 chars) included in the notification
- ☐ Trivial tools (heartbeat, log-event, update-cron-fire) suppressed
- ☐ Long outputs surface as "see dashboard" link, not 10K-char Telegram messages
- ☐ Works for Larry, Frank2, Codexer

**Estimated effort:** ~6 agent-hours.

## Sequencing

These four can largely run in parallel, but some dependencies:

- Item 2 (rolling buffer) and Item 3 (defer restart) interact: with buffer in place, the cost of a restart is much lower (context survives), so defer-restart becomes less critical. Recommend implementing Item 2 first; then Item 3 is incremental.
- Item 1 (streaming) and Item 4 (tool visibility) are independent of each other and of Items 2/3.

**Suggested order:**
1. **Item 2** (rolling buffer) — biggest "feels different" gap closer; foundation for others
2. **Item 1** (streaming) — high-visibility, mostly self-contained
3. **Item 4** (tool visibility) — high-visibility, builds on dispatch-events infra
4. **Item 3** (defer restart) — last because Item 2 reduces restart cost; this is the polish

## Total effort

~21 agent-hours. Adds to master plan as **Block K** — parallel-safe with all other framework work (G/H/I). Can run alongside V2 enablement (Blocks A-F) without blocking.

## Out of scope

- Replacing Telegram with a dedicated chat UI (mentioned as long-tail "Item 5" in the chat). That's a separate effort — building a dashboard chat panel. Could be Block L in a follow-up.
- Local-model fine-tuning on lessons.jsonl. That's Block H+future.
- Changing Larry's actual model (still Sonnet 4.6 at 200K).

## Acceptance for the whole spec

When all 4 items ship:
- Josh sends Larry a message
- Larry's response starts streaming in Telegram within 2 seconds
- Larry runs tools — Josh sees each one in chat with output preview
- Mid-conversation, Larry hits a context threshold — restart deferred until current mission completes
- Eventually a restart fires — new session boots, Larry can quote Josh's last 5 messages verbatim
- The experience reads as "talking to Claude Code over chat" rather than "Telegramming a black-box agent."
