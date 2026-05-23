export type CheckStatus = 'PASS' | 'FAIL' | 'WARN' | 'SKIP';
export type CheckSeverity = 'P0' | 'P1' | 'P2';

export interface CheckResult {
  id: string;
  surface: string;
  route: string;
  status: CheckStatus;
  severity: CheckSeverity;
  check_label: string;
  evidence: string;
  screenshot?: string;
}

export function fingerprint(result: Pick<CheckResult, 'surface' | 'check_label' | 'route'>): string {
  return `${result.surface}:${result.check_label}:${result.route}`;
}
