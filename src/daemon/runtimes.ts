// Single source of truth for valid agent runtime tokens.
// Imported by:
//   - src/daemon/agent-manager.ts  (Layer 1 fail-CLOSED guard)
//   - src/daemon/agent-process.ts  (Layer 2 defense-in-depth)
//   - src/cli/index.ts             (`cortextos valid-runtimes` → bash monitor + audit)
// Adding a new runtime = one edit here; all guards, monitors, and audits stay aligned.
export const VALID_RUNTIMES = new Set(['claude-code', 'hermes', 'codex-app-server']);
