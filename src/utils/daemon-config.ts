import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Daemon-level configuration loader. Reads
// ~/.cortextos/<instance>/config/daemon.json if present and returns the
// parsed object merged onto a defaults baseline. The file is OPTIONAL —
// zero-config installs use defaults; operators only create daemon.json
// when they want to tune the fleet-resilience watchdogs.
//
// Why not env vars: this file would grow several knobs across PR3/PR4/PR5
// (doctor cron interval, cron-dispatch storm threshold, future). Four+
// env vars is grep-hostile compared to a single JSON.
// ---------------------------------------------------------------------------

export interface DaemonConfig {
  /** Plan #4 — minutes between doctor-cron runs. Default 30. 0 disables. */
  doctor_cron_interval_minutes?: number;
  /** Plan #1 — override the default 3 distinct crons / 30 min threshold. Unused if absent. */
  cron_dispatch_storm_threshold?: number;
}

export function daemonConfigPath(instanceId: string = 'default'): string {
  return join(homedir(), '.cortextos', instanceId, 'config', 'daemon.json');
}

export function loadDaemonConfig(instanceId: string = 'default'): DaemonConfig {
  const p = daemonConfigPath(instanceId);
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null) return {};
    return parsed as DaemonConfig;
  } catch {
    // Malformed JSON falls back silently — operator gets the doctor warning
    // already via the existing parse-error check path for related files.
    return {};
  }
}
