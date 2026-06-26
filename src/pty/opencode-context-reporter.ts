import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { AgentConfig } from '../types/index.js';
import { atomicWriteSync } from '../utils/atomic.js';

interface SessionRow {
  id?: unknown;
  model?: unknown;
}

interface TokenRow {
  total?: unknown;
  input?: unknown;
  output?: unknown;
  reasoning?: unknown;
  cache_read?: unknown;
  cache_write?: unknown;
  time_created?: unknown;
}

interface ModelRef {
  providerID?: unknown;
  id?: unknown;
}

interface ReporterOptions {
  stateDir: string;
  agentDir: string;
  workingDir: string;
  opencodeStateRoot: string;
  config: AgentConfig;
  startedAtMs?: number;
}

export class OpencodeContextReporter {
  private readonly stateDir: string;
  private readonly agentDir: string;
  private readonly workingDir: string;
  private readonly opencodeStateRoot: string;
  private readonly config: AgentConfig;
  private readonly startedAtMs: number;
  private lastStepKey: string | null = null;

  constructor(options: ReporterOptions) {
    this.stateDir = options.stateDir;
    this.agentDir = options.agentDir;
    this.workingDir = options.workingDir;
    this.opencodeStateRoot = options.opencodeStateRoot;
    this.config = options.config;
    this.startedAtMs = options.startedAtMs ?? Date.now();
  }

  resetContextStatus(sessionId = `opencode-fresh-${this.startedAtMs}`): boolean {
    this.lastStepKey = null;
    return this.writeNeutralStatus(sessionId);
  }

  reportOnce(): boolean {
    try {
      const dbPath = this.dbPath();
      if (!existsSync(dbPath)) return false;

      const session = this.findSession(dbPath);
      if (!session?.id || typeof session.id !== 'string') return false;

      const tokens = this.findLatestTokens(dbPath, session.id);
      const totalTokens = asNumber(tokens?.total);
      if (!tokens || totalTokens === null) {
        return this.writeNeutralStatus(session.id);
      }

      const cap = this.resolveContextCap(session);
      if (cap === null || cap <= 0) return false;

      const stepKey = `${session.id}:${tokens.time_created ?? ''}:${totalTokens}`;
      if (stepKey === this.lastStepKey) return false;
      this.lastStepKey = stepKey;

      const payload = JSON.stringify({
        used_percentage: Math.min(100, (totalTokens / cap) * 100),
        context_window_size: cap,
        exceeds_200k_tokens: totalTokens > 200000,
        current_usage: {
          input_tokens: asNumber(tokens.input) ?? 0,
          output_tokens: asNumber(tokens.output) ?? 0,
          cache_read_input_tokens: asNumber(tokens.cache_read) ?? 0,
          cache_creation_input_tokens: asNumber(tokens.cache_write) ?? 0,
        },
        session_id: session.id,
        written_at: new Date().toISOString(),
      });

      atomicWriteSync(join(this.stateDir, 'context_status.json'), payload);
      return true;
    } catch {
      return false;
    }
  }

  private dbPath(): string {
    return join(this.opencodeStateRoot, 'data', 'opencode', 'opencode.db');
  }

  private findSession(dbPath: string): SessionRow | null {
    const byWorkingDir = this.queryRows<SessionRow>(
      dbPath,
      `select id, model from session
       where directory = ${sqlString(this.workingDir)}
         and time_updated >= ${this.startedAtMs}
       order by time_updated desc
       limit 1;`,
    )[0];
    if (byWorkingDir) return byWorkingDir;

    const byAgentDir = this.workingDir === this.agentDir
      ? null
      : this.queryRows<SessionRow>(
        dbPath,
        `select id, model from session
         where directory = ${sqlString(this.agentDir)}
           and time_updated >= ${this.startedAtMs}
         order by time_updated desc
         limit 1;`,
      )[0];
    if (byAgentDir) return byAgentDir;

    return this.queryRows<SessionRow>(
      dbPath,
      `select id, model from session
       where time_updated >= ${this.startedAtMs}
       order by time_updated desc
       limit 1;`,
    )[0] ?? null;
  }

  private findLatestTokens(dbPath: string, sessionId: string): TokenRow | null {
    const quotedSession = sqlString(sessionId);
    const fromPart = this.queryRows<TokenRow>(
      dbPath,
      `select json_extract(data,'$.tokens.total') as total,
              json_extract(data,'$.tokens.input') as input,
              json_extract(data,'$.tokens.output') as output,
              json_extract(data,'$.tokens.reasoning') as reasoning,
              json_extract(data,'$.tokens.cache.read') as cache_read,
              json_extract(data,'$.tokens.cache.write') as cache_write,
              time_created
       from part
       where session_id = ${quotedSession}
         and json_extract(data,'$.type') = 'step-finish'
       order by time_created desc
       limit 1;`,
    )[0];
    if (fromPart) return fromPart;

    return this.queryRows<TokenRow>(
      dbPath,
      `select json_extract(data,'$.tokens.total') as total,
              json_extract(data,'$.tokens.input') as input,
              json_extract(data,'$.tokens.output') as output,
              json_extract(data,'$.tokens.reasoning') as reasoning,
              json_extract(data,'$.tokens.cache.read') as cache_read,
              json_extract(data,'$.tokens.cache.write') as cache_write,
              time_created
       from message
       where session_id = ${quotedSession}
         and json_extract(data,'$.tokens.total') is not null
       order by time_created desc
       limit 1;`,
    )[0] ?? null;
  }

  private resolveContextCap(session: SessionRow): number | null {
    const fromModelCache = this.resolveModelCap(session.model);
    if (fromModelCache !== null) return fromModelCache;
    return this.config.opencode_context_cap ?? null;
  }

  private writeNeutralStatus(sessionId: string): boolean {
    const stepKey = `${sessionId}:no-tokens`;
    if (stepKey === this.lastStepKey) return false;
    this.lastStepKey = stepKey;
    const payload = JSON.stringify({
      used_percentage: 0,
      context_window_size: this.config.opencode_context_cap ?? null,
      exceeds_200k_tokens: false,
      current_usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      session_id: sessionId,
      written_at: new Date().toISOString(),
    });
    try {
      atomicWriteSync(join(this.stateDir, 'context_status.json'), payload);
      return true;
    } catch {
      return false;
    }
  }

  private resolveModelCap(modelRaw: unknown): number | null {
    if (typeof modelRaw !== 'string' || !modelRaw.trim()) return null;

    let model: ModelRef;
    try {
      model = JSON.parse(modelRaw) as ModelRef;
    } catch {
      return null;
    }

    if (typeof model.providerID !== 'string' || typeof model.id !== 'string') return null;

    const modelsPath = join(this.opencodeStateRoot, 'cache', 'opencode', 'models.json');
    if (!existsSync(modelsPath)) return null;

    try {
      const parsed = JSON.parse(readFileSync(modelsPath, 'utf-8')) as unknown;
      if (!isRecord(parsed)) return null;
      const provider = parsed[model.providerID];
      if (!isRecord(provider)) return null;
      const models = provider.models;
      if (!isRecord(models)) return null;
      const entry = models[model.id];
      if (!isRecord(entry)) return null;
      const limit = entry.limit;
      if (!isRecord(limit)) return null;
      return asNumber(limit.context);
    } catch {
      return null;
    }
  }

  private queryRows<T>(dbPath: string, sql: string): T[] {
    const output = execFileSync('sqlite3', ['-readonly', '-json', dbPath, sql], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    });
    const trimmed = output.trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed) as unknown;
    return Array.isArray(parsed) ? parsed as T[] : [];
  }
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
