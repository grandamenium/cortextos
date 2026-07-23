/**
 * cron-registration.ts — reconcile a cron's DECLARED intent against its LIVE registration.
 *
 * THE DEATH MODE THIS CATCHES, AND WHY THE FIRE-GAP RULE CANNOT:
 * A cron can fail in two ways. It can be REGISTERED BUT NOT FIRING (cron-health.ts's
 * missed-slot rule catches that). Or it can simply NOT BE THERE — removed, disabled, or
 * drifted out of one of the two files that must agree. A monitor that never existed has
 * no fire gap to measure: it is not late, it is ABSENT, and every fire-based check will
 * report nothing wrong forever because there is nothing to report on.
 *
 * This is not hypothetical. `safetystack-handoff-check` was live in crons.json and absent
 * from config.json — a rebuild-from-config would have silently DELETED it, and nothing in
 * the system would have said a word. We found it by hand, which is not a strategy.
 *
 * CANONICAL SOURCE = config.json's `crons` array. A human writes it, it is in git, and
 * CLAUDE.md already names it as the source of truth. No new registry to drift.
 *
 * Pure and I/O-free on purpose: the caller reads the two files, this decides.
 *
 * KNOWN LIMIT — deliberate, not an oversight: this reconciles BY NAME. A cron present in
 * both files under the same name but with a DIFFERENT SCHEDULE is not flagged. That cron
 * still fires — it may just fire at the wrong time — which is a different failure from the
 * ABSENCE this function exists to catch, and the missed-slot rule in cron-health.ts covers
 * the case where a wrong schedule means it stops firing when expected. Scope kept narrow on
 * purpose; schedule-drift is a follow-up, not a silent gap.
 */

/** One cron as DECLARED in config.json. */
export interface DeclaredCron {
  name: string;
  interval?: string;
}

/** One cron as REGISTERED in the live crons.json. */
export interface RegisteredCron {
  name: string;
  schedule?: string;
  enabled?: boolean;
}

export type DriftKind =
  /** Declared in config.json but not registered live: IT WILL NEVER FIRE, and no fire-gap check can see that. */
  | 'declared-not-registered'
  /** Registered live but absent from config.json: a rebuild-from-config DELETES it, silently. */
  | 'registered-not-declared'
  /** Registered but explicitly disabled: present, and still never fires. */
  | 'registered-but-disabled'
  /** On disk one way, but the RUNNING scheduler holds a different schedule (never-reloaded edit). */
  | 'schedule-stale'
  /** The RUNNING scheduler still fires a cron that was REMOVED from crons.json (never-reloaded removal). */
  | 'scheduler-orphan';

export interface CronDrift {
  agent: string;
  cron: string;
  kind: DriftKind;
  detail: string;
}

/**
 * Compare declared intent against live registration. Any asymmetry is drift.
 *
 * Returns [] when the two agree — and an EMPTY RESULT IS A REAL RESULT here, not a
 * vacuous pass: the caller is expected to assert it examined a non-zero number of crons
 * (see reconcileAgentCrons' `examined` count). A reconcile that silently compared two
 * empty lists and reported "no drift" would be the exact tick-over-nothing we have been
 * killing all week.
 */
/** One cron as the RUNNING scheduler holds it in memory. */
export interface LiveCron {
  name: string;
  schedule: string;
}

/**
 * Compare the on-disk crons.json schedule against what the RUNNING scheduler holds.
 *
 * THE THIRD SURFACE. reconcileAgentCrons (below) compares two FILES — config.json and
 * crons.json. But a cron that is in both files, agreeing, can STILL fire on a stale
 * schedule if the file was hand-edited and the daemon never reloaded: the scheduler holds
 * its own in-memory copy, and nothing in either file reflects it. That drift — the MOST
 * COMMON one, a hand-edit that skipped the reload signal — is invisible to a file-vs-file
 * check and to every CLI (list-crons recomputes next-fire from disk; it never queries the
 * daemon). This compares crons.json (disk) against the scheduler (memory) and is the only
 * thing that can see a never-reloaded edit.
 *
 * Pure and I/O-free: the daemon reads both (crons.json via readCrons, the live schedules via
 * scheduler.getLiveSchedules()) and hands them here. Returns `examined` so a caller cannot
 * read an empty result over an empty comparison as an all-clear.
 */
