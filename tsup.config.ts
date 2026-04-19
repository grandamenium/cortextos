import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    cli: 'src/cli/index.ts',
    ascendops: 'src/cli/ascendops.ts',
    daemon: 'src/daemon/index.ts',
    'hooks/hook-permission-telegram': 'src/hooks/hook-permission-telegram.ts',
    'hooks/hook-ask-telegram': 'src/hooks/hook-ask-telegram.ts',
    'hooks/hook-planmode-telegram': 'src/hooks/hook-planmode-telegram.ts',
    'hooks/hook-crash-alert': 'src/hooks/hook-crash-alert.ts',
    'hooks/hook-compact-telegram': 'src/hooks/hook-compact-telegram.ts',
    'hooks/hook-extract-facts': 'src/hooks/hook-extract-facts.ts',
    'hooks/hook-idle-flag': 'src/hooks/hook-idle-flag.ts',
    'hooks/hook-session-restore': 'src/hooks/hook-session-restore.ts',
    'hooks/hook-loop-detector': 'src/hooks/hook-loop-detector.ts',
    'hooks/hook-skill-autopr': 'src/hooks/hook-skill-autopr.ts',
  },
  format: ['cjs'],
  target: 'node20',
  clean: true,
  splitting: false,
  sourcemap: true,
  dts: false,
  shims: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
  external: ['node-pty'],
});
