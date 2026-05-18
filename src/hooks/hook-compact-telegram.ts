/**
 * @deprecated Renamed to `hook-compact-outbound.ts` in PR2 of the
 * pluggable communications connectors stack. Shim delegates to the
 * new entrypoint. Removed in the release after this stack lands.
 */
import { main } from './hook-compact-outbound.js';

main().catch(() => process.exit(0));
