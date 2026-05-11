# Telegram group → supergroup migration silently invalidates the stored chat_id

**When a regular Telegram group is auto-upgraded to a supergroup, its chat_id changes from `-<id>` to `-100<id>` and any consumer holding the old value sees a hard "chat not found" / "group chat was upgraded to a supergroup chat" error on outbound — but the bot may keep receiving forwarded migration / system updates from the old chat_id, so incoming traffic *looks* fine while sends silently fail.** Telegram triggers the upgrade automatically once a group hits certain criteria (admin permissions changed, member count, history-visibility, etc.); there is no warning to bot owners.

## Symptom

A bot configured for a group chat suddenly:
- Receives empty / migration-notice messages on the old `-<id>` chat_id (the fast-checker / poller still gets traffic, so nothing looks broken at the inbox layer).
- `sendMessage` to the old chat_id returns `400 Bad Request: group chat was upgraded to a supergroup chat`.
- All `cortextos bus post-activity` (or any wrapper that targets the stored ACTIVITY_CHAT_ID) fails silently if the caller doesn't surface the API error — broadcasts stop landing in the actual group while the activity feed shows no errors.

The asymmetry between "inbound looks fine" and "outbound is dead" is the trap. Operators don't notice until they explicitly check the channel.

## Pattern fix

Two layers of mitigation, one preventive and one detective:

**1. At send time, catch the upgrade error and self-correct.** The Telegram API returns `migrate_to_chat_id` in the error response body when this specific failure happens. Wrappers that own the stored chat_id should:
- Detect the `400` with description matching `/group chat was upgraded to a supergroup/i`.
- Read `parameters.migrate_to_chat_id` from the response body.
- Atomically rewrite the stored chat_id (env file, settings, secret store).
- Retry the send once with the new chat_id.

```ts
// Pseudocode for the wrapper
async function sendActivity(chatId: string, text: string): Promise<void> {
  try {
    await tg.sendMessage(chatId, text);
  } catch (err) {
    if (isSupergroupMigrationError(err) && err.parameters?.migrate_to_chat_id) {
      const newId = String(err.parameters.migrate_to_chat_id);
      await rewriteEnvFile('ACTIVITY_CHAT_ID', newId);
      await tg.sendMessage(newId, text);  // retry once with new id
      return;
    }
    throw err;
  }
}
```

**2. At ingest time, watch for the `message.migrate_to_chat_id` field.** When a group is upgraded, Telegram delivers a service message in the OLD chat with `migrate_to_chat_id` set, and a corresponding service message in the NEW chat with `migrate_from_chat_id` set. Either is a definitive signal that the chat_id has changed — the fast-checker / poller can rewrite the stored chat_id at that moment, BEFORE the next send fails.

If neither layer is present, the manual fix is: forward any message from the upgraded group to `@username_to_id_bot`, OR run `getUpdates` after a fresh message in the new supergroup, then update wherever the stale `-<id>` is referenced (env files, agent configs, dashboard config).

## Rule of thumb

**Stored chat_ids are not stable identifiers.** Any external Telegram identity that could change underfoot — group→supergroup upgrades, channel renames, bot reshuffles — needs (a) error-path self-healing on send, and (b) ingest-time detection of the change signal. Treating Telegram chat_ids as set-once-and-forget is the same shape as the `session_id`-as-lookup-key trap (`session-restart-immunity.md`) — both rely on something the platform can rotate without telling you.

The asymmetric symptom — inbound looks fine, outbound silently fails — is the diagnostic tell for any auto-rotated identifier. If you ever hit "I'm receiving but not sending," check for identifier rotation before rebuilding the comm wrapper.

## Source incident

2026-05-09T15:42–17:13Z — sb-personal org activity channel migrated `-5295704479` → `-1003790591089`. Symptom surfaced via two empty Telegram messages forwarded from the OLD chat_id to fullstack's session; outbound reply returned `Bad Request: group chat was upgraded to a supergroup chat`. Grep traced the stale id to `orgs/sb-personal/activity-channel.env:5` (`ACTIVITY_CHAT_ID`). Boss confirmed his earlier "chat not found" smoke-test failures had the same root cause; activity broadcasts had been silently failing fleet-wide between the upgrade event and detection. Saurav rotated the env to the new supergroup id; boss validated `cortextos bus post-activity` lands in `-1003790591089`. Dispatched as a one-pager subfile under boss msg_id 1778346869829-boss-6m1qe so the same trap is detectable next time without the diagnostic chain.
