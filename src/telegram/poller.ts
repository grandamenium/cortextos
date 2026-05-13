/**
 * @deprecated Telegram code has moved to `src/connectors/telegram/poller.ts`
 * as part of the pluggable communications connectors refactor. This deep-
 * shim is kept for one release cycle (through the release that ships PR2
 * of the connector-pluggable stack) and will be removed in the release
 * after. Update imports to `../connectors/telegram/poller.js` to silence
 * the deprecation when it lands.
 */
export * from '../connectors/telegram/poller.js';
