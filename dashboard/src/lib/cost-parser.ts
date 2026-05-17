// cortextOS Dashboard - Cost parser
// Parses ~/.claude/projects/*.jsonl AND <ctxRoot>/logs/<agent>/codex-tokens.jsonl
// for token usage and calculates cost.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { sql } from '@/lib/db';
import { CTX_ROOT, getAgentsForOrg, getAllAgents, getOrgs } from '@/lib/config';
import type { CostEntry } from '@/lib/types';

// -- Pricing per million tokens --

interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheWritePerMillion: number;
  cacheReadPerMillion: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  opus: { inputPerMillion: 15, outputPerMillion: 75, cacheWritePerMillion: 3.75, cacheReadPerMillion: 1.50 },
  sonnet: { inputPerMillion: 3, outputPerMillion: 15, cacheWritePerMillion: 3.75, cacheReadPerMillion: 0.30 },
  haiku: { inputPerMillion: 0.8, outputPerMillion: 4, cacheWritePerMillion: 1.00, cacheReadPerMillion: 0.08 },
  // gpt-5-codex: OpenAI list pricing as of 2026-01. cache write n/a (no separate
  // write cost on cached input). Update when codex pricing changes upstream.
  'gpt-5-codex': { inputPerMillion: 1.25, outputPerMillion: 10, cacheWritePerMillion: 0, cacheReadPerMillion: 0.125 },
};

/**
 * Resolve model name to pricing key. Matches substrings: claude variants map to
 * opus/sonnet/haiku; gpt-5-codex (and bare "codex" / "gpt-5" variants) map to
 * gpt-5-codex pricing rather than silently defaulting to sonnet.
 */
function resolvePricingKey(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('haiku')) return 'haiku';
  if (lower.includes('codex') || lower.includes('gpt-5')) return 'gpt-5-codex';
  // Default to sonnet for all other claude models
  return 'sonnet';
}

/**
 * Calculate USD cost for a single entry, including cache token pricing.
 */
export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheWriteTokens: number = 0,
  cacheReadTokens: number = 0,
): number {
  const key = resolvePricingKey(model);
  const pricing = MODEL_PRICING[key] ?? MODEL_PRICING.sonnet;
  const inputCost = (inputTokens / 1_000_000) * pricing.inputPerMillion;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPerMillion;
  const cacheWriteCost = (cacheWriteTokens / 1_000_000) * pricing.cacheWritePerMillion;
  const cacheReadCost = (cacheReadTokens / 1_000_000) * pricing.cacheReadPerMillion;
  return Math.round((inputCost + outputCost + cacheWriteCost + cacheReadCost) * 1_000_000) / 1_000_000;
}

// ---------------------------------------------------------------------------
// JSONL parsing
// ---------------------------------------------------------------------------

interface RawTokenEntry {
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  timestamp?: string;
  costUSD?: number;
}

/**
 * Parse a single JSONL file and return cost entries.
 */
