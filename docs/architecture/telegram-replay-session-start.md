# Telegram Replay + Stale-Task Warning on Session Start

**Status:** Design — not yet implemented
**Priority:** High (silent message loss with real client impact; theta 63 primary deliverable)
**Owner:** develop (implementation), analyst (design), gc-admin (first live-verify target)
**Last updated:** 2026-08-13
**Related:** theta 63, `project_telegram_loss_on_restart`

---

## Problem

`fast-checker` injects Telegram messages into the agent's live PTY as they arrive. Every inbound message is durably archived to `logs/<agent>/inbound-messages.jsonl` via `recordInboundTelegram()` (`src/telegram/logging.ts:89`). But if the PTY is not alive at inject time — during a stop/restart/crash-recovery window — the archive lands and the injection is dropped. There is no replay on session start.

`check-inbox` covers agent-to-agent bus messages only, not Telegram.

**Live impact — 2026-08-13, gc-admin:** during a ~1h downtime window, 2 HelpDesk manager requests + 3 David DMs were archived but never surfaced. Discovered post-restart by manual heartbeat-cycle scan. Two of the requests had delivery-delay before response: 3.7h and 1.8h.

**Adjacent problem — orphaned in_progress tasks:** the same restart can leave a task in `in_progress` with artifacts on disk and no reply to the requester. There is no session-start signal to the agent about stale in-progress work.

---

## Root cause

1. `fast-checker.ts` polls Telegram and injects on arrival — pure push model, no persistent watermark.
2. `inbound-messages.jsonl` exists purely as an audit log; nothing reads it back.
3. Task state carries `updated_at`, but no reminder mechanism surfaces stale in-progress items on session start.

---

## Proposed fix — three parts, one PR

### Part 1 — Watermark replay of missed Telegram messages

New persistence:
```
state/<agent>/telegram-cursor.json
{
  "<chat_id_str>": <last_processed_message_id>,
  ...
}
```

New session-start hook (fires after PTY is spawn-ready but before first Telegram poll):

```typescript
async function replayMissedTelegram(agent: AgentContext): Promise<void> {
  const cursor = readCursor(agent);                             // {} if missing
  const now = Date.now();
  const window24hAgo = now - 24 * 3600 * 1000;
  const perChatCap = 100;

  const entries = tailScanInbound(agent);                        // parsed jsonl objects
  const missed = entries
    .filter(e => (cursor[String(e.chat_id)] ?? 0) < e.message_id)
    .filter(e => Date.parse(e.archived_at) >= window24hAgo)
    .sort((a, b) => a.archived_at.localeCompare(b.archived_at));

  // Per-chat cap: keep the LAST `perChatCap` entries per chat_id (freshest).
  const capped = capPerChat(missed, perChatCap);

  if (capped.length === 0) {
    initCursorIfMissing(agent, entries);                         // start-from-now
    return;
  }

  // Downtime detection: if the gap between now and last-alive marker > 4h, emit
  // one warning BEFORE replay so the agent sees the scope.
  const downtimeH = detectDowntime(agent, now);
  if (downtimeH > 4) {
    agent.injectMessage(
      `[STARTUP] Detected ${downtimeH.toFixed(1)}h downtime. Replaying ${capped.length} missed Telegram message(s) (bounded to last 24h, ${perChatCap}/chat).`
    );
  }

  for (const entry of capped) {
    const formatted = formatTelegramForInjection(entry);         // reuse existing formatter
    if (agent.injectMessage(formatted)) {
      cursor[String(entry.chat_id)] = entry.message_id;
      writeCursorAtomic(agent, cursor);
      emitEvent('telegram_replayed', {
        chat_id: entry.chat_id,
        message_id: entry.message_id,
        archived_at: entry.archived_at,
      });
    }
  }
}
```

Bounds:
- **Time cap:** entries older than 24h are skipped. Prevents avalanche after multi-day downtime.
- **Count cap:** at most 100 per `chat_id`. Prevents avalanche when one chat has a huge burst backlog.
- **First run:** no cursor file → treat as "start-from-now"; write current max message_id per chat, skip replay.

Live-inject path (unchanged) also updates the cursor on each successful inject so live and replay use the same source of truth.

### Part 2 — Stale in-progress task warning

New session-start hook (fires alongside Part 1):

```typescript
async function warnStaleTasks(agent: AgentContext, thresholdHours = 2): Promise<void> {
  const cutoff = Date.now() - thresholdHours * 3600 * 1000;
  const inProg = listTasks(agent, { status: 'in_progress' });
  const stale = inProg.filter(t => Date.parse(t.updated_at) < cutoff);
  if (stale.length === 0) return;

  const ids = stale.slice(0, 10).map(t => t.id).join(', ');
  const more = stale.length > 10 ? ` (+${stale.length - 10} more)` : '';
  agent.injectMessage(
    `[STALE-TASKS] ${stale.length} in-progress task(s) with updated_at > ${thresholdHours}h ago: ${ids}${more}. Review — decide to resume, complete, or drop.`
  );
  emitEvent('stale_tasks_warned', { count: stale.length });
}
```

Threshold `thresholdHours` is a config knob per agent, defaulting to 2 (tuneable if false-positives on long-running work).

Does NOT auto-reopen, auto-complete, or auto-drop. Only signals.

### Part 3 — Downtime detection helper

New file `state/<agent>/last-alive.txt` — single ISO timestamp, updated by fast-checker on every successful tick (piggyback on existing heartbeat/tick).

Read on session start; if `now - last_alive > 4h`, we're recovering from real downtime. Feeds Part 1's downtime warning and can be reused for future observability.

---

## Edge cases

