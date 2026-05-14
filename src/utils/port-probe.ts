import { spawnSync, type SpawnSyncOptions } from 'child_process';

export type PortProbeResult = { free: true } | { free: false; holderPid: number };

// Injected for tests; defaults to real spawnSync.
type Runner = (cmd: string, args: string[], opts?: SpawnSyncOptions) =>
  { status: number | null; stdout: string | Buffer | null };

let runner: Runner = spawnSync as unknown as Runner;

export function __setPortProbeRunner(r: Runner | null): void {
  runner = r ?? (spawnSync as unknown as Runner);
}

/**
 * Check whether `port` is free. Uses `lsof -tiTCP:<port> -sTCP:LISTEN`,
 * which prints just the holding PID(s) on stdout. Treats a non-zero exit
 * with empty stdout as "free" (lsof exits 1 when no match).
 *
 * Sync (spawnSync) by design — the probe runs once at startup in the user's
 * foreground process; no event loop to keep responsive.
 */
export function probePort(port: number): PortProbeResult {
  const { stdout } = runner('lsof', ['-tiTCP:' + port, '-sTCP:LISTEN'], { encoding: 'utf-8' });
  const text = typeof stdout === 'string' ? stdout : stdout?.toString('utf-8') ?? '';
  const trimmed = text.trim();
  if (!trimmed) return { free: true };
  const firstLine = trimmed.split(/\s+/)[0];
  const pid = Number(firstLine);
  if (!Number.isFinite(pid) || pid <= 0) {
    // lsof returned output we couldn't parse (locale-warning line, syscall
    // error, etc.). Warn the operator so the probe's silence is visible,
    // then treat as free — refusing to start on a parse glitch would be
    // worse than letting bind surface the conflict.
    console.warn(`[port-probe] could not parse lsof output for port ${port}: ${JSON.stringify(firstLine)}; assuming free`);
    return { free: true };
  }
  return { free: false, holderPid: pid };
}

/**
 * Try `preferred`, then each `fallbacks` port in order. Returns the first free
 * port. Throws if all are occupied — caller decides how to surface that.
 */
export function findFreePort(
  preferred: number,
  fallbacks: number[],
): { port: number; collisions: Array<{ port: number; holderPid: number }> } {
  const collisions: Array<{ port: number; holderPid: number }> = [];
  const candidates = [preferred, ...fallbacks];
  for (const p of candidates) {
    const result = probePort(p);
    if (result.free) return { port: p, collisions };
    collisions.push({ port: p, holderPid: result.holderPid });
  }
  throw new Error(
    `All candidate ports occupied: ${candidates.join(', ')}. ` +
    `Holders: ${collisions.map((c) => `${c.port}=PID${c.holderPid}`).join(', ')}`,
  );
}