function parseJsonlFile(filePath: string, agent: string, org: string): CostEntry[] {
  const entries: CostEntry[] = [];

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const lines = content.split('\n').filter((l) => l.trim());

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      // Claude Code JSONL nests data in .message, plain JSONL has it at top level
      const raw: RawTokenEntry = parsed.message ?? parsed;
      const model = raw.model;
      if (!model) continue;

      const inputTokens = raw.input_tokens ?? raw.usage?.input_tokens ?? 0;
      const outputTokens = raw.output_tokens ?? raw.usage?.output_tokens ?? 0;
      const cacheWriteTokens = raw.usage?.cache_creation_input_tokens ?? 0;
      const cacheReadTokens = raw.usage?.cache_read_input_tokens ?? 0;
      if (inputTokens === 0 && outputTokens === 0 && cacheWriteTokens === 0 && cacheReadTokens === 0) continue;

      const totalTokens = inputTokens + outputTokens + cacheWriteTokens + cacheReadTokens;
      const costUsd = raw.costUSD ?? calculateCost(model, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens);
      const timestamp = parsed.timestamp ?? raw.timestamp ?? new Date().toISOString();

      entries.push({
        timestamp,
        agent,
        org,
        model,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: totalTokens,
        cost_usd: costUsd,
        source_file: filePath,
      });
    } catch {
      // Skip malformed lines
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Directory scanning
// ---------------------------------------------------------------------------

/**
 * Scan ~/.claude/projects/ for JSONL files and parse them.
 * Scoped to the current instance's orgs to prevent cross-instance data bleed.
 */
export function scanClaudeProjectsCosts(): CostEntry[] {
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(claudeDir)) return [];

  const allowedOrgs = new Set(getOrgs());

  // Also allow the instance ID itself as a fallback org label
  const instanceId = process.env.CTX_INSTANCE_ID ?? 'default';
  allowedOrgs.add(instanceId);

  const allEntries: CostEntry[] = [];

  try {
    const projectDirs = fs.readdirSync(claudeDir, { withFileTypes: true });

    for (const dir of projectDirs) {
      if (!dir.isDirectory()) continue;
      // Only scan directories that contain 'agents' in the path (skip unrelated projects)
      if (!dir.name.includes('agents')) continue;

      const parts = dir.name.split('-');
      const orgsIdx = parts.indexOf('orgs');
      const orgName = orgsIdx >= 0 && orgsIdx < parts.length - 1
        ? parts[orgsIdx + 1]
        : 'default';

      // Scope to current instance's orgs — prevent cross-instance bleed
      if (!allowedOrgs.has(orgName)) continue;

      const projectPath = path.join(claudeDir, dir.name);
      const files = fs.readdirSync(projectPath).filter((f) => f.endsWith('.jsonl'));

      for (const file of files) {
        const filePath = path.join(projectPath, file);
        // Extract agent name from encoded dir path (e.g. "-Users-...-agents-devbot" -> "devbot")
        const agentsIdx = parts.lastIndexOf('agents');
        const agentName = agentsIdx >= 0 && agentsIdx < parts.length - 1
          ? parts.slice(agentsIdx + 1).join('-')
          : dir.name;
        const entries = parseJsonlFile(filePath, agentName, orgName);
        allEntries.push(...entries);
      }
    }
  } catch {
    // Directory scan failed
  }

  return allEntries;
}

// ---------------------------------------------------------------------------
// Codex JSONL scanning
// ---------------------------------------------------------------------------

interface CodexTokenEntry {
  timestamp?: string;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  session_id?: string;
  turn_id?: string;
}

function parseCodexJsonlFile(filePath: string, agent: string, org: string): CostEntry[] {
  const entries: CostEntry[] = [];
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const lines = content.split('\n').filter((l) => l.trim());
  for (const line of lines) {
    try {
      const raw = JSON.parse(line) as CodexTokenEntry;
      const model = raw.model;
      if (!model) continue;

      const inputTokens = raw.input_tokens ?? 0;
      const outputTokens = raw.output_tokens ?? 0;
      const cacheReadTokens = raw.cache_read_tokens ?? 0;
      const cacheWriteTokens = raw.cache_write_tokens ?? 0;
      if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheWriteTokens === 0) continue;

      const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
      const costUsd = calculateCost(model, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens);
      const timestamp = raw.timestamp ?? new Date().toISOString();

      entries.push({
        timestamp,
        agent,
        org,
        model,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: totalTokens,
        cost_usd: costUsd,
        source_file: filePath,
      });
    } catch {
      // Skip malformed lines
    }
  }

  return entries;
}

export function scanCodexLogsCosts(): CostEntry[] {
  const allEntries: CostEntry[] = [];

  const pairs: Array<{ name: string; org: string }> = getAllAgents();
  if (pairs.length === 0) {
    for (const org of getOrgs()) {
      for (const name of getAgentsForOrg(org)) pairs.push({ name, org });
    }
  }

  for (const { name, org } of pairs) {
    const filePath = path.join(CTX_ROOT, 'logs', name, 'codex-tokens.jsonl');
    if (!fs.existsSync(filePath)) continue;
    allEntries.push(...parseCodexJsonlFile(filePath, name, org));
  }

  return allEntries;
}

