// Thin loader for agents.yaml — the cortextOS per-agent capability manifest.
//
// agents.yaml lives at `frameworkRoot/agents.yaml` and declares per-agent
// truths the daemon needs at spawn time:
//   * `telegram_enabled` — does this agent run a Telegram poller? Without
//     this gate, the daemon will faithfully attempt to spawn a poller for
//     any agent whose `.env` happens to carry a BOT_TOKEN (e.g. a copy-paste
//     remnant or a deliberately-disabled-but-not-purged token), causing
//     401/403 retry spam from agents that have no bot by design (forge).
//   * `host` / `org` / `role` — annotation fields used by the structured
//     start-log line so operators can `grep '[agent-manager] Starting agent'`
//     and see role + host at a glance.
//
// Backward compatible: when the file is absent, unreadable, or malformed the
// loader returns null and callers MUST treat that as "no manifest data — do
// what you used to do". Adding agents.yaml is purely additive.
//
// YAML parsing: js-yaml is NOT in package.json (verified via `npm ls js-yaml`
// → empty), and the manifest schema is intentionally simple (one nested
// map of scalars per agent), so we ship a minimal hand-rolled parser
// instead of adding a runtime dep.

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * One agent entry as parsed from `agents.yaml`. All fields are optional so
 * the daemon can degrade gracefully on a partial / older-format manifest.
 */
export interface AgentManifestEntry {
  /** Host slug — `macbook` / `mac_mini`. Used in the start-log annotation. */
  host?: string;
  /** Org slug — `subbu-ops`. Carried for symmetry with enabled-agents.json. */
  org?: string;
  /** Role label — `orchestrator`, `builder`, etc. Used in the start-log line. */
  role?: string;
  /**
   * Authoritative gate for Telegram poller startup. When explicitly false,
   * the daemon MUST NOT spawn a TelegramPoller for this agent regardless of
   * whether its `.env` has a BOT_TOKEN. Absent / true / any non-false value
   * preserves the existing behaviour (poller starts iff credentials exist).
   */
  telegram_enabled?: boolean;
  /** Env-var name holding the bot token. Informational; not consulted here. */
  bot_token_env_var?: string | null;
  /** Env-var name holding the chat id. Informational; not consulted here. */
  chat_id_env_var?: string | null;
  /** Absolute path the manifest claims holds this agent's .env. Informational. */
  env_path?: string;
  /** Whether the manifest entry was verified by inspecting .env / config.json. */
  verified?: boolean;
  /** Free-form operator notes — not consulted by the daemon. */
  notes?: string;
}

/** Parsed `agents.yaml` shape. Only `agents` is consulted at runtime today. */
export interface AgentsManifest {
  agents: Record<string, AgentManifestEntry>;
}

/**
 * Load `agents.yaml` from `frameworkRoot`. Returns null on any failure mode
 * (file missing, unreadable, malformed) so callers can degrade silently.
 *
 * On success the returned object always has an `agents` map even if the file
 * had zero entries — this keeps consumer code branch-free.
 */
export function loadAgentsManifest(frameworkRoot: string): AgentsManifest | null {
  const yamlPath = join(frameworkRoot, 'agents.yaml');
  if (!existsSync(yamlPath)) return null;
  let content: string;
  try {
    content = readFileSync(yamlPath, 'utf-8');
  } catch {
    return null;
  }
  try {
    return parseAgentsYaml(content);
  } catch {
    return null;
  }
}

/**
 * Minimal YAML subset parser targeting the agents.yaml schema:
 *
 *   agents:
 *     <name>:
 *       <key>: <scalar>
 *       <key>: <scalar>
 *     <name>:
 *       <key>: <scalar>
 *
 * Handles:
 *   - 2-space indentation (the file we ship)
 *   - `#` line comments and trailing comments after a scalar
 *   - scalar types: string, int, float, true/false, null, unquoted strings
 *   - single- and double-quoted strings (quotes stripped)
 *
 * Intentionally does NOT handle: multi-line scalars, anchors, flow style,
 * arrays under agent entries, nested maps deeper than 2 levels. The
 * `agents.yaml` manifest stays simple by design — if it ever needs richer
 * YAML, swap to a real parser at that point.
 *
 * Exported for unit testing. Throws on malformed input so `loadAgentsManifest`
 * can convert that to a null return (silent fallback).
 */
