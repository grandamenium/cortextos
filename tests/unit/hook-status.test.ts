import { describe, expect, it } from 'vitest';
import { interpretHookInstallerOutput } from '../../scripts/hook-status.mjs';

describe('interpretHookInstallerOutput', () => {
  it.each(['installed', 'ready'])('accepts %s as ready', (status) => {
    expect(interpretHookInstallerOutput(`installer output\nHOOK_STATUS=${status}\n`)).toEqual({
      level: 'success',
      message: 'Git pre-push hook ready (build + test gate)',
    });
  });

  it.each([
    ['preserved-existing', 'Existing pre-push hook preserved; cortextOS build + test gate was not installed'],
    ['source-missing', 'Tracked pre-push hook source is missing; cortextOS build + test gate was not installed'],
  ])('maps %s to its warning', (status, message) => {
    expect(interpretHookInstallerOutput(`HOOK_STATUS=${status}\n`)).toEqual({
      level: 'warning',
      message,
    });
  });

  it.each([
    ['missing', 'ordinary installer output'],
    ['unknown', 'HOOK_STATUS=surprise'],
    ['duplicate', 'HOOK_STATUS=ready\nHOOK_STATUS=installed'],
  ])('fails closed for %s status output', (_case, output) => {
    expect(interpretHookInstallerOutput(output)).toEqual({
      level: 'warning',
      message: 'Git hook installer returned an unknown status; verify with: bash scripts/setup-hooks.sh',
    });
  });
});
