export interface HookInstallResult {
  level: 'success' | 'warning';
  message: string;
}

export function interpretHookInstallerOutput(output: string): HookInstallResult;
