const READY_MESSAGE = 'Git pre-push hook ready (build + test gate)';

/**
 * Convert setup-hooks.sh output into the message level shared by the installer
 * and CLI. Missing, duplicate, or unknown statuses fail closed as warnings.
 */
export function interpretHookInstallerOutput(output) {
  const matches = [...output.matchAll(/^HOOK_STATUS=(\S+)$/gm)];
  const status = matches.length === 1 ? matches[0][1] : undefined;

  switch (status) {
    case 'installed':
    case 'ready':
      return { level: 'success', message: READY_MESSAGE };
    case 'preserved-existing':
      return {
        level: 'warning',
        message: 'Existing pre-push hook preserved; cortextOS build + test gate was not installed',
      };
    case 'source-missing':
      return {
        level: 'warning',
        message: 'Tracked pre-push hook source is missing; cortextOS build + test gate was not installed',
      };
    default:
      return {
        level: 'warning',
        message: 'Git hook installer returned an unknown status; verify with: bash scripts/setup-hooks.sh',
      };
  }
}
