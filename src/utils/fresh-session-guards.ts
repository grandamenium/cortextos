import type { AgentConfig } from '../types/index.js';

export const PROTECTED_AGENTS: ReadonlySet<string> = new Set(['top-g', 'smart-g']);

export function isFreshSessionProtectedAgent(agentName: string): boolean {
  return PROTECTED_AGENTS.has(agentName);
}

export function isFreshSessionSupportedRuntime(runtime: AgentConfig['runtime'] | string | undefined): boolean {
  return runtime === undefined || runtime === 'claude-code';
}