export function reconcileLiveSchedule(
  agent: string,
  declared: RegisteredCron[],   // from crons.json on disk
  live: LiveCron[],             // from scheduler.getLiveSchedules() in memory
): { drift: CronDrift[]; examined: number } {
  const drift: CronDrift[] = [];
  const liveByName = new Map(live.map(c => [c.name, c]));
  for (const d of declared) {
    if (d.enabled === false) continue;         // disabled crons are not scheduled; not stale
    const l = liveByName.get(d.name);
    if (!l) {
      // On disk + enabled, but the scheduler doesn't hold it: it was added/enabled without a
      // reload, so it is NOT actually firing yet.
      drift.push({
        agent, cron: d.name, kind: 'declared-not-registered',
        detail: `on disk + enabled but the running scheduler has no entry — added/enabled without a reload; it is not firing`,
      });
      continue;
    }
    if ((d.schedule ?? '') !== l.schedule) {
      drift.push({
        agent, cron: d.name, kind: 'schedule-stale',
        detail: `crons.json says "${d.schedule}" but the running scheduler is firing "${l.schedule}" — the file was edited without a reload signal`,
      });
    }
  }

  // THE INVERSE DIRECTION — an ORPHAN. A cron REMOVED from crons.json that the scheduler
  // STILL HOLDS keeps FIRING, because the removal skipped the reload signal. The file check
  // is bidirectional; this must be too, or `examined` below counts the orphan while no drift
  // is emitted for it — a count that reads "covered" over a case never checked, the exact
  // failure this whole file exists to kill. Lower consequence than a silent monitor (an
  // orphan over-fires rather than going dark) but the same drift, same trigger: a hand-edit
  // that skipped the reload.
  const declaredNames = new Set(declared.map(d => d.name));
  for (const l of live) {
    if (!declaredNames.has(l.name)) {
      drift.push({
        agent, cron: l.name, kind: 'scheduler-orphan',
        detail: `the running scheduler is firing "${l.name}" ("${l.schedule}") but it is absent from crons.json — removed without a reload; it keeps firing`,
      });
    }
  }

  const examined = new Set([...declared.map(d => d.name), ...liveByName.keys()]).size;
  return { drift, examined };
}

export function reconcileAgentCrons(
  agent: string,
  declared: DeclaredCron[],
  registered: RegisteredCron[],
): { drift: CronDrift[]; examined: number } {
  const drift: CronDrift[] = [];
  const liveByName = new Map(registered.map(c => [c.name, c]));
  const declaredNames = new Set(declared.map(c => c.name));

  for (const d of declared) {
    const live = liveByName.get(d.name);
    if (!live) {
      drift.push({
        agent, cron: d.name, kind: 'declared-not-registered',
        detail: `declared in config.json but NOT registered live — it will never fire, and no fire-gap check can see that`,
      });
      continue;
    }
    if (live.enabled === false) {
      drift.push({
        agent, cron: d.name, kind: 'registered-but-disabled',
        detail: `registered but disabled — present, and still never fires`,
      });
    }
  }

  for (const r of registered) {
    if (!declaredNames.has(r.name)) {
      drift.push({
        agent, cron: r.name, kind: 'registered-not-declared',
        detail: `live but absent from config.json — a rebuild-from-config would silently DELETE it`,
      });
    }
  }

  // The union: what we actually compared. A caller that sees examined === 0 has learned
  // nothing, and must not read the empty drift list as an all-clear.
  const examined = new Set([...declaredNames, ...liveByName.keys()]).size;
  return { drift, examined };
}
