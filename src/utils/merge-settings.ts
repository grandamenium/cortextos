/**
 * Merge an agent's `.claude/settings.json` into the working directory's
 * `.claude/settings.local.json`, so Claude Code picks up cortextOS hooks
 * (statusLine, hook-ask-telegram, hook-permission-telegram, …) when spawned
 * with a cwd OUTSIDE the agent directory.
 *
 * Why `settings.local.json` and not `settings.json`? The working directory is
 * typically the user's own repo. Claude Code merges `settings.json` + the
 * gitignored `settings.local.json` at runtime, so we can install our hooks
 * into the local file without touching anything the user owns.
 *
 * Per-matcher merge rules:
 *   - No existing entry with our matcher  → install ours.
 *   - Existing entry already includes our exact command  → no-op (idempotent).
 *   - Existing entry has a DIFFERENT command for the same matcher  → skip +
 *     warn. The user has customized this matcher and we refuse to silently
 *     overwrite it. Other matchers still install.
 *
 * `statusLine` follows the same rule — if the user set one that is different
 * from ours, keep theirs and warn.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

export interface HookCommand {
  type: string;
  command: string;
  timeout?: number;
  [k: string]: unknown;
}

export interface HookEntry {
  matcher?: string;
  hooks: HookCommand[];
  [k: string]: unknown;
}

export interface StatusLine {
  type: string;
  command: string;
  [k: string]: unknown;
}

export interface ClaudeSettings {
  permissions?: { allow?: string[]; deny?: string[]; [k: string]: unknown };
  hooks?: Record<string, HookEntry[]>;
  statusLine?: StatusLine;
  [k: string]: unknown;
}

export interface MergeResult {
  target: string;
  fileExistedBefore: boolean;
  hooksInstalled: number;
  hooksAlreadyPresent: number;
  hooksSkipped: number;
  permissionsAdded: number;
  statusLineInstalled: boolean;
  statusLineKept: boolean;
  warnings: string[];
}

const matcherKey = (m: HookEntry['matcher']): string => (m === undefined ? '__NO_MATCHER__' : m);

export function mergeAgentSettingsIntoWorkingDir(
  workingDir: string,
  agentSettings: ClaudeSettings,
): MergeResult {
  const claudeDir = join(workingDir, '.claude');
  const targetPath = join(claudeDir, 'settings.local.json');

  mkdirSync(claudeDir, { recursive: true });

  const fileExistedBefore = existsSync(targetPath);
  let existing: ClaudeSettings = {};
  if (fileExistedBefore) {
    try {
      const raw = readFileSync(targetPath, 'utf-8');
      existing = raw.trim() ? (JSON.parse(raw) as ClaudeSettings) : {};
    } catch (err) {
      // Corrupt JSON shouldn't silently destroy the user's file. Abort with
      // a clear error that the caller can surface.
      throw new Error(
        `Cannot parse existing ${targetPath}: ${(err as Error).message}. ` +
        `Fix or remove the file and re-run.`
      );
    }
  }

  const result: MergeResult = {
    target: targetPath,
    fileExistedBefore,
    hooksInstalled: 0,
    hooksAlreadyPresent: 0,
    hooksSkipped: 0,
    permissionsAdded: 0,
    statusLineInstalled: false,
    statusLineKept: false,
    warnings: [],
  };

  const merged: ClaudeSettings = { ...existing };

  // --- permissions.allow: union ---
  if (agentSettings.permissions?.allow?.length) {
    const existingAllow = Array.isArray(merged.permissions?.allow) ? merged.permissions!.allow! : [];
    const existingSet = new Set(existingAllow);
    const toAdd = agentSettings.permissions.allow.filter(p => !existingSet.has(p));
    if (toAdd.length) {
      merged.permissions = {
        ...(merged.permissions ?? {}),
        allow: [...existingAllow, ...toAdd],
      };
      result.permissionsAdded = toAdd.length;
    }
  }

  // --- hooks: per-event, per-matcher safe merge ---
  if (agentSettings.hooks) {
    const mergedHooks: Record<string, HookEntry[]> = { ...(merged.hooks ?? {}) };
    for (const [event, ourEntries] of Object.entries(agentSettings.hooks)) {
      if (!Array.isArray(ourEntries)) continue;
      const existingEntries = Array.isArray(mergedHooks[event]) ? [...mergedHooks[event]] : [];

      // Index existing entries by matcher for O(1) lookup
      const existingByMatcher = new Map<string, HookEntry>();
      for (const entry of existingEntries) {
        existingByMatcher.set(matcherKey(entry.matcher), entry);
      }

      for (const ourEntry of ourEntries) {
        if (!Array.isArray(ourEntry.hooks)) continue;
        const key = matcherKey(ourEntry.matcher);
        const existingEntry = existingByMatcher.get(key);

        if (!existingEntry) {
          existingEntries.push(ourEntry);
          result.hooksInstalled += 1;
          existingByMatcher.set(key, ourEntry);
          continue;
        }

        // Existing entry for this matcher — check each of OUR hooks against
        // theirs. Identical command = no-op. Different command = skip + warn
        // (do NOT overwrite user customization silently).
        const existingCommands = new Set(
          (existingEntry.hooks ?? []).map(h => `${h.type}::${h.command}`)
        );
        let allOursAlreadyPresent = true;
        for (const ourHook of ourEntry.hooks) {
          const sig = `${ourHook.type}::${ourHook.command}`;
          if (!existingCommands.has(sig)) {
            allOursAlreadyPresent = false;
            break;
          }
        }

        if (allOursAlreadyPresent) {
          result.hooksAlreadyPresent += 1;
          continue;
        }

        // User has their own command under the same matcher and ours isn't
        // present. Refuse to mutate the array — warn so they can reconcile.
        const matcherLabel = ourEntry.matcher ?? '(no matcher)';
        const ourCommands = ourEntry.hooks.map(h => h.command).join(', ');
        result.hooksSkipped += 1;
        result.warnings.push(
          `${event} hook with matcher "${matcherLabel}" already exists with a different command. ` +
          `Skipped installing cortextOS hook: ${ourCommands}. ` +
          `Edit ${targetPath} to resolve, or remove the conflicting entry and re-run.`
        );
      }

      mergedHooks[event] = existingEntries;
    }
    merged.hooks = mergedHooks;
  }

  // --- statusLine ---
  if (agentSettings.statusLine) {
    const ours = agentSettings.statusLine;
    const theirs = merged.statusLine;
    if (!theirs) {
      merged.statusLine = ours;
      result.statusLineInstalled = true;
    } else if (theirs.type === ours.type && theirs.command === ours.command) {
      result.hooksAlreadyPresent += 1; // already matches
    } else {
      result.statusLineKept = true;
      result.warnings.push(
        `statusLine already set to "${theirs.command}" (type=${theirs.type}). ` +
        `Kept existing value. cortextOS statusLine not installed. ` +
        `Edit ${targetPath} to switch.`
      );
    }
  }

  writeFileSync(targetPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
  return result;
}
