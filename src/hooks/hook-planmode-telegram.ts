/**
 * @deprecated Renamed to `hook-planmode-approval.ts` in PR2 of the
 * pluggable communications connectors stack. Shim delegates to the
 * new entrypoint so existing `.claude/settings.json` files and
 * external callers keep working. Removed in the release after this
 * stack lands.
 */
import { main } from './hook-planmode-approval.js';
import { outputDecision } from './index.js';

main().catch((err) => {
  process.stderr.write(`hook-planmode-approval error: ${err}\n`);
  outputDecision('allow');
});
