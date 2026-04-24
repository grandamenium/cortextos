// PM2 ecosystem config for cortextOS daemon.
// Portable: paths resolve at load time relative to this file and the user's home.
// Override any value with environment variables before `pm2 start`.

const path = require('path');
const os = require('os');

const FRAMEWORK_ROOT = process.env.CTX_FRAMEWORK_ROOT || __dirname;
const PROJECT_ROOT = process.env.CTX_PROJECT_ROOT || FRAMEWORK_ROOT;
const INSTANCE_ID = process.env.CTX_INSTANCE_ID || 'default';
const CTX_ROOT = process.env.CTX_ROOT || path.join(os.homedir(), '.cortextos', INSTANCE_ID);
const CTX_ORG = process.env.CTX_ORG || '';

module.exports = {
  apps: [
    {
      name: 'cortextos-daemon',
      script: path.join(FRAMEWORK_ROOT, 'dist', 'daemon.js'),
      args: `--instance ${INSTANCE_ID}`,
      cwd: FRAMEWORK_ROOT,
      env: {
        CTX_INSTANCE_ID: INSTANCE_ID,
        CTX_ROOT: CTX_ROOT,
        CTX_FRAMEWORK_ROOT: FRAMEWORK_ROOT,
        CTX_PROJECT_ROOT: PROJECT_ROOT,
        CTX_ORG: CTX_ORG,
        // Debug-only: set to '1' to enable SIGUSR2 signal → controlled
        // uncaughtException for testing the crash-visibility path
        // (.daemon-crashed markers, crash-loop Telegram alert). Leave off
        // in production; set to '1' temporarily to reproduce crash paths
        // during development. See docs/debugging.md.
        CTX_DEBUG_ALLOW_CRASH_TRIGGER: '0',
      },
      max_restarts: 10,
      restart_delay: 5000,
      autorestart: true,
    },
  ],
};
