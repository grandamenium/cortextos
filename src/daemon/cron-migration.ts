/**
 * cron-migration.ts — Subtask 2.2: Auto-migration of crons from config.json → crons.json
 *
 * Migrates each agent's `crons` array from its config.json into the external
 * persistent crons.json format understood by the daemon CronScheduler.
 *
 * ## Idempotency
 * A zero-byte marker file at `{CTX_ROOT}/.cortextOS/state/agents/{agent}/.crons-migrated`
 * signals that migration already ran.  The migration is skipped entirely when the
 * marker exists, unless `force: true` is passed (which deletes the marker first).
 *
 * ## One-shot crons
 * CronDefinition supports interval-based and cron-expression schedules only —
 * there is no "fire once at time T" field in the external schema (as of Subtask 1.1).
 * One-shot crons from config.json (type:"once" with fire_at) are therefore:
 *   - Skipped with a log message if fire_at is in the past.
 *   - Skipped with a log message if fire_at is in the future (not representable in CronDefinition).
 *
 * TODO (future subtask): add a `fire_at` field to CronDefinition and teach
 * CronScheduler to fire them once then remove them.  When that lands, the
 * one-shot migration path below can be uncommented/extended.
 *
 * ## Non-destructive
 * The original `crons` array in config.json is never modified.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import type { CronDefinition, CronEntry } from '../types/index.js';
import { readCrons, writeCrons } from '../bus/crons.js';
import { CRONS_DIRECTORY } from '../bus/crons-schema.js';
import { scanAgentDir } from '../utils/cron-teaching-scanner.js';

// ---------------------------------------------------------------------------
// Marker file path helpers
// ---------------------------------------------------------------------------

/**
 * Return the absolute path to the migration marker file for an agent.
 * Path: `{ctxRoot}/.cortextOS/state/agents/{agentName}/.crons-migrated`
 */
function markerPath(ctxRoot: string, agentName: string): string {
  return join(ctxRoot, CRONS_DIRECTORY, agentName, '.crons-migrated');
}

/**
 * Return true when the migration marker exists for this agent.
 */
export function isMigrated(ctxRoot: string, agentName: string): boolean {
  return existsSync(markerPath(ctxRoot, agentName));
}

/**
 * Write (or touch) the migration marker file.
 * Creates the directory if it does not already exist.
 */
function writeMarker(ctxRoot: string, agentName: string): void {
  const path = markerPath(ctxRoot, agentName);
  mkdirSync(join(ctxRoot, CRONS_DIRECTORY, agentName), { recursive: true });
  writeFileSync(path, '', { encoding: 'utf-8', mode: 0o600 });
}

/**
 * Delete the migration marker file (used by --force re-migration).
 * No-op if the marker does not exist.
 */
