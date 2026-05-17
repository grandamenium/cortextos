import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    cli: 'src/cli/index.ts',
    daemon: 'src/daemon/index.ts',
    'hooks/hook-permission-telegram': 'src/hooks/hook-permission-telegram.ts',
    'hooks/hook-ask-telegram': 'src/hooks/hook-ask-telegram.ts',
    'hooks/hook-planmode-telegram': 'src/hooks/hook-planmode-telegram.ts',
    'hooks/hook-crash-alert': 'src/hooks/hook-crash-alert.ts',
    'hooks/hook-compact-telegram': 'src/hooks/hook-compact-telegram.ts',
    'hooks/hook-extract-facts': 'src/hooks/hook-extract-facts.ts',
    'hooks/hook-idle-flag': 'src/hooks/hook-idle-flag.ts',
    'hooks/hook-context-status': 'src/hooks/hook-context-status.ts',
    // hook-episodic-post-tool entry removed during 2026-05-17 merge — the referenced
    // src/hooks/hook-episodic-post-tool.ts was never committed to gitea/main or any
    // feature branch (verified via git ls-tree across all 9 branches). Restore both
    // this entry AND the .ts file when the episodic hook is implemented.
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
