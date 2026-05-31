import { existsSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import { join } from 'path';

/**
 * Scoped secret writers for the add-org --pack installer (F5).
 *
 * cortextOS has two secret scopes (Phase-0 inventory + Phase-1 spec §3.6):
 *   - ORG scope    -> orgs/<org>/secrets.env        (shared keys, e.g. GEMINI_API_KEY)
 *   - AGENT scope  -> orgs/<org>/agents/<name>/.env  (per-agent Telegram creds)
 * `init`/`add-agent` already lay down placeholder files (KEY= with no value) and
 * chmod them 0600. The installer collects real values from the wizard and fills
 * those placeholders. These helpers do an upsert that fills/replaces the given
 * keys while preserving every other line (comments, untouched keys), then
 * re-chmod 0600 — so secrets are never world-readable.
 */

const ENV_KEY_RE = /^([A-Za-z_][A-Za-z0-9_]*)=/;

/**
 * Upsert KEY=value pairs into an env-style file, preserving comments and any
 * lines/keys the caller did not provide. Creates the file if missing. Always
 * chmod 0600 (owner read/write only — these hold credentials).
 */
export function upsertEnvFile(filePath: string, values: Record<string, string>): void {
  const remaining = new Set(Object.keys(values));
  const lines = existsSync(filePath)
    ? readFileSync(filePath, 'utf-8').split('\n')
    : [];

  const out = lines.map((line) => {
    const m = line.match(ENV_KEY_RE);
    if (m && remaining.has(m[1])) {
      remaining.delete(m[1]);
      return `${m[1]}=${values[m[1]]}`;
    }
    return line;
  });

  // Append any keys that weren't already present as placeholders.
  if (remaining.size > 0) {
    // Keep a trailing newline tidy: drop a single empty last line before appending.
    if (out.length > 0 && out[out.length - 1] === '') out.pop();
    for (const key of remaining) out.push(`${key}=${values[key]}`);
    out.push('');
  }

  writeFileSync(filePath, out.join('\n'), 'utf-8');
  chmodSync(filePath, 0o600);
}

/**
 * Write ORG-scoped secrets into orgs/<org>/secrets.env (0600). For shared keys
 * such as GEMINI_API_KEY, ACTIVITY_CHAT_ID, integration credentials.
 */
export function writeOrgSecrets(orgDir: string, secrets: Record<string, string>): void {
  upsertEnvFile(join(orgDir, 'secrets.env'), secrets);
}

/**
 * Write AGENT-scoped secrets into orgs/<org>/agents/<name>/.env (0600).
 *
 * Telegram credentials are agent-scoped, and the daemon refuses to start
 * Telegram polling when BOT_TOKEN is present without ALLOWED_USER. Enforce that
 * pairing at write time so a half-configured agent never reaches the daemon:
 * if BOT_TOKEN is being set to a non-empty value, ALLOWED_USER must also be
 * provided non-empty (either in this call or already present in the file).
 */
export function writeAgentEnv(agentDir: string, secrets: Record<string, string>): void {
  const envPath = join(agentDir, '.env');

  const settingBotToken = typeof secrets.BOT_TOKEN === 'string' && secrets.BOT_TOKEN.trim() !== '';
  if (settingBotToken) {
    const allowedInCall = typeof secrets.ALLOWED_USER === 'string' && secrets.ALLOWED_USER.trim() !== '';
    const allowedOnDisk = existsSync(envPath)
      && /^ALLOWED_USER=.+/m.test(readFileSync(envPath, 'utf-8'));
    if (!allowedInCall && !allowedOnDisk) {
      throw new Error(
        `writeAgentEnv: setting BOT_TOKEN requires ALLOWED_USER (the daemon refuses Telegram polling without it). Provide ALLOWED_USER for agent at ${agentDir}.`
      );
    }
  }

  upsertEnvFile(envPath, secrets);
}