function deleteMarker(ctxRoot: string, agentName: string): void {
  const path = markerPath(ctxRoot, agentName);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

// ---------------------------------------------------------------------------
// Cron-teaching upgrade advisory (Part C of upgrade-cron-teaching follow-up)
//
// The data migration above moves cron entries from config.json -> crons.json.
// The *teaching* (CronCreate / /loop / config.json prose) inside each agent's
// CLAUDE.md, AGENTS.md, ONBOARDING.md, and SKILL.md files is independent of
// that data migration and frequently lags behind. The advisory below scans
// the agent workspace once per agent, logs a single warning line listing the
// stale-reference count, and drops a `.cron-teaching-checked` marker so the
// scan does not repeat on every daemon boot. Pure advisory: never blocks
// migration, and never modifies workspace files.
// ---------------------------------------------------------------------------

const TEACHING_MARKER_NAME = '.cron-teaching-checked';

function teachingMarkerPath(ctxRoot: string, agentName: string): string {
  return join(ctxRoot, CRONS_DIRECTORY, agentName, TEACHING_MARKER_NAME);
}

/** True when the cron-teaching scan has already run for this agent. */
export function isTeachingChecked(ctxRoot: string, agentName: string): boolean {
  return existsSync(teachingMarkerPath(ctxRoot, agentName));
}

function writeTeachingMarker(ctxRoot: string, agentName: string): void {
  const path = teachingMarkerPath(ctxRoot, agentName);
  mkdirSync(join(ctxRoot, CRONS_DIRECTORY, agentName), { recursive: true });
  writeFileSync(path, '', { encoding: 'utf-8', mode: 0o600 });
}

function deleteTeachingMarker(ctxRoot: string, agentName: string): void {
  const path = teachingMarkerPath(ctxRoot, agentName);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

interface TeachingCheckArgs {
  agentName: string;
  agentDir: string;
  ctxRoot: string;
  force: boolean;
  log: (msg: string) => void;
}

/**
 * Scan one agent's workspace for stale cron-teaching patterns. Logs a single
 * advisory line if any matches are found, then drops the
 * `.cron-teaching-checked` marker so the scan does not repeat. Honors the
 * `force` option for parity with `migrateCronsForAgent`.
 */
function runTeachingCheck(args: TeachingCheckArgs): void {
  if (args.force) {
    deleteTeachingMarker(args.ctxRoot, args.agentName);
  }
  if (isTeachingChecked(args.ctxRoot, args.agentName)) {
    return;
  }

  // Workspace dir may not exist (e.g. migration called against a config path
  // whose parent has been removed). Drop the marker anyway so we do not loop.
  if (!existsSync(args.agentDir)) {
    writeTeachingMarker(args.ctxRoot, args.agentName);
    return;
  }

  const result = scanAgentDir(args.agentDir);
  if (result.matches.length > 0) {
    const fileCount = new Set(result.matches.map((m) => m.file)).size;
    args.log(
      `cron-teaching upgrade recommended: ${result.matches.length} stale references in ${fileCount} files. ` +
        `Run cortextos bus upgrade-cron-teaching ${args.agentName}`,
    );
  }
  writeTeachingMarker(args.ctxRoot, args.agentName);
}

// ---------------------------------------------------------------------------
// Config.json cron conversion
// ---------------------------------------------------------------------------

/**
 * Convert a single CronEntry (config.json format) to a CronDefinition (crons.json format).
 *
 * Returns null with a reason string when the entry cannot be converted (e.g. one-shot crons).
 */
function convertEntry(
  entry: CronEntry,
  agentName: string,
): { cron: CronDefinition } | { skip: string } {
  const { name, type, interval, cron: cronExpr, fire_at, prompt } = entry;

  // Treat absent `type` as "recurring" (spec requirement)
  const effectiveType = type ?? 'recurring';

  // Disabled crons: migrate as disabled (preserve operator intent)
  if (effectiveType === 'disabled') {
    // Disabled entries still need a schedule — use interval or cron expression if present
    const schedule = cronExpr ?? interval;
    if (!schedule) {
      return { skip: `cron "${name}" is disabled and has no interval/cron — skipping` };
    }
    const def: CronDefinition = {
      name,
      prompt: prompt ?? '',
      schedule,
      enabled: false,
      created_at: new Date().toISOString(),
      description: `Migrated from config.json (was disabled)`,
      metadata: { migrated_from_config: true, original_type: effectiveType },
    };
    return { cron: def };
  }

  // One-shot crons — CronDefinition has no fire_at field yet
  if (effectiveType === 'once') {
    if (!fire_at) {
      return {
        skip: `cron "${name}" has type "once" but no fire_at timestamp — skipping. ` +
          `TODO: once CronDefinition supports fire_at, migrate this entry.`,
      };
    }
    const fireAtMs = Date.parse(fire_at);
    if (isNaN(fireAtMs)) {
      return {
        skip: `cron "${name}" has type "once" with unparseable fire_at "${fire_at}" — skipping`,
      };
    }
    if (fireAtMs <= Date.now()) {
      return {
        skip: `cron "${name}" has type "once" with past fire_at "${fire_at}" — skipping (already fired or expired)`,
      };
    }
    // Future one-shot — still not representable in CronDefinition as of Subtask 1.1
    return {
      skip: `cron "${name}" has type "once" with future fire_at "${fire_at}" — skipping. ` +
        `TODO: once CronDefinition supports fire_at, migrate this as a one-shot.`,
    };
  }

  // Recurring cron — requires a schedule
  // Use cron expression if present (takes precedence), else interval shorthand
  const schedule = cronExpr ?? interval;
  if (!schedule) {
    return {
      skip: `cron "${name}" has no interval or cron expression — skipping`,
    };
  }

  if (!prompt) {
    return {
      skip: `cron "${name}" has no prompt — skipping`,
    };
  }

  const def: CronDefinition = {
    name,
    prompt,
    schedule,
    enabled: true,
    created_at: new Date().toISOString(),
    metadata: { migrated_from_config: true, original_type: effectiveType },
  };

  return { cron: def };
}

// ---------------------------------------------------------------------------
// Per-agent migration
// ---------------------------------------------------------------------------

export interface MigrationOptions {
  /** Re-run even if the marker file already exists (deletes marker first). */
  force?: boolean;
  /** Custom logger (defaults to console.log). */
  log?: (msg: string) => void;
}

export interface MigrationResult {
  /** Agent name processed. */
  agentName: string;
  /** Disposition: skipped-already-migrated | no-config | no-crons | migrated */
  status: 'skipped-already-migrated' | 'no-config' | 'no-crons' | 'migrated';
  /** Number of crons written to crons.json (only set when status === "migrated"). */
  cronsMigrated?: number;
  /** Names of crons that were skipped (one-shots, missing fields, etc.). */
  cronsSkipped?: string[];
}

/**
 * Migrate crons for a single agent from its config.json → crons.json.
 *
 * @param agentName       - The agent directory name (e.g. "boris", "paul").
 * @param configJsonPath  - Absolute path to the agent's config.json.
 * @param ctxRoot         - Absolute path to CTX_ROOT (where state dirs live).
 * @param options         - Optional: force re-migration, custom logger.
 * @returns A MigrationResult describing what happened.
 */
export function migrateCronsForAgent(
  agentName: string,
  configJsonPath: string,
  ctxRoot: string,
  options: MigrationOptions = {},
): MigrationResult {
  const log = options.log ?? ((msg: string) => console.log(`[cron-migration] ${msg}`));

  const result = runMigrationCore(agentName, configJsonPath, ctxRoot, options, log);

  // Part C: cron-teaching upgrade advisory. Independent of cron-data migration
  // (uses its own marker). Pure advisory — never blocks the migration result.
  try {
    runTeachingCheck({
      agentName,
      agentDir: dirname(configJsonPath),
      ctxRoot,
      force: !!options.force,
      log,
    });
  } catch (err) {
    log(
      `cron-teaching scan failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return result;
}

/** Core migration logic. Public callers go through `migrateCronsForAgent`. */
function runMigrationCore(
  agentName: string,
  configJsonPath: string,
  ctxRoot: string,
  options: MigrationOptions,
  log: (msg: string) => void,
): MigrationResult {
  // --force: delete marker to allow re-migration
  if (options.force) {
    deleteMarker(ctxRoot, agentName);
    log(`Force flag set — cleared migration marker for "${agentName}"`);
  }

  // Idempotency check: already migrated → skip
  if (isMigrated(ctxRoot, agentName)) {
    log(`Skipping migration for "${agentName}" — already migrated`);
    return { agentName, status: 'skipped-already-migrated' };
  }

  // Read config.json — no-op on missing file
  if (!existsSync(configJsonPath)) {
    log(`No config.json found for "${agentName}" at ${configJsonPath} — writing empty crons.json + marker`);
    writeCrons(agentName, []);
    writeMarker(ctxRoot, agentName);
    return { agentName, status: 'no-config' };
  }

  let rawConfig: unknown;
  try {
    rawConfig = JSON.parse(readFileSync(configJsonPath, 'utf-8'));
  } catch (err) {
    // Unreadable / corrupt config.json: write empty crons.json + marker so we
    // don't retry on every boot with the same broken file
    log(
      `WARNING: failed to parse config.json for "${agentName}" — writing empty crons.json + marker. ` +
        `Error: ${err instanceof Error ? err.message : String(err)}`,
    );
    writeCrons(agentName, []);
    writeMarker(ctxRoot, agentName);
    return { agentName, status: 'no-crons' };
  }

  // Extract crons array — treat missing / empty as "no crons"
  const configCrons: CronEntry[] = [];
  if (
    rawConfig !== null &&
    typeof rawConfig === 'object' &&
    'crons' in rawConfig &&
    Array.isArray((rawConfig as { crons?: unknown }).crons)
  ) {
    configCrons.push(...((rawConfig as { crons: CronEntry[] }).crons));
  }

  if (configCrons.length === 0) {
    log(`No crons array in config.json for "${agentName}" — writing empty crons.json + marker`);
    writeCrons(agentName, []);
    writeMarker(ctxRoot, agentName);
    return { agentName, status: 'no-crons' };
  }

  // Convert each entry
  const converted: CronDefinition[] = [];
  const skipped: string[] = [];

  for (const entry of configCrons) {
    const result = convertEntry(entry, agentName);
    if ('cron' in result) {
      converted.push(result.cron);
      log(`  Migrated cron "${entry.name}" for "${agentName}" (schedule: ${result.cron.schedule})`);
    } else {
      skipped.push(entry.name);
      log(`  Skipped cron for "${agentName}": ${result.skip}`);
    }
  }

  // Write crons.json atomically and set marker
  writeCrons(agentName, converted);
  writeMarker(ctxRoot, agentName);

  log(
    `Migration complete for "${agentName}": ${converted.length} migrated, ${skipped.length} skipped`,
  );

  return {
    agentName,
    status: 'migrated',
    cronsMigrated: converted.length,
    cronsSkipped: skipped,
  };
}

// ---------------------------------------------------------------------------
// Multi-agent migration
// ---------------------------------------------------------------------------

export interface MultiMigrationSummary {
  processed: number;
  totalCronsMigrated: number;
  results: MigrationResult[];
}

/**
 * Discover all agents in the framework and migrate each one.
 *
 * Scans `{frameworkRoot}/orgs/{org}/agents/{name}/config.json` for every agent
 * directory found on disk.  The CTX_ROOT for state (marker files and crons.json)
 * is resolved from `process.env.CTX_ROOT` when not explicitly provided.
 *
 * @param frameworkRoot - Absolute path to the framework root.
 * @param ctxRoot       - Absolute path to CTX_ROOT (state dir root).
 * @param options       - Optional: force, custom logger.
 * @returns Summary across all agents.
 */
export function migrateAllAgents(
  frameworkRoot: string,
  ctxRoot: string,
  options: MigrationOptions = {},
): MultiMigrationSummary {
  const log = options.log ?? ((msg: string) => console.log(`[cron-migration] ${msg}`));

  const { readdirSync: fsReaddir, existsSync: fsExists } = require('fs') as {
    readdirSync: typeof import('fs').readdirSync;
    existsSync: typeof import('fs').existsSync;
  };

  const results: MigrationResult[] = [];

  const orgsBase = join(frameworkRoot, 'orgs');
  if (!fsExists(orgsBase)) {
    log(`No orgs directory found at ${orgsBase} — nothing to migrate`);
    return { processed: 0, totalCronsMigrated: 0, results };
  }

  let orgNames: string[] = [];
  try {
    orgNames = fsReaddir(orgsBase, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (err) {
    log(`Failed to read orgs directory: ${err instanceof Error ? err.message : String(err)}`);
    return { processed: 0, totalCronsMigrated: 0, results };
  }

  for (const org of orgNames) {
    const agentsBase = join(orgsBase, org, 'agents');
    if (!fsExists(agentsBase)) continue;

    let agentNames: string[] = [];
    try {
      agentNames = fsReaddir(agentsBase, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue;
    }

    for (const name of agentNames) {
      const configPath = join(agentsBase, name, 'config.json');
      try {
        const result = migrateCronsForAgent(name, configPath, ctxRoot, { ...options, log });
        results.push(result);
      } catch (err) {
        log(
          `ERROR: unexpected failure migrating "${name}": ${err instanceof Error ? err.message : String(err)}`,
        );
        results.push({ agentName: name, status: 'no-config' });
      }
    }
  }

  const totalCronsMigrated = results.reduce((sum, r) => sum + (r.cronsMigrated ?? 0), 0);

  log(
    `All-agent migration complete: ${results.length} agents processed, ${totalCronsMigrated} total crons migrated`,
  );

  return { processed: results.length, totalCronsMigrated, results };
}
