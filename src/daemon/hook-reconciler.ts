/**
 * Hook reconciler — ensures every agent's .claude/settings.json carries the
 * cortextOS-required hooks, regardless of which template version the agent
 * was originally spawned from.
 *
 * Background (2026-07-09 stall diagnosis, secondary finding #1): agents
 * created before a template gained a hook never receive it — kirk and spock
 * lacked the Stop → hook-idle-flag entry entirely, so last_idle.flag never
 * wrote and the fast-checker's turn-end signal was silently absent for those
 * agents. Settings were written once at spawn and never reconciled.
 *
 * Called from AgentManager.startAgent() so the guarantee holds on every
 * agent start. Additive only: existing hook entries (including user-added
 * ones) are never modified or removed; a required hook is appended only when
 * no entry for that event already runs the same command. Malformed settings
 * files are left untouched (loud log) rather than clobbered.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { atomicWriteSync } from '../utils/atomic.js';

interface RequiredHook {
  /** Hook event name, e.g. "Stop" */
  event: string;
  /** Command line for the hook */
  command: string;
  /** Timeout in seconds */
  timeout: number;
}

/**
 * Hooks every cortextOS agent must have. Keep in sync with
 * templates/agent/.claude/settings.json — this list is the enforcement for
 * agents spawned from older template versions.
 */
export const REQUIRED_HOOKS: RequiredHook[] = [
  // Turn-end signal: fast-checker liveness/typing detection and the
  // delivery-confirmation loop both consume last_idle.flag transitions.
  { event: 'Stop', command: 'cortextos bus hook-idle-flag', timeout: 5 },
  // Turn-start signal: the delivery-confirmation loop watches last_prompt.flag
  // to verify an injected message actually submitted.
  { event: 'UserPromptSubmit', command: 'cortextos bus hook-prompt-flag', timeout: 5 },
];

interface HookCommandEntry {
  type: string;
  command: string;
  timeout?: number;
}
interface HookGroup {
  matcher?: string;
  hooks: HookCommandEntry[];
}

/**
 * Ensure required hooks exist in <agentDir>/.claude/settings.json.
 * Returns the list of hook commands that were added (empty = no change).
 */
export function ensureRequiredHooks(
  agentDir: string,
  log: (msg: string) => void = () => {}
): string[] {
  const settingsPath = join(agentDir, '.claude', 'settings.json');
  if (!existsSync(settingsPath)) {
    // No settings file at all — an agent dir this bare is not something the
    // reconciler should invent config for; leave it to the spawn path.
    log(`hook-reconciler: no settings.json at ${settingsPath}, skipping`);
    return [];
  }

  let raw: string;
  let settings: Record<string, unknown>;
  try {
    raw = readFileSync(settingsPath, 'utf-8');
    settings = JSON.parse(raw);
  } catch (err) {
    log(`hook-reconciler: settings.json unreadable/malformed at ${settingsPath} — leaving untouched (${err})`);
    return [];
  }
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    log(`hook-reconciler: settings.json root is not an object at ${settingsPath} — leaving untouched`);
    return [];
  }

  const hooks = (settings.hooks ?? {}) as Record<string, HookGroup[]>;
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) {
    log(`hook-reconciler: settings.hooks is not an object at ${settingsPath} — leaving untouched`);
    return [];
  }

  const added: string[] = [];
  for (const req of REQUIRED_HOOKS) {
    const groups: HookGroup[] = Array.isArray(hooks[req.event]) ? hooks[req.event] : [];
    const present = groups.some(g =>
      Array.isArray(g?.hooks) &&
      g.hooks.some(h => typeof h?.command === 'string' && h.command.includes(req.command))
    );
    if (present) continue;
    groups.push({ hooks: [{ type: 'command', command: req.command, timeout: req.timeout }] });
    hooks[req.event] = groups;
    added.push(`${req.event} → ${req.command}`);
  }

  if (added.length === 0) return [];

  settings.hooks = hooks;
  atomicWriteSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', true);
  log(`hook-reconciler: added missing hook(s): ${added.join(', ')}`);
  return added;
}
