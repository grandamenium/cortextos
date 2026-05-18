/**
 * @deprecated Renamed to `hook-ask-user.ts` in PR2 of the pluggable
 * communications connectors stack. This file is a shim that delegates
 * to the new entrypoint so existing `.claude/settings.json` files and
 * external callers keep working. Removed in the release shipping the
 * follow-up PR after this stack lands.
 */
import { main } from './hook-ask-user.js';

main().catch((err) => {
  process.stderr.write(`hook-ask-user error: ${err}\n`);
  process.exit(0);
});
