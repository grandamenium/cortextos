/**
 * Vitest setup: strip inherited live-session env before every test file.
 *
 * Agent PTYs export CTX_* (and their .env keys) into every child process, so
 * `npm test` run from an agent session (e.g. the pre-push hook) inherited
 * CTX_AGENT_DIR / CTX_PROJECT_ROOT / CTX_ORG from the live agent. Tests that
 * override only CTX_FRAMEWORK_ROOT then tripped resolveEnv's sandbox/live
 * isolation guard (issue #313), and other tests picked up live values.
 *
 * Git hooks export the repository location (GIT_DIR etc.). From a linked
 * worktree GIT_DIR is absolute, so tests that run git inside their temp
 * fixture dirs acted on the real repository instead: fixture commits, a
 * local user.name, a filter driver and core.bare=true in its config.
 *
 * Tests that need any of these vars set them explicitly.
 */
const LEAKED_KEYS = [
  'BOT_TOKEN',
  'CHAT_ID',
  'ALLOWED_USER',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
];

for (const key of Object.keys(process.env)) {
  if (key.startsWith('CTX_') || LEAKED_KEYS.includes(key)) {
    delete process.env[key];
  }
}