export function parseAgentsYaml(content: string): AgentsManifest {
  const lines = content.split('\n');
  const agents: Record<string, AgentManifestEntry> = {};

  let inAgents = false;
  let currentAgent: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // Strip BOM-ish whitespace + trailing CR but preserve leading indent.
    const noCR = raw.replace(/\r$/, '');
    // Skip blank lines.
    if (noCR.trim() === '') continue;
    // Skip pure comment lines.
    if (/^\s*#/.test(noCR)) continue;

    const indentMatch = noCR.match(/^( *)/);
    const indent = indentMatch ? indentMatch[1].length : 0;
    const body = noCR.slice(indent);

    if (indent === 0) {
      // Top-level key — must be of form "key:" or "key: value".
      const m = body.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
      if (!m) {
        // Not a key:value line at top level. The manifest only has key:value
        // top-level entries, so anything else is junk — ignore.
        continue;
      }
      const key = m[1];
      inAgents = key === 'agents';
      currentAgent = null;
      // Top-level scalars (version, generated, hosts:) are not exposed today.
      continue;
    }

    if (!inAgents) continue;

    if (indent === 2) {
      // An agent-name line: `  name:` (value should be empty).
      const m = body.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
      if (!m) continue;
      currentAgent = m[1];
      agents[currentAgent] = {};
      continue;
    }

    if (indent >= 4 && currentAgent) {
      // A field within the current agent's entry: `    key: value`.
      const m = body.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
      if (!m) continue;
      const key = m[1];
      const rawValue = stripTrailingComment(m[2]);
      const value = parseScalar(rawValue);
      // Only assign keys we know about — guards against typos in the file
      // silently inflating the entry shape.
      assignKnownField(agents[currentAgent], key, value);
    }
  }

  return { agents };
}

/**
 * Strip an unquoted `# comment` tail from a scalar value. We only strip if
 * the `#` is preceded by whitespace (matches YAML's actual rule). Values
 * that are quoted strings are not touched here — the parseScalar layer
 * preserves their content as-is.
 */
function stripTrailingComment(s: string): string {
  // Don't strip inside a quoted string. We scan for first ` #` outside quotes.
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && (inSingle || inDouble)) { i++; continue; }
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(s[i - 1]))) {
      return s.slice(0, i).trimEnd();
    }
  }
  return s.trimEnd();
}

/** Convert a YAML scalar text into a typed JS value. */
function parseScalar(raw: string): unknown {
  const t = raw.trim();
  if (t === '' || t === '~' || t === 'null' || t === 'Null' || t === 'NULL') return null;
  if (t === 'true' || t === 'True' || t === 'TRUE') return true;
  if (t === 'false' || t === 'False' || t === 'FALSE') return false;
  // Double-quoted string.
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  // Single-quoted string.
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) {
    return t.slice(1, -1).replace(/''/g, "'");
  }
  // Number (int or float).
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^-?\d+\.\d+$/.test(t)) return parseFloat(t);
  // Unquoted string — return as-is.
  return t;
}

/**
 * Assign one parsed field to an entry, but only if the key is one we recognise.
 * Unknown keys are silently dropped — keeps the public shape stable even if
 * a manifest file evolves ahead of this loader.
 */
function assignKnownField(entry: AgentManifestEntry, key: string, value: unknown): void {
  switch (key) {
    case 'host': if (typeof value === 'string') entry.host = value; break;
    case 'org': if (typeof value === 'string') entry.org = value; break;
    case 'role': if (typeof value === 'string') entry.role = value; break;
    case 'telegram_enabled': if (typeof value === 'boolean') entry.telegram_enabled = value; break;
    case 'bot_token_env_var':
      entry.bot_token_env_var = value === null || typeof value === 'string' ? value : null;
      break;
    case 'chat_id_env_var':
      entry.chat_id_env_var = value === null || typeof value === 'string' ? value : null;
      break;
    case 'env_path': if (typeof value === 'string') entry.env_path = value; break;
    case 'verified': if (typeof value === 'boolean') entry.verified = value; break;
    case 'notes': if (typeof value === 'string') entry.notes = value; break;
    default: /* drop unknown field */ break;
  }
}
