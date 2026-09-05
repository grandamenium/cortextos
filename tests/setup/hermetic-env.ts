/**
 * Vitest setup: neutralize ambient CTX_* environment variables so the suite
 * is hermetic no matter which shell launched it.
 *
 * Agent shells (and any shell sourcing .cortextos-env) export CTX_* vars
 * (CTX_FRAMEWORK_ROOT, CTX_PROJECT_ROOT, CTX_AGENT_DIR, CTX_INSTANCE_ID,
 * CTX_AGENT_NAME, CTX_ORG, CTX_ROOT, ...). Product code branches on these —
 * e.g. hook-crash-alert's notifyAgents invokes <frameworkRoot>/dist/cli.js
 * when CTX_FRAMEWORK_ROOT is set and falls back to a bare 'cortextos' PATH
 * lookup when it is not, and resolveEnv() hard-fails when an inherited
 * CTX_AGENT_DIR points outside a test's stubbed CTX_FRAMEWORK_ROOT. Tests
 * written for a clean environment therefore fail from an agent shell with
 * "the tests are broken" false alarms.
 *
 * This file runs (per vitest setupFiles) in every test worker before each
 * test file is imported, so module-level env reads in product code see the
 * clean environment too, and child processes spawned by integration tests
 * inherit it. Tests that need specific CTX_* values set them explicitly
 * after this runs.
 */
for (const key of Object.keys(process.env)) {
  if (key.startsWith('CTX_')) {
    delete process.env[key];
  }
}
