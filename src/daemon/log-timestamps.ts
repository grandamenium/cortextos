/**
 * Timestamped console for the daemon process.
 *
 * Every daemon log line (console.log/warn/error across index.ts, fast-checker,
 * agent-manager, etc.) gets an ISO-8601 UTC prefix so stall/incident windows can
 * be reconstructed from the out-log alone, without cross-referencing pmset or
 * bus stores. Installed once at daemon startup; idempotent.
 */

const INSTALLED = Symbol.for('cortextos.timestampedConsole');

type ConsoleMethod = 'log' | 'warn' | 'error';

/**
 * Wrap console.log/warn/error to prefix each call with an ISO UTC timestamp.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function installTimestampedConsole(): void {
  const g = globalThis as Record<PropertyKey, unknown>;
  if (g[INSTALLED]) return;
  g[INSTALLED] = true;

  const methods: ConsoleMethod[] = ['log', 'warn', 'error'];
  for (const m of methods) {
    const original = console[m].bind(console);
    console[m] = (...args: unknown[]) => {
      original(`[${new Date().toISOString()}]`, ...args);
    };
  }
}
