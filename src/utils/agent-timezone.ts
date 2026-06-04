import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/** Read the `timezone` field from an agent config.json, or undefined. */
function readConfigTimezone(configPath: string): string | undefined {
  if (!existsSync(configPath)) return undefined;
  try {
    const tz = JSON.parse(readFileSync(configPath, 'utf-8')).timezone;
    if (typeof tz === 'string' && tz.trim()) return tz.trim();
  } catch { /* malformed config */ }
  return undefined;
}

/**
 * Resolve an agent's configured IANA timezone from its config.json — the SAME
 * source the agent PTY uses (src/pty/agent-pty.ts) and that the cron scheduler
 * interprets cron hours in (#481). Returns undefined when the agent has no
 * configured timezone, so callers can apply their own fallback (host zone).
 *
 * config.json lives in the agent's project dir (frameworkRoot first, ctxRoot
 * fallback): <root>/orgs/<org>/agents/<agent>/config.json.
 */
export function resolveAgentTimezone(opts: {
  agent: string;
  org?: string;
  frameworkRoot?: string;
  ctxRoot?: string;
}): string | undefined {
  const roots = [opts.frameworkRoot, opts.ctxRoot].filter((r): r is string => !!r);
  for (const root of roots) {
    // Preferred: the known org's direct path.
    if (opts.org) {
      const tz = readConfigTimezone(join(root, 'orgs', opts.org, 'agents', opts.agent, 'config.json'));
      if (tz) return tz;
    }
    // Fallback: scan every org for this agent, so a missing/mismatched org
    // (e.g. a legacy enabled-agents row) still resolves the configured TZ (#481)
    // rather than silently dropping to the host zone.
    const orgsDir = join(root, 'orgs');
    if (existsSync(orgsDir)) {
      let entries: string[];
      try { entries = readdirSync(orgsDir); } catch { continue; }
      for (const org of entries) {
        if (org === opts.org) continue; // already tried above
        const tz = readConfigTimezone(join(orgsDir, org, 'agents', opts.agent, 'config.json'));
        if (tz) return tz;
      }
    }
  }
  return undefined;
}

/** True if `tz` is a usable IANA timezone (Intl accepts it). */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The host's IANA timezone (e.g. "Australia/Sydney"), used as the no-config fallback. */
export function hostTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
