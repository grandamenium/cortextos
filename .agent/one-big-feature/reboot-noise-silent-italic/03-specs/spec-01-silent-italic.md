# Spec 01 — silent + italic reboot/compaction Telegram messages

## File-by-file changes

### 1. `src/telegram/api.ts` — plumb `silent`
- `sendMessage` (L192): extend `opts` type to `{ parseMode?: 'HTML' | null; onParseFallback?: (reason: string) => void; silent?: boolean }`.
- Pass `opts?.silent` into `sendChunk` (add a `silent: boolean` param, default false).
- In `sendChunk` (L225) `basePayload`: when `silent` is true, add `disable_notification: true`.
- Default omitted ⇒ no `disable_notification` key ⇒ current behavior unchanged.

### 2. `src/daemon/agent-manager.ts:539`
- Change to italic + silent, e.g.:
  `tgApi.sendMessage(tgChatId, \`_Agent ${name} recovered and is back online_\`, undefined, { silent: true }).catch(() => {});`
- Leave L535 (crash) and L537 (HALTED) **unchanged** — those must keep notifying.

### 3. `src/daemon/agent-process.ts:1146`
- The `send(...)` back-online call → italic + silent. If `send` is a local wrapper, thread the silent option through it (or call the underlying `sendMessage` with `{ silent: true }` and italic text).

### 4. `src/hooks/hook-compact-telegram.ts:28-36`
- Add to the fetch JSON body: `parse_mode: 'HTML'` (and wrap text as `<i>[${agentName}] Context compacting... resuming shortly</i>`), and `disable_notification: true`.

### 5. `src/daemon/agent-process.ts:953,965` (agent-authored back-online prompt)
Pick ONE, whichever is cleaner given how the daemon already emits a back-online line:
- (Preferred) Remove/soften the instruction so the agent does NOT send its own routine back-online message when the daemon already sends the silent one — avoids the duplicate loud ping seen in Josh's screenshot.
- (Alternative) Keep it, but add a `--silent` flag to the `send-telegram` command in `src/cli/bus.ts` (sets `{ silent: true }` on the send) and change the prompt to instruct an *italic, silent* back-online line.

## Tests
- `tests/` unit test: `sendMessage(..., { silent: true })` produces a payload containing `disable_notification: true`; without it, the key is absent.
- If `send-telegram --silent` is added: a CLI test that the flag routes through to the API silent path.

## Acceptance
- Manual: trigger a compaction + restart on one agent; confirm the compaction line and the single back-online line arrive italicized and silent (no notification), while a simulated crash still notifies.
- `npm run build` clean; `npm test` green.
