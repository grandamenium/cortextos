/**
 * @deprecated Renamed to `hook-permission-request.ts` in PR2 of the
 * pluggable communications connectors stack. Shim delegates to the
 * new entrypoint. The new hook adds tool-class-aware behavior for the
 * no-creds case — see `hook-permission-request.ts` and the CHANGELOG
 * entry for the security posture shift. Removed in the release after
 * this stack lands.
 */
import { main } from './hook-permission-request.js';
import { outputDecision } from './index.js';

main().catch((err) => {
  process.stderr.write(`hook-permission-request error: ${err}\n`);
  outputDecision('deny', `Hook error: ${err}`);
});