- **Cross-chat ordering:** sort by `archived_at` ASC preserves chronology across chats.
- **Media messages:** existing formatter (`formatTelegramForInjection`) handles photo/voice/document/video — replay reuses it. No new code path.
- **Double-inject on crash mid-cursor-flush:** atomic write via `atomicWriteSync`. If the process still crashes after inject and before flush, next replay resurfaces the same message — agent should treat message_id as idempotency key (see `agent.injectMessage` dedup path).
- **PTY not ready:** replay only fires AFTER PTY spawn-ready signal. If PTY dies mid-replay, cursor advances only for successfully-injected entries; next restart resumes.
- **Chat_id types:** JSON key normalization — always cast `chat_id` to string when reading/writing cursor to avoid `-100...` int drift.
- **First-time boot:** no cursor file, no archive → skip both replay and warn (both no-op cleanly).
- **Retention:** `inbound-messages.jsonl` at 695KB after ~5 months growth ≈ 1.7MB/year. Tail-scan of that size is <20ms. Log rotation is orthogonal, not blocking. Track as future hygiene item.

---

## Test spec (for develop)

New tests in `tests/daemon/telegram-replay.test.ts` (or matching file). Use a fake agent context + in-memory JSONL fixture.

### Test 1 — no cursor, entries present → start-from-now

```
given: cursor file absent, inbound-messages.jsonl has 5 entries
when:  replayMissedTelegram runs on session start
then:  cursor is initialized with max message_id per chat
       agent.injectMessage NOT called (no replay on first run)
```

### Test 2 — cursor stale, entries newer, within 24h → replay in order

```
given: cursor = {chat_A: 100, chat_B: 200}
       jsonl has entries 101-105 (chat_A) and 201-203 (chat_B), all within 24h
when:  replay runs
then:  agent.injectMessage called 8 times in archived_at ASC order
       cursor updated to {chat_A: 105, chat_B: 203}
```

### Test 3 — entries older than 24h → skipped

```
given: cursor = {chat_A: 100}, jsonl has entry 101 with archived_at = 25h ago
when:  replay runs
then:  agent.injectMessage NOT called
       cursor stays at 100 (nothing to advance)
```

### Test 4 — per-chat cap enforced

```
given: cursor = {chat_A: 0}, jsonl has 150 entries for chat_A within 24h
when:  replay runs
then:  agent.injectMessage called 100 times (last 100 by archived_at DESC)
       cursor advances to the newest message_id
```

### Test 5 — downtime warning emitted when gap > 4h

```
given: last-alive.txt = 6h ago, missed entries present
when:  replay runs
then:  first injected message is [STARTUP] downtime warning
       subsequent injects are the replayed entries
```

### Test 6 — no downtime warning when gap < 4h

```
given: last-alive.txt = 30min ago, missed entries present
when:  replay runs
then:  agent.injectMessage called only for the entries (no [STARTUP] prefix)
```

### Test 7 — stale-task warning fires

```
given: 3 in-progress tasks with updated_at 3h ago
when:  warnStaleTasks runs (threshold = 2h)
then:  agent.injectMessage called once with [STALE-TASKS] warning containing 3 task ids
```

### Test 8 — stale-task warning suppressed when fresh

```
given: 3 in-progress tasks with updated_at 30min ago
when:  warnStaleTasks runs (threshold = 2h)
then:  agent.injectMessage NOT called
```

### Test 9 — atomic cursor write survives partial failure

```
given: writeCursorAtomic throws ENOSPC after first inject
when:  replay runs on 3 entries
then:  first inject completes, cursor advance fails, error logged
       next replay re-processes entries 1..3 (idempotent from agent side)
```

### Test 10 — chat_id string normalization

```
given: cursor stored with "-1003928420107" as string key
when:  entry arrives with chat_id: -1003928420107 (int)
then:  cursor lookup succeeds (no double-inject due to key type mismatch)
```

---

## Telemetry additions

- Event `telegram_replayed` on each replayed message: `{chat_id, message_id, archived_at}`
- Event `stale_tasks_warned`: `{count}`
- Event `downtime_detected` on gap > 4h: `{downtime_hours, missed_count}`

Feeds nightly-metrics and downstream ratio computations. `KBRetryMetrics`-shape unchanged (this is a different subsystem).

---

## Rollout

1. develop implements (worktree off upstream/main, same method as #900/#901/#902/#903)
2. Design doc `git add -f` in the same PR commit (past `docs/.gitignore:47`)
3. capitan reviews, merges
4. **Deploy note — daemon-side TypeScript: PR merge ≠ live.** Unlike the Python
   mmrag.py path (executes from source → working-tree edit is live immediately),
   this is compiled daemon code: production runs from built `dist/`. Going live
   requires `npm run build` + `pm2 restart cortextos-daemon` (capitan zone per
   prod-config-ownership). Coordinate deployment separately after merge — merged
   upstream and live-in-daemon are distinct states.
5. **Live-verify:** gc-admin is the first target — has the concrete missing-message case from 2026-08-13. Trigger a controlled restart, confirm archived messages replay + cursor updates + events emit.
6. Retro after 1 week: check `telegram_replayed` and `stale_tasks_warned` event counts fleet-wide; validate false-positive rate on stale-task threshold (2h default).

---

## Out of scope

- Log rotation for `inbound-messages.jsonl` (track as future hygiene item)
- Auto-resolution of stale tasks (only signal, never auto-act)
- Cross-agent replay coordination (each agent replays its own archive only)
- Bulk archive replay CLI (`bus replay-telegram --agent <name> --window 7d`) — nice-to-have, defer
- Deduplication across multiple sessions of same message (idempotency at agent memory layer)

## Non-goals

- Perfect delivery guarantee. This is at-least-once + best-effort ordering, bounded by 24h/100-per-chat cap.
- Replacing check-inbox for a2a messages — this is Telegram-specific.
