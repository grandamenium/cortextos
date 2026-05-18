import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    cli: 'src/cli/index.ts',
    daemon: 'src/daemon/index.ts',
    // PR2 renamed hooks — new canonical entrypoints
    'hooks/hook-permission-request': 'src/hooks/hook-permission-request.ts',
    'hooks/hook-ask-user': 'src/hooks/hook-ask-user.ts',
    'hooks/hook-planmode-approval': 'src/hooks/hook-planmode-approval.ts',
    'hooks/hook-compact-outbound': 'src/hooks/hook-compact-outbound.ts',
    // PR2 renamed hooks — old paths kept as @deprecated shims (one release cycle)
    'hooks/hook-permission-telegram': 'src/hooks/hook-permission-telegram.ts',
    'hooks/hook-ask-telegram': 'src/hooks/hook-ask-telegram.ts',
    'hooks/hook-planmode-telegram': 'src/hooks/hook-planmode-telegram.ts',
    'hooks/hook-compact-telegram': 'src/hooks/hook-compact-telegram.ts',
    // Unchanged
    'hooks/hook-crash-alert': 'src/hooks/hook-crash-alert.ts',
    'hooks/hook-extract-facts': 'src/hooks/hook-extract-facts.ts',
    'hooks/hook-idle-flag': 'src/hooks/hook-idle-flag.ts',
    'hooks/hook-context-status': 'src/hooks/hook-context-status.ts',
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
