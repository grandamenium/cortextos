/**
 * Claude-account profile registry — BL-2026-05-08-003 phase 1.
 *
 * Single source of truth for where each profile's `CLAUDE_CONFIG_DIR`
 * lives. Per-org so different orgs can split accounts differently
 * (e.g. one org uses `personal` + `work`; another uses `enterprise` +
 * `personal`). The registry is read at PTY spawn time by
 * `agent-pty.ts` to set `CLAUDE_CONFIG_DIR` for the spawned Claude
 * Code process — each agent talks to its own account.
 *
 * Registry shape (`orgs/<org>/profiles.json`):
 *
 *     {
 *       "default_profile": "personal",
 *       "profiles": {
 *         "personal": { "config_dir": "/Users/sauravb/.claude" },
 *         "work":     { "config_dir": "/Users/sauravb/.claude-work" }
 *       },
 *       "failback_policy": "manual"  // optional; reserved for phase 3
 *     }
 *
 * Behaviour:
 * - Missing registry → `loadProfileRegistry()` returns null. Spawn
 *   path then writes no `CLAUDE_CONFIG_DIR` override, preserving
 *   pre-BL-003 single-account behaviour.
 * - Malformed registry (bad JSON) → returns null. Doctor catches the
 *   parse error in a separate check; the spawn path silently
 *   degrades to default behaviour rather than killing every spawn.
 * - Dangling `default_profile` (names a profile not in `profiles`) →
 *   `resolveProfile()` returns null, doctor warns. Spawn proceeds
 *   without override.
 *
 * v0.5+ may add: schema validation via zod, registry-loaded-once
 * cache (today every spawn re-reads the file — small cost, drops on
 * first profile_quota_exhausted dispatch), failback_policy plumbing.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export interface Profile {
  /**
   * Absolute path to set as `CLAUDE_CONFIG_DIR` for this profile's spawns.
   *
   * **Optional by design.** `CLAUDE_CONFIG_DIR` is both a path resolver
   * AND a macOS Keychain partition key (see
   * `code-quality/claude-config-dir-is-keychain-partition-key.md`). Any
   * value that hasn't been logged-in via `claude /login` under that
   * exact env will fail headless agents with "Not logged in".
   *
   * The default account (the one the operator uses when running plain
   * `claude` from a terminal — no env override) MUST omit this field.
   * Setting it to `$HOME` "for clarity" is a different keychain
   * partition than no-env-set; tokens won't be found.
   *
   * Non-default accounts (e.g. a `work` profile) set this to a
   * pre-logged-in alternate dir, matching whatever shell alias the
   * operator uses for that account
   * (e.g. `alias claude-work='CLAUDE_CONFIG_DIR=~/.claude-work claude'`
   * → `config_dir: "/Users/sauravb/.claude-work"`).
   */
  config_dir?: string;
}

export type FailbackPolicy = 'manual' | 'auto' | 'disabled';

export interface ProfileRegistry {
  default_profile: string;
  profiles: Record<string, Profile>;
  /** Phase-3 field; loader passes through but does not act on. */
  failback_policy?: FailbackPolicy;
}

/**
 * Load a per-org profile registry from `orgs/<org>/profiles.json`.
 *
 * Returns null when the file is absent or malformed — the caller
 * (spawn path) treats this as "no profile system configured" and
 * preserves pre-BL-003 behaviour. Doctor performs a separate, more
 * detailed check that surfaces parse errors to the operator.
 *
 * Lightly normalises shape: ensures `profiles` is an object map,
 * `default_profile` is a non-empty string. Anything else returns null.
 */
export function loadProfileRegistry(
  projectRoot: string,
  org: string,
): ProfileRegistry | null {
  const path = join(projectRoot, 'orgs', org, 'profiles.json');
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const def = obj['default_profile'];
  const profiles = obj['profiles'];
  if (typeof def !== 'string' || !def) return null;
  if (!profiles || typeof profiles !== 'object') return null;

  const out: Record<string, Profile> = {};
  for (const [name, p] of Object.entries(profiles as Record<string, unknown>)) {
    if (!p || typeof p !== 'object') continue;
    const obj = p as Record<string, unknown>;
    const hasKey = 'config_dir' in obj;
    const dir = obj['config_dir'];
    if (!hasKey) {
      // Key absent — canonical sentinel for "default account, do not set
      // CLAUDE_CONFIG_DIR". Keep the profile so it resolves and
      // `findDanglingReferences` doesn't false-alarm.
      out[name] = {};
    } else if (typeof dir === 'string' && dir) {
      out[name] = { config_dir: dir };
    }
    // Key present but malformed (null, non-string, empty string) — drop
    // the entry. The operator probably intended a value; failing closed
    // is safer than silently treating it as "default account".
  }

  const failback = obj['failback_policy'];
  const registry: ProfileRegistry = {
    default_profile: def,
    profiles: out,
  };
  if (failback === 'manual' || failback === 'auto' || failback === 'disabled') {
    registry.failback_policy = failback;
  }
  return registry;
}

/**
 * Resolve a profile name (or unset) to a `Profile` against a registry.
 *
 * - `name` set + present in `profiles` → returns that profile.
 * - `name` set + absent → returns null (caller decides: warn + skip,
 *   or fall back to default).
 * - `name` unset → returns the `default_profile`'s entry, or null if
 *   the default is itself dangling.
 *
 * The two failure modes are distinguishable to the caller via the
 * `name` argument: "I asked for X explicitly and got null" vs "I
 * asked for the default and got null."
 */
export function resolveProfile(
  registry: ProfileRegistry,
  name?: string,
): Profile | null {
  const target = name ?? registry.default_profile;
  return registry.profiles[target] ?? null;
}

/**
 * Return the list of dangling references in a registry — names that
 * appear as `default_profile` or in some agent's `claude_profile`
 * but have no entry in `profiles`. Used by `doctor` to warn the
 * operator at fleet boot.
 *
 * `referenced` is the set of profile names that some agent's
 * config.json points at; supply via a separate scan in doctor.
 */
export function findDanglingReferences(
  registry: ProfileRegistry,
  referenced: Iterable<string>,
): string[] {
  const dangling: string[] = [];
  if (!(registry.default_profile in registry.profiles)) {
    dangling.push(registry.default_profile);
  }
  for (const name of referenced) {
    if (!(name in registry.profiles) && !dangling.includes(name)) {
      dangling.push(name);
    }
  }
  return dangling;
}