// ---------------------------------------------------------------------------
// Postgres persistence
// ---------------------------------------------------------------------------

export async function persistCostEntries(entries: CostEntry[]): Promise<number> {
  let inserted = 0;
  for (const e of entries) {
    try {
      const result = await sql`
        INSERT INTO cost_entries (timestamp, agent, org, model, input_tokens, output_tokens, total_tokens, cost_usd, source_file)
        VALUES (${e.timestamp}, ${e.agent}, ${e.org}, ${e.model}, ${e.input_tokens}, ${e.output_tokens}, ${e.total_tokens}, ${e.cost_usd}, ${e.source_file ?? null})
        ON CONFLICT DO NOTHING
      `;
      if (result.count > 0) inserted++;
    } catch {
      // skip individual insert errors
    }
  }
  return inserted;
}

export async function syncCosts(): Promise<{ scanned: number; inserted: number }> {
  const claudeEntries = scanClaudeProjectsCosts();
  const codexEntries = scanCodexLogsCosts();

  const seen = new Set<string>();
  const merged: CostEntry[] = [];
  for (const entry of [...claudeEntries, ...codexEntries]) {
    const key = `${entry.source_file ?? ''}|${entry.timestamp}|${entry.model}|${entry.agent}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }

  const inserted = merged.length > 0 ? await persistCostEntries(merged) : 0;
  return { scanned: merged.length, inserted };
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

export async function getCostEntries(limit = 100, org?: string): Promise<CostEntry[]> {
  try {
    return await sql<CostEntry[]>`
      SELECT id, timestamp, agent, org, model, input_tokens, output_tokens, total_tokens, cost_usd, source_file
      FROM cost_entries
      WHERE TRUE
      ${org ? sql`AND org = ${org}` : sql``}
      ORDER BY timestamp DESC
      LIMIT ${limit}
    `;
  } catch {
    return [];
  }
}

export async function getDailyCosts(days = 30): Promise<Array<{ date: string; cost: number }>> {
  const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10);
  try {
    const rows = await sql<{ date: string; cost: string }[]>`
      SELECT LEFT(timestamp, 10) as date, SUM(cost_usd) as cost
      FROM cost_entries
      WHERE timestamp >= ${cutoff}
      GROUP BY LEFT(timestamp, 10)
      ORDER BY date ASC
    `;
    return rows.map((r) => ({ date: r.date, cost: Number(r.cost) }));
  } catch {
    return [];
  }
}

export async function getCostByModel(): Promise<Array<{ model: string; cost: number; tokens: number }>> {
  try {
    const rows = await sql<{ model: string; cost: string; tokens: string }[]>`
      SELECT model, SUM(cost_usd) as cost, SUM(total_tokens) as tokens
      FROM cost_entries
      GROUP BY model
      ORDER BY cost DESC
    `;
    return rows.map((r) => ({ model: r.model, cost: Number(r.cost), tokens: Number(r.tokens) }));
  } catch {
    return [];
  }
}

export async function getDailyCostByModel(days = 30): Promise<Array<Record<string, unknown>>> {
  const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10);
  try {
    const rows = await sql<{ date: string; model: string; cost: string }[]>`
      SELECT LEFT(timestamp, 10) as date, model, SUM(cost_usd) as cost
      FROM cost_entries
      WHERE timestamp >= ${cutoff}
      GROUP BY LEFT(timestamp, 10), model
      ORDER BY date ASC
    `;

    const dateMap = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      if (!dateMap.has(row.date)) dateMap.set(row.date, { date: row.date });
      const entry = dateMap.get(row.date)!;
      const key = resolvePricingKey(row.model);
      entry[key] = ((entry[key] as number) ?? 0) + Number(row.cost);
    }
    return Array.from(dateMap.values());
  } catch {
    return [];
  }
}

export async function getCurrentMonthCost(): Promise<number> {
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  try {
    const [row] = await sql<{ total: string | null }[]>`
      SELECT SUM(cost_usd) as total
      FROM cost_entries
      WHERE timestamp >= ${monthStart.toISOString()}
    `;
    return Number(row?.total ?? 0);
  } catch {
    return 0;
  }
}
