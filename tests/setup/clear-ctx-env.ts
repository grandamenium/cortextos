/**
 * Hermetic test environment: strip every CTX_*-prefixed variable from
 * process.env before each test file runs.
 *
 * Why: cortextOS injects a family of CTX_* vars into a live agent session
 * (CTX_AGENT_DIR, CTX_FRAMEWORK_ROOT, CTX_PROJECT_ROOT, CTX_ORG, CTX_AGENT_NAME,
 * CTX_INSTANCE_ID, CTX_ROOT, CTX_TIMEZONE, CTX_ORCHESTRATOR_AGENT,
 * CTX_TELEGRAM_CHAT_ID, ...). When `npm test` is run from INSIDE such a session,
 * those leak into the test process. Tests that build their own temp framework
 * root and override CTX_FRAMEWORK_ROOT then collide with the inherited
 * CTX_AGENT_DIR/CTX_PROJECT_ROOT, tripping the sandbox-isolation guard in
 * src/utils/env.ts (`resolveEnv`) — producing phantom failures (bus-crons,
 * upgrade-cron, …) that have nothing to do with the code under test.
 *
 * Stripping by PREFIX (anything CTX_*) rather than a hardcoded list keeps the
 * suite deterministic from any context — local shell, agent session, or CI —
 * and is future-proof as new CTX_* vars are added. Tests that need specific
 * CTX_* values still set them in their own beforeEach (which runs after this).
 *
 * Wired via vitest `setupFiles`, so it runs in each test worker before that
 * worker's test files are imported.
 */
for (const key of Object.keys(process.env)) {
  if (key.startsWith('CTX_')) {
    delete process.env[key];
  }
}
