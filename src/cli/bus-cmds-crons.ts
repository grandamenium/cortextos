import { Command } from 'commander';
import { join } from 'path';
import { validateAgentName } from '../utils/validate.js';
import { resolveEnv } from '../utils/env.js';
import { resolvePaths } from '../utils/paths.js';
import { updateCronFire, parseDurationMs, readCronState } from '../bus/cron-state.js';
import { addCron, removeCron, readCrons, updateCron as updateCronDef, getCronByName, getExecutionLog } from '../bus/crons.js';
import { nextFireFromCron } from '../daemon/cron-scheduler.js';
import { IPCClient } from '../daemon/ipc-server.js';
import type { CronDefinition } from '../types/index.js';

// ---------------------------------------------------------------------------
// External Persistent Cron Management helpers
// ---------------------------------------------------------------------------

/**
 * Validate a schedule string — either an interval shorthand ("6h", "30m") or
 * a 5-field cron expression ("0 8 * * *").  Returns the normalised schedule
 * string, or throws an Error with a human-readable message on failure.
 */
function validateSchedule(raw: string): string {
  const trimmed = raw.trim();
  // Detect format by counting whitespace-separated tokens
  const tokens = trimmed.split(/\s+/);
  if (tokens.length === 1) {
    // Interval shorthand: must match parseDurationMs
    if (isNaN(parseDurationMs(trimmed))) {
      throw new Error(
        `Invalid interval '${trimmed}'. Expected formats: "6h", "30m", "1d", "2w".`
      );
    }
    return trimmed;
  }
  if (tokens.length === 5) {
    // 5-field cron expression: validate by computing a next fire time
    const probe = nextFireFromCron(trimmed, Date.now());
    if (isNaN(probe)) {
      throw new Error(
        `Invalid cron expression '${trimmed}'. Expected 5-field cron ("0 8 * * *", "*/30 * * * *", etc.).`
      );
    }
    return trimmed;
  }
  throw new Error(
    `Invalid schedule '${trimmed}'. Use an interval ("6h") or a 5-field cron expression ("0 8 * * *").`
  );
}

/**
 * Check whether an agent exists in the current framework root.
 * Returns false if the framework root is unknown (graceful degradation).
 */
function agentExistsInFramework(agentName: string, frameworkRoot: string): boolean {
  if (!frameworkRoot) return true; // can't check — allow
  const { existsSync: fsExists, readdirSync: fsReaddir } = require('fs');
  const { join: pjoin } = require('path');
  const orgsDir = pjoin(frameworkRoot, 'orgs');
  if (!fsExists(orgsDir)) return true; // no orgs dir — allow
  try {
    for (const org of fsReaddir(orgsDir)) {
      if (fsExists(pjoin(orgsDir, org, 'agents', agentName))) return true;
    }
  } catch { /* ignore */ }
  return false;
}

/**
 * Format an ISO timestamp for display (shortens to "YYYY-MM-DD HH:mm UTC").
 */
function fmtTs(iso: string | undefined): string {
  if (!iso) return '-';
  return iso.replace('T', ' ').slice(0, 16) + ' UTC';
}

/**
 * Send a reload-crons IPC signal to the daemon (non-blocking, best-effort).
 * Silently swallows errors — the daemon will pick up changes on its next tick.
 */
async function signalCronReload(agentName: string, instanceId: string): Promise<void> {
  try {
    const ipc = new IPCClient(instanceId);
    await ipc.send({ type: 'reload-crons', agent: agentName, source: 'cortextos bus cron-cmd' });
  } catch { /* non-fatal — scheduler picks up file change on next 30s tick */ }
}

// ---------------------------------------------------------------------------
// registerCronCommands — attaches all cron-related subcommands to busCommand
// ---------------------------------------------------------------------------

