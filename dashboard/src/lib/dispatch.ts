import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import { jwtVerify } from 'jose';
import { getRecentEvents } from '@/lib/data/events';
import type { Event } from '@/lib/types';

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

interface PullRequestPayload {
  number: number;
  title: string;
  headRefName: string;
  updatedAt: string;
}

interface RecentDispatchMeta {
  to?: string;
  msg_id?: string;
  reply_to?: string | null;
  priority?: string;
  text?: string;
}

export interface PullRequestSummary {
  number: number;
  title: string;
  headRefName: string;
  updatedAt: string;
  url: string;
}

export interface RecentDispatch {
  id: string;
  agent: string;
  timestamp: string;
  title: string;
  status: 'sent' | 'queued';
}

interface TokenBucketState {
  tokens: number;
  lastRefillAt: number;
}

const execFileAsync = promisify(execFile);

const PR_CACHE_TTL_MS = 60_000;
const RECENT_DISPATCH_LIMIT = 3;

const prCache = new Map<string, CacheEntry<PullRequestSummary[]>>();
const dispatchBuckets = new Map<string, TokenBucketState>();

function getCached<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function setCached<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, ttlMs: number): T {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

export function getRecentPRs(): PullRequestSummary[] {
  const cacheKey = 'clearworks-ai/cortextos';
  const cached = getCached(prCache, cacheKey);
  if (cached) return cached;

  console.error('[cache-miss] getRecentPRs');
  try {
    const stdout = execFileSync(
      'gh',
      ['pr', 'list', '--repo', 'clearworks-ai/cortextos', '--state', 'open', '--json', 'number,title,headRefName,updatedAt'],
      { encoding: 'utf-8', timeout: 100 },
    );
    const parsed = JSON.parse(stdout) as PullRequestPayload[];
    const pulls = parsed.map((pr) => ({
      number: pr.number,
      title: pr.title,
      headRefName: pr.headRefName,
      updatedAt: pr.updatedAt,
      url: `https://github.com/clearworks-ai/cortextos/pull/${pr.number}`,
    }));
    return setCached(prCache, cacheKey, pulls, PR_CACHE_TTL_MS);
  } catch {
    return setCached(prCache, cacheKey, [], PR_CACHE_TTL_MS);
  }
}

function coerceDispatchMeta(event: Event): RecentDispatchMeta {
  const data = event.data;
  if (!data) return {};
  return {
    to: typeof data.to === 'string' ? data.to : undefined,
    msg_id: typeof data.msg_id === 'string' ? data.msg_id : undefined,
    reply_to: typeof data.reply_to === 'string' || data.reply_to === null ? data.reply_to : undefined,
    priority: typeof data.priority === 'string' ? data.priority : undefined,
    text: typeof data.text === 'string' ? data.text : undefined,
  };
}

export function getRecentDispatches(org: string): RecentDispatch[] {
  return getRecentEvents(50, org)
    .filter((event) => event.type === 'message' || event.category === 'message')
    .map((event) => {
      const meta = coerceDispatchMeta(event);
      return {
        id: event.id,
        agent: meta.to ?? event.agent,
        timestamp: event.timestamp,
        title: meta.text ?? event.message ?? event.category,
        status: 'sent' as const,
      };
    })
    .slice(0, RECENT_DISPATCH_LIMIT);
}

export async function dispatchMessage(agent: string, text: string): Promise<{ ok: true; messageId: string }> {
  const { stdout } = await execFileAsync(
    'cortextos',
    ['bus', 'send-message', agent, 'normal', text],
    { timeout: 5_000 },
  );

  const messageId = stdout.trim();
  try {
    await execFileAsync(
      'cortextos',
      ['bus', 'log-event', 'message', 'message_sent', 'info', '--meta', JSON.stringify({ to: agent, text, msg_id: messageId })],
      { timeout: 5_000 },
    );
  } catch {
    // Best effort only — dispatch already succeeded.
  }

  return { ok: true, messageId };
}

export function checkDispatchRateLimit(subject: string): { allowed: boolean; retryAfterSeconds?: number } {
  const now = Date.now();
  const previous = dispatchBuckets.get(subject) ?? { tokens: 1, lastRefillAt: now };
  const elapsedSeconds = (now - previous.lastRefillAt) / 1_000;
  const refilled = Math.min(1, previous.tokens + elapsedSeconds);

  if (refilled < 1) {
    dispatchBuckets.set(subject, { tokens: refilled, lastRefillAt: now });
    return { allowed: false, retryAfterSeconds: 1 };
  }

  dispatchBuckets.set(subject, { tokens: refilled - 1, lastRefillAt: now });
  return { allowed: true };
}

export async function extractJwtSubject(authorizationHeader: string | null): Promise<string | null> {
  if (!authorizationHeader?.startsWith('Bearer ')) return null;
  const token = authorizationHeader.slice(7);
  if (!token) return null;

  const secretValue = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secretValue) return null;

  try {
    const secret = new TextEncoder().encode(secretValue);
    const { payload } = await jwtVerify(token, secret);
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}
