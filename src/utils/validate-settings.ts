import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export interface SettingsValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// Valid Claude Code hook event names as of 2026-04.
// Source: the Settings Warning dialog that fires when an unknown key is used.
const VALID_HOOK_EVENTS = new Set([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'PermissionRequest',
  'PermissionDenied',
  'Setup',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
  'Elicitation',
  'ElicitationResult',
  'ConfigChange',
  'WorktreeCreate',
  'WorktreeRemove',
  'InstructionsLoaded',
  'CwdChanged',
  'FileChanged',
]);

/**
 * Validate a Claude Code settings.json file.
 *
 * Catches FM21 (invalid hook event names), FM22 (invalid permission patterns),
 * and FM23 (invalid hook matcher regex) before any PTY is launched — preventing
 * the "Settings Warning / Exit and fix manually" dialog from blocking agents at boot.
 */
export function validateAgentSettings(settingsPath: string): SettingsValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!existsSync(settingsPath)) {
    return { valid: true, errors: [], warnings: [] };
  }

  let raw: string;
  try {
    raw = readFileSync(settingsPath, 'utf-8');
  } catch (e) {
    errors.push(`Cannot read settings.json: ${e}`);
    return { valid: false, errors, warnings };
  }

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(raw);
  } catch (e) {
    errors.push(`settings.json is not valid JSON: ${e}`);
    return { valid: false, errors, warnings };
  }

  // FM21: Validate hook event names
  const hooks = settings.hooks;
  if (hooks !== undefined && hooks !== null && typeof hooks === 'object' && !Array.isArray(hooks)) {
    for (const eventName of Object.keys(hooks as Record<string, unknown>)) {
      if (!VALID_HOOK_EVENTS.has(eventName)) {
        errors.push(
          `Invalid hook event type: "${eventName}". Valid types: ${[...VALID_HOOK_EVENTS].join(', ')}`,
        );
      }

      // FM23: Validate hook matcher regex for each hook entry
      const hookEntries = (hooks as Record<string, unknown>)[eventName];
      if (Array.isArray(hookEntries)) {
        for (const entry of hookEntries) {
          if (entry && typeof entry === 'object' && 'matcher' in entry) {
            const matcher = (entry as Record<string, unknown>).matcher;
            if (typeof matcher === 'string' && matcher.length > 0) {
              try {
                new RegExp(matcher);
              } catch {
                errors.push(
                  `Invalid regex in hook matcher for "${eventName}": "${matcher}"`,
                );
              }
            }
          }
        }
      }
    }
  }

  // FM22: Validate permission patterns (warn only — invalid patterns are silently ignored by Claude Code)
  const permissions = settings.permissions;
  if (permissions !== undefined && permissions !== null && typeof permissions === 'object' && !Array.isArray(permissions)) {
    const perms = permissions as Record<string, unknown>;
    for (const key of ['allow', 'deny']) {
      const list = perms[key];
      if (Array.isArray(list)) {
        for (const pattern of list) {
          if (typeof pattern !== 'string' || pattern.trim() === '') {
            warnings.push(`Empty or non-string permission pattern in "${key}" list`);
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Resolve and validate settings.json for a given agent.
 * Returns path checked and validation result.
 */
export function validateAgentSettingsForDir(
  workingDir: string,
): SettingsValidationResult {
  const settingsPath = join(workingDir, '.claude', 'settings.json');
  return validateAgentSettings(settingsPath);
}