export function registerCronCommands(busCommand: Command): void {

  busCommand
    .command('update-cron-fire')
    .argument('<cron-name>', 'Name of the cron as defined in config.json')
    .option('--interval <interval>', 'Expected interval, e.g. "6h", "24h", "30m"')
    .description('Record that a named cron just fired (enables daemon gap detection for dead zones)')
    .action((cronName: string, opts: { interval?: string }) => {
      const env = resolveEnv();
      const paths = resolvePaths(env.agentName, env.instanceId, env.org);
      updateCronFire(paths.stateDir, cronName, opts.interval);
      console.log(`Recorded fire for cron "${cronName}"`);
    });

  // ---------------------------------------------------------------------------
  // External Persistent Cron Management (Subtask 1.4)
  // ---------------------------------------------------------------------------

  busCommand
    .command('add-cron')
    .description('Add a new persistent cron for an agent')
    .argument('<agent>', 'Agent name')
    .argument('<name>', 'Cron name (unique per agent, slug format recommended)')
    .argument('<interval>', 'Schedule: interval ("6h", "30m", "1d") or 5-field cron expr ("0 8 * * *")')
    .argument('<prompt...>', 'Prompt text injected when the cron fires (all remaining words joined)')
    .option('--desc <description>', 'Human-readable description (optional)')
    .action(async (agent: string, name: string, interval: string, promptWords: string[], opts: { desc?: string }) => {
      // Validate agent name format
      try { validateAgentName(agent); } catch (err) { console.error(String(err)); process.exit(1); }

      const env = resolveEnv();

      // Validate agent exists in framework
      if (!agentExistsInFramework(agent, env.frameworkRoot)) {
        console.error(`Error: agent '${agent}' not found in framework. Check orgs/*/agents/ directory.`);
        process.exit(1);
      }

      // Validate schedule
      let schedule: string;
      try { schedule = validateSchedule(interval); } catch (err) { console.error(String(err)); process.exit(1); }

      const prompt = promptWords.join(' ');
      const cron: CronDefinition = {
        name,
        prompt,
        schedule,
        enabled: true,
        created_at: new Date().toISOString(),
        ...(opts.desc ? { description: opts.desc } : {}),
      };

      try {
        addCron(agent, cron);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      await signalCronReload(agent, env.instanceId);
      console.log(`Added cron '${name}' for ${agent}`);
    });

  busCommand
    .command('remove-cron')
    .description('Remove a persistent cron from an agent')
    .argument('<agent>', 'Agent name')
    .argument('<name>', 'Cron name to remove')
    .action(async (agent: string, name: string) => {
      try { validateAgentName(agent); } catch (err) { console.error(String(err)); process.exit(1); }

      const removed = removeCron(agent, name);
      if (!removed) {
        console.error(`Error: cron '${name}' not found for agent '${agent}'.`);
        process.exit(1);
      }

      const env = resolveEnv();
      await signalCronReload(agent, env.instanceId);
      console.log(`Removed cron '${name}' from ${agent}`);
    });

  busCommand
    .command('list-crons')
    .description('List all persistent crons configured for an agent')
    .argument('<agent>', 'Agent name')
    .option('--json', 'Emit raw JSON instead of a formatted table')
    .action((agent: string, opts: { json?: boolean }) => {
      try { validateAgentName(agent); } catch (err) { console.error(String(err)); process.exit(1); }

      const crons = readCrons(agent);

      // BUG 1 fix: merge cron-state.json's `last_fire` records into the displayed
      // last-fire timestamp. The daemon writes fire timestamps to two surfaces:
      //   - crons.json `last_fired_at` (via cron-scheduler.updateCron)
      //   - cron-state.json `last_fire` (via bus update-cron-fire from agent skills)
      // For a single source of truth in the CLI, take the most recent of the two.
      const env = resolveEnv();
      const paths = resolvePaths(agent, env.instanceId, env.org);
      const stateRecords = readCronState(paths.stateDir).crons;
      const fireByName = new Map<string, string>();
      for (const rec of stateRecords) fireByName.set(rec.name, rec.last_fire);

      const mostRecent = (a?: string, b?: string): string | undefined => {
        if (!a) return b;
        if (!b) return a;
        return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
      };

      if (opts.json) {
        const enriched = crons.map(c => ({
          ...c,
          last_fired_at: mostRecent(c.last_fired_at, fireByName.get(c.name)),
        }));
        console.log(JSON.stringify(enriched, null, 2));
        return;
      }

      if (crons.length === 0) {
        console.log(`No crons configured for ${agent}`);
        return;
      }

      // Compute next_fire_at for each cron so the table is informative
      const now = Date.now();
      const rows = crons.map(c => {
        const lastFire = mostRecent(c.last_fired_at, fireByName.get(c.name));
        let nextFire = '-';
        const dms = parseDurationMs(c.schedule);
        if (!isNaN(dms)) {
          // For interval-based crons, use the most recent of last_fired_at and
          // last_fire_attempted_at as the reference. spawn-codex crons update
          // last_fire_attempted_at on dispatch but only update last_fired_at on
          // confirmed completion — using attempted avoids stale nextFire display.
          const refTs = mostRecent(lastFire, c.last_fire_attempted_at);
          const refMs = refTs ? new Date(refTs).getTime() : now;
          nextFire = fmtTs(new Date(refMs + dms).toISOString());
        } else {
          const nf = nextFireFromCron(c.schedule, now);
          if (!isNaN(nf)) nextFire = fmtTs(new Date(nf).toISOString());
        }
        const promptPreview = c.prompt.length > 60 ? c.prompt.slice(0, 57) + '...' : c.prompt;
        return {
          name: c.name,
          schedule: c.schedule,
          enabled: c.enabled ? 'yes' : 'no',
          last_fire: fmtTs(lastFire),
          next_fire: nextFire,
          prompt: promptPreview,
        };
      });

      // Column widths
      const nameW = Math.max(4, ...rows.map(r => r.name.length));
      const schedW = Math.max(8, ...rows.map(r => r.schedule.length));
      const enW = 7;
      const lastW = 18;
      const nextW = 18;

      const pad = (s: string, w: number) => s.padEnd(w);
      const sep = '-'.repeat(nameW + schedW + enW + lastW + nextW + 63 + 5);

      console.log(`\nCrons for ${agent} (${rows.length})\n`);
      console.log(`  ${pad('Name', nameW)}  ${pad('Schedule', schedW)}  ${pad('Enabled', enW)}  ${pad('Last Fire', lastW)}  ${pad('Next Fire', nextW)}  Prompt`);
      console.log(`  ${sep}`);
      for (const r of rows) {
        console.log(`  ${pad(r.name, nameW)}  ${pad(r.schedule, schedW)}  ${pad(r.enabled, enW)}  ${pad(r.last_fire, lastW)}  ${pad(r.next_fire, nextW)}  ${r.prompt}`);
      }
      console.log('');
    });

  busCommand
    .command('update-cron')
    .description('Update fields of an existing persistent cron')
    .argument('<agent>', 'Agent name')
    .argument('<name>', 'Cron name to update')
    .option('--interval <i>', 'New schedule (interval or cron expression)')
    .option('--cron-expr <e>', 'Alias for --interval (5-field cron expression)')
    .option('--prompt <p>', 'New prompt text')
    .option('--enabled <bool>', 'Enable (true) or disable (false) the cron')
    .option('--desc <d>', 'New description')
    .option('--metadata <json>', 'Replace cron metadata with a JSON object')
    .action(async (agent: string, name: string, opts: { interval?: string; cronExpr?: string; prompt?: string; enabled?: string; desc?: string; metadata?: string }) => {
      try { validateAgentName(agent); } catch (err) { console.error(String(err)); process.exit(1); }

      const rawSchedule = opts.interval ?? opts.cronExpr;
      if (!rawSchedule && opts.prompt === undefined && opts.enabled === undefined && opts.desc === undefined && opts.metadata === undefined) {
        console.error('Error: at least one of --interval, --cron-expr, --prompt, --enabled, --desc, or --metadata is required.');
        process.exit(1);
      }

      const patch: Partial<CronDefinition> = {};

      if (rawSchedule !== undefined) {
        try { patch.schedule = validateSchedule(rawSchedule); } catch (err) { console.error(String(err)); process.exit(1); }
      }
      if (opts.prompt !== undefined) {
        patch.prompt = opts.prompt;
      }
      if (opts.enabled !== undefined) {
        if (opts.enabled !== 'true' && opts.enabled !== 'false') {
          console.error(`Error: --enabled must be 'true' or 'false', got '${opts.enabled}'.`);
          process.exit(1);
        }
        patch.enabled = opts.enabled === 'true';
      }
      if (opts.desc !== undefined) {
        patch.description = opts.desc;
      }
      if (opts.metadata !== undefined) {
        try {
          const parsed = JSON.parse(opts.metadata) as unknown;
          if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
            throw new Error('metadata must be a JSON object');
          }
          patch.metadata = parsed as Record<string, unknown>;
        } catch (err) {
          console.error(`Error: invalid --metadata JSON: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        }
      }

      const ok = updateCronDef(agent, name, patch);
      if (!ok) {
        console.error(`Error: cron '${name}' not found for agent '${agent}'.`);
        process.exit(1);
      }

      const env = resolveEnv();
      await signalCronReload(agent, env.instanceId);
      console.log(`Updated cron '${name}' for ${agent}`);
    });

  busCommand
    .command('test-cron-fire')
    .description('Fire a cron immediately for testing (injects prompt into agent PTY via daemon IPC)')
    .argument('<agent>', 'Agent name')
    .argument('<name>', 'Cron name to fire')
    .action(async (agent: string, name: string) => {
      try { validateAgentName(agent); } catch (err) { console.error(String(err)); process.exit(1); }

      const cron = getCronByName(agent, name);
      if (!cron) {
        console.error(`Error: cron '${name}' not found for agent '${agent}'.`);
        process.exit(1);
      }

      const env = resolveEnv();
      const ipc = new IPCClient(env.instanceId);

      const daemonRunning = await ipc.isDaemonRunning();
      if (!daemonRunning) {
        console.error('Error: daemon is not running. Start it with: cortextos start');
        process.exit(1);
      }

      const resp = await ipc.send({
        type: 'fire-cron',
        agent,
        data: { name: cron.name, prompt: cron.prompt },
        source: 'cortextos bus test-cron-fire',
      });

      if (!resp.success) {
        console.error(`Error: ${resp.error}`);
        process.exit(1);
      }

      console.log(`Fired cron '${name}' for ${agent}`);
    });

  busCommand
    .command('get-cron-log')
    .description('Display cron execution log entries for an agent')
    .argument('<agent>', 'Agent name')
    .argument('[name]', 'Cron name to filter by (optional — omit to show all crons)')
    .option('--limit <n>', 'Maximum number of entries to show (default: 50)', '50')
    .option('--json', 'Emit raw JSON array instead of a formatted table')
    .action((agent: string, name: string | undefined, opts: { limit?: string; json?: boolean }) => {
      try { validateAgentName(agent); } catch (err) { console.error(String(err)); process.exit(1); }

      const limit = parseInt(opts.limit ?? '50', 10);
      if (isNaN(limit) || limit < 0) {
        console.error(`Error: --limit must be a non-negative integer, got '${opts.limit}'.`);
        process.exit(1);
      }

      const entries = getExecutionLog(agent, name, limit);

      if (opts.json) {
        console.log(JSON.stringify(entries, null, 2));
        return;
      }

      if (entries.length === 0) {
        if (name !== undefined) {
          console.log(`No log entries for cron '${name}' on ${agent}`);
        } else {
          console.log(`No log entries for ${agent}`);
        }
        return;
      }

      // Human-readable table: ts | cron | status | attempt | duration | result/artifact/error
      const pad = (s: string, w: number) => s.padEnd(w);
      const header = `  ${pad('Timestamp', 20)}  ${pad('Cron', 22)}  ${pad('Status', 7)}  ${pad('Att', 3)}  ${pad('ms', 7)}  Result / Artifact / Error`;
      const sep = '-'.repeat(header.length);

      console.log(`\nExecution log for ${agent}${name ? ` / ${name}` : ''} (${entries.length} entries)\n`);
      console.log(header);
      console.log(`  ${sep}`);

      for (const e of entries) {
        const ts = e.ts.replace('T', ' ').slice(0, 19) + 'Z';
        const status = e.status;
        const att = String(e.attempt);
        const ms = String(e.duration_ms);
        const detail = String((e as any).artifact ?? (e as any).result ?? e.error ?? '');
        const cronPad = pad(e.cron.length > 22 ? e.cron.slice(0, 19) + '...' : e.cron, 22);
        console.log(
          `  ${pad(ts, 20)}  ${cronPad}  ${pad(status, 7)}  ${pad(att, 3)}  ${pad(ms, 7)}  ${detail.slice(0, 90)}`
        );
      }
      console.log('');
    });

  // ---------------------------------------------------------------------------
  // migrate-crons — Subtask 2.2: Manual one-shot migration command
  // ---------------------------------------------------------------------------

  busCommand
    .command('migrate-crons')
    .description('Migrate crons from config.json to crons.json for one or all agents')
    .argument('[agent]', 'Agent name to migrate (omit to migrate all enabled agents)')
    .option('--force', 'Re-run migration even if the marker file already exists')
    .action(async (agentArg: string | undefined, opts: { force?: boolean }) => {
      const { migrateCronsForAgent: migrateSingle, migrateAllAgents: migrateAll } = await import('../daemon/cron-migration.js');
      const env = resolveEnv();
      const ctxRoot = env.ctxRoot;
      const frameworkRoot = env.frameworkRoot || process.cwd();

      const log = (msg: string) => console.log(msg);
      const migOpts = { force: opts.force ?? false, log };

      if (agentArg) {
        // Single-agent migration
        try { validateAgentName(agentArg); } catch (err) { console.error(String(err)); process.exit(1); }

        // Resolve config.json path via filesystem scan
        const { existsSync: fsExists, readdirSync: fsReaddir } = require('fs') as typeof import('fs');
        const orgsDir = join(frameworkRoot, 'orgs');
        let configPath: string | undefined;
        if (fsExists(orgsDir)) {
          try {
            for (const org of fsReaddir(orgsDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)) {
              const candidate = join(orgsDir, org, 'agents', agentArg, 'config.json');
              if (fsExists(candidate)) { configPath = candidate; break; }
            }
          } catch { /* ignore scan errors */ }
        }

        if (!configPath) {
          console.error(`Error: agent '${agentArg}' not found in framework. Check orgs/*/agents/ directory.`);
          process.exit(1);
        }

        const result = migrateSingle(agentArg, configPath, ctxRoot, migOpts);

        switch (result.status) {
          case 'skipped-already-migrated':
            console.log(`Skipped ${agentArg}: already migrated (use --force to re-run)`);
            break;
          case 'no-config':
            console.log(`Skipped ${agentArg}: no config.json found`);
            break;
          case 'no-crons':
            console.log(`Skipped ${agentArg}: config.json has no crons — empty crons.json written`);
            break;
          case 'migrated':
            console.log(
              `Migrated ${agentArg}: ${result.cronsMigrated} cron(s) migrated` +
              (result.cronsSkipped?.length ? `, ${result.cronsSkipped.length} skipped (${result.cronsSkipped.join(', ')})` : '')
            );
            break;
        }
      } else {
        // All-agents migration
        const summary = migrateAll(frameworkRoot, ctxRoot, migOpts);

        const migrated = summary.results.filter(r => r.status === 'migrated').length;
        const skippedAlready = summary.results.filter(r => r.status === 'skipped-already-migrated').length;
        const noConfig = summary.results.filter(r => r.status === 'no-config').length;
        const noCrons = summary.results.filter(r => r.status === 'no-crons').length;

        console.log(`\nMigration summary:`);
        console.log(`  Agents processed    : ${summary.processed}`);
        console.log(`  Agents migrated     : ${migrated} (${summary.totalCronsMigrated} crons)`);
        console.log(`  Already migrated    : ${skippedAlready}`);
        console.log(`  No config.json      : ${noConfig}`);
        console.log(`  No crons in config  : ${noCrons}`);
      }
    });

  // ---------------------------------------------------------------------------
  // upgrade-cron-teaching — Subtask 2.4: scan agent workspace for stale
  // CronCreate / /loop / config.json cron-registration teaching that predates
  // the external-persistent-crons migration.  Scan-only by default; --apply
  // performs only the safe literal substitutions known not to depend on
  // surrounding context.
  // ---------------------------------------------------------------------------

  busCommand
    .command('upgrade-cron-teaching')
    .description('Scan agent workspace files for stale CronCreate/loop/config.json cron teaching')
    .argument('[agent]', 'Agent name to scan (omit to scan all agents under orgs/)')
    .option('--apply', 'Perform safe literal substitutions in place (does not rewrite CronCreate references)')
    .option('--json', 'Emit JSON instead of human-readable text')
    .action(async (
      agentArg: string | undefined,
      opts: { apply?: boolean; json?: boolean },
    ) => {
      const { scanAgentDir, groupMatchesByFile } =
        await import('../utils/cron-teaching-scanner.js');
      const env = resolveEnv();
      const frameworkRoot = env.frameworkRoot || process.cwd();

      const { existsSync: fsExists, readdirSync: fsReaddir } =
        require('fs') as typeof import('fs');

      // Resolve agent name to its absolute workspace dir (orgs/*/agents/AGENT).
      function resolveAgentDir(agent: string): string | undefined {
        const orgsDir = join(frameworkRoot, 'orgs');
        if (!fsExists(orgsDir)) return undefined;
        try {
          for (const entry of fsReaddir(orgsDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const candidate = join(orgsDir, entry.name, 'agents', agent);
            if (fsExists(candidate)) return candidate;
          }
        } catch {
          // ignore scan errors
        }
        return undefined;
      }

      // List every agent dir under orgs/ORG/agents/.
      function listAllAgents(): { agent: string; dir: string }[] {
        const orgsDir = join(frameworkRoot, 'orgs');
        const out: { agent: string; dir: string }[] = [];
        if (!fsExists(orgsDir)) return out;
        try {
          for (const orgEntry of fsReaddir(orgsDir, { withFileTypes: true })) {
            if (!orgEntry.isDirectory()) continue;
            const agentsRoot = join(orgsDir, orgEntry.name, 'agents');
            if (!fsExists(agentsRoot)) continue;
            for (const a of fsReaddir(agentsRoot, { withFileTypes: true })) {
              if (a.isDirectory() && !a.name.startsWith('.')) {
                out.push({ agent: a.name, dir: join(agentsRoot, a.name) });
              }
            }
          }
        } catch {
          // ignore scan errors
        }
        return out;
      }

      type Report = {
        agent: string;
        result: ReturnType<typeof scanAgentDir>;
      };

      const reports: Report[] = [];
      if (agentArg) {
        try { validateAgentName(agentArg); } catch (err) { console.error(String(err)); process.exit(1); }
        const dir = resolveAgentDir(agentArg);
        if (!dir) {
          console.error(`Error: agent '${agentArg}' not found under ${join(frameworkRoot, 'orgs')}/*/agents/`);
          process.exit(1);
        }
        reports.push({ agent: agentArg, result: scanAgentDir(dir, { apply: opts.apply }) });
      } else {
        for (const { agent, dir } of listAllAgents()) {
          reports.push({ agent, result: scanAgentDir(dir, { apply: opts.apply }) });
        }
      }

      if (opts.json) {
        console.log(JSON.stringify(
          reports.map((r) => ({
            agent: r.agent,
            agentDir: r.result.agentDir,
            scannedFiles: r.result.scannedFiles,
            skippedSentinelFiles: r.result.skippedSentinelFiles,
            appliedSubstitutions: r.result.appliedSubstitutions,
            matches: r.result.matches,
          })),
          null,
          2,
        ));
        const totalMatches = reports.reduce((sum, r) => sum + r.result.matches.length, 0);
        process.exit(totalMatches === 0 ? 0 : 1);
      }

      let totalMatches = 0;
      let totalApplied = 0;
      for (const { agent, result } of reports) {
        totalMatches += result.matches.length;
        totalApplied += result.appliedSubstitutions;

        if (result.matches.length === 0 && result.appliedSubstitutions === 0) {
          console.log(`✓ ${agent}: no stale cron-teaching references (${result.scannedFiles.length} files scanned)`);
          continue;
        }

        console.log(`\n${agent}: ${result.matches.length} stale reference(s) in ${result.scannedFiles.length} files`);
        if (result.skippedSentinelFiles.length > 0) {
          console.log(`  (skipped ${result.skippedSentinelFiles.length} sentinel-marked file(s): ${result.skippedSentinelFiles.map((f) => f.replace(result.agentDir + '/', '')).join(', ')})`);
        }
        const grouped = groupMatchesByFile(result.matches);
        for (const [file, matches] of grouped) {
          const rel = file.replace(result.agentDir + '/', '');
          console.log(`\n  ${rel}`);
          for (const m of matches) {
            console.log(`    L${m.line} [${m.pattern}]: ${m.excerpt}`);
            console.log(`      → ${m.suggestion}`);
          }
        }
        if (result.appliedSubstitutions > 0) {
          console.log(`\n  Applied ${result.appliedSubstitutions} safe substitution(s) in place.`);
        }
      }

      console.log(`\nSummary: ${totalMatches} stale reference(s) across ${reports.length} agent(s)` +
        (opts.apply ? `, ${totalApplied} substitution(s) applied.` : '.'));
      if (totalMatches > 0 && !opts.apply) {
        console.log(`Run with --apply to substitute the safe-rewritable patterns. CronCreate / /loop references must be updated manually.`);
      }
      process.exit(totalMatches === 0 ? 0 : 1);
    });

}
