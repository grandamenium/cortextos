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
        // (.daemon-crashed markers + crash-loop operator Telegram alert).
        // Leave '0' in production; enable temporarily to reproduce crash
        // paths during development. `kill -SIGUSR2 $(pm2 pid cortextos-daemon)`
        // then watch the operator chat for "🚨 CRITICAL: daemon crash-looping"
        // after 3 crashes in 15 min.
        CTX_DEBUG_ALLOW_CRASH_TRIGGER: '0',
      },
      // max_restarts + restart_delay is the ultimate crash-storm circuit
      // breaker. If the daemon dies 10 times faster than 5s apart, PM2
      // gives up — the fleet goes fully dead, requiring a manual
      // `pm2 restart cortextos-daemon`. That is intentional: storm
      // protection > fleet uptime during a pathological crash loop.
      // The daemon's uncaughtException handler (src/daemon/index.ts)
      // fires a Telegram alert to the operator at 3+ crashes in 15 min —
      // well before this circuit trips. Do NOT raise these values without
      // also strengthening the upstream fix; the 2026-04-22 storm is a
      // reminder that unchecked auto-restart amplifies one bug into a
      // fleet-wide outage.
      max_restarts: 10,
      restart_delay: 5000,
      autorestart: true,
    },
  ],
};
