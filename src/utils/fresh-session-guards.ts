import type { AgentConfig } from '../types/index.js';

export const PROTECTED_CRONS: ReadonlySet<string> = new Set([
  'smart-g/*',
  'top-g/morning-review',
  'top-g/evening-review',
  'top-g/weekly-review',
]);

export function isFreshSessionProtectedCron(agentName: string, cronName: string): boolean {
  return PROTECTED_CRONS.has(`${agentName}/${cronName}`) || PROTECTED_CRONS.has(`${agentName}/*`);
}

export function isFreshSessionSupportedRuntime(runtime: AgentConfig['runtime'] | string | undefined): boolean {
  return runtime === undefined || runtime === 'claude-code';
}
