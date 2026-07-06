# Reboot / compaction Telegram messages — silent + italic (cut fleet notification noise)

## Goal
Josh gets a wall of push notifications every time any of ~15 fleet agents compacts context and reboots ("Context compacting...", "Agent X is back online", "recovered and is back online"). These **routine lifecycle** messages must (1) render in *italics* and (2) send **silently** (`disable_notification: true` — no push/sound/badge), so they appear as quiet status lines instead of lighting up his phone. Genuine failure alerts (crash, halt) MUST stay loud.

## Root cause / current behavior (verified in source 2026-07-05)
The Telegram send layer has no silent option, and routine lifecycle messages send as normal (notifying) plain text:
- `src/telegram/api.ts:192` `sendMessage(chatId, text, replyMarkup?, opts?)` + private `sendChunk` (L225) build the payload WITHOUT `disable_notification`. Markdown→HTML is already supported, so italic works via `_..._`.
- `src/daemon/agent-manager.ts:539` — `tgApi.sendMessage(tgChatId, \`Agent ${name} recovered and is back online\`)` — routine, notifies.
- `src/daemon/agent-process.ts:1146` — `send(\`Agent ${this.name} is back online\`)` — routine, notifies.
- `src/hooks/hook-compact-telegram.ts:28-36` — raw `fetch` to sendMessage with `{chat_id, text:'[X] Context compacting... resuming shortly'}` — no parse_mode, no disable_notification.
- `src/daemon/agent-process.ts:953,965` — PROMPT text telling the agent to "send a Telegram message saying you are back online" — the agent-authored back-online ping (the "Ophir/Auditmaster Back online after config" ones in Josh's screenshot); goes through `cortextos bus send-telegram`, neither italic nor silent.

## Scope
1. **Plumb a silent option through the Telegram API.** In `src/telegram/api.ts`, add `silent?: boolean` to the `sendMessage` opts and thread it into `sendChunk` → payload as `disable_notification: true`. No behavior change when omitted.
2. **Make daemon lifecycle messages italic + silent:**
   - `agent-manager.ts:539` (recovered/back-online) → italic text + `{ silent: true }`.
   - `agent-process.ts:1146` (back online) → italic + silent.
   - `hook-compact-telegram.ts` → add `parse_mode` + italicized text + `disable_notification: true` to the raw fetch payload.
3. **Handle the agent-authored back-online ping (953/965).** Centralize: prefer the daemon-sent silent line and stop instructing the agent to send its own routine back-online message — OR, if kept, add a `--silent` flag to `cortextos bus send-telegram` (`src/cli/bus.ts`) and update the prompt to use it + italics. Codexer picks the cleaner mechanism; the guarantee is **exactly ONE back-online message per restart, italic, silent**.

## Non-goals
- Do NOT silence crash (`agent-manager.ts:535`), halt (`:537`), or the crash-alert hook — genuine failures must keep notifying.
- Do NOT change message routing, streaming, or the approval/permission Telegram flows.
- `disable_notification` stays opt-in — no default change anywhere else.

## Done =
Compaction + successful back-online/recovered messages arrive in Telegram rendered in italics and WITHOUT a push notification (verify `disable_notification:true` in the payload / no phone alert). Crash + halt still notify loudly. Exactly one back-online line per restart. `npm run build` clean, `npm test` green, plus a unit test asserting the API sets `disable_notification` when `silent:true`. Spec: `03-specs/spec-01-silent-italic.md`.
