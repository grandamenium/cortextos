/**
 * Brand detection for the AscendOps white-label distribution.
 *
 * When ASCENDOPS_BRAND=1 is set in the agent's .env (loaded by the daemon
 * before spawning Claude Code), the CLI and dashboard display AscendOps
 * branding instead of the default cortextos branding.
 *
 * The core engine is untouched — this is purely a presentation layer.
 */

export type Brand = 'ascendops' | 'cortextos';

/**
 * Return the active brand based on the ASCENDOPS_BRAND environment variable.
 * Defaults to 'cortextos' when the variable is absent or not "1".
 */
export function activeBrand(): Brand {
  return process.env.ASCENDOPS_BRAND === '1' ? 'ascendops' : 'cortextos';
}

/**
 * Return the display name for the active brand.
 */
export function brandName(): string {
  return activeBrand() === 'ascendops' ? 'AscendOps' : 'cortextOS';
}

/**
 * Return the CLI command name for the active brand.
 */
export function brandCommand(): string {
  return activeBrand() === 'ascendops' ? 'ascendops' : 'cortextos';
}
