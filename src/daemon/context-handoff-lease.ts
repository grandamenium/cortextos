import { existsSync, readFileSync } from 'fs';
import { createHash, randomUUID } from 'crypto';
import { join } from 'path';
import { atomicWriteSync } from '../utils/atomic.js';

const DEFAULT_MAX_CONCURRENT = 2;
const LEASE_TTL_MS = 10 * 60_000;
const QUEUE_TTL_MS = 30 * 60_000;
const QUEUE_STAGGER_MS = 15_000;
const QUEUE_JITTER_MS = 15_000;

interface HandoffLeaseEntry {
  agent: string;
  lease_id: string;
  acquired_at: number;
  expires_at: number;
}

interface HandoffQueueEntry {
  agent: string;
  requested_at: number;
  not_before: number;
}

interface HandoffLeaseState {
  version: 1;
  updated_at: string;
  active: HandoffLeaseEntry[];
  queue: HandoffQueueEntry[];
}

export type HandoffLeaseDecision =
  | { status: 'acquired'; leaseId: string; activeCount: number; queuedCount: number }
  | { status: 'queued'; position: number; waitMs: number; activeCount: number; queuedCount: number };

export interface HandoffLeaseOptions {
  ctxRoot: string;
  agentName: string;
  now?: number;
  maxConcurrent?: number;
}

export function contextHandoffLeasePath(ctxRoot: string): string {
  return join(ctxRoot, 'state', 'context-handoff-leases.json');
}

export function requestContextHandoffLease(options: HandoffLeaseOptions): HandoffLeaseDecision {
  const now = options.now ?? Date.now();
  const maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const statePath = contextHandoffLeasePath(options.ctxRoot);
  const state = readLeaseState(statePath, now);

  const existingActive = state.active.find((entry) => entry.agent === options.agentName);
  if (existingActive) {
    writeLeaseState(statePath, state);
    return {
      status: 'acquired',
      leaseId: existingActive.lease_id,
      activeCount: state.active.length,
      queuedCount: state.queue.length,
    };
  }

  const existingQueued = state.queue.find((entry) => entry.agent === options.agentName);
  if (!existingQueued && state.active.length >= maxConcurrent) {
    state.queue.push({
      agent: options.agentName,
      requested_at: now,
      not_before: now + (state.queue.length + 1) * QUEUE_STAGGER_MS + deterministicJitter(options.agentName),
    });
  }

  const queueIndex = state.queue.findIndex((entry) => entry.agent === options.agentName);
  const canAcquireDirectly = state.queue.length === 0 && state.active.length < maxConcurrent;
  const canAcquireFromQueue = queueIndex === 0
    && state.active.length < maxConcurrent
    && state.queue[0].not_before <= now;

  if (canAcquireDirectly || canAcquireFromQueue) {
    if (canAcquireFromQueue) state.queue.shift();
    const leaseId = randomUUID();
    state.active.push({
      agent: options.agentName,
      lease_id: leaseId,
      acquired_at: now,
      expires_at: now + LEASE_TTL_MS,
    });
    writeLeaseState(statePath, state);
    return {
      status: 'acquired',
      leaseId,
      activeCount: state.active.length,
      queuedCount: state.queue.length,
    };
  }

  const queued = state.queue.find((entry) => entry.agent === options.agentName)
    ?? existingQueued
    ?? {
      agent: options.agentName,
      requested_at: now,
      not_before: now + QUEUE_STAGGER_MS + deterministicJitter(options.agentName),
    };
  if (!state.queue.some((entry) => entry.agent === options.agentName)) {
    state.queue.push(queued);
  }
  const position = state.queue.findIndex((entry) => entry.agent === options.agentName) + 1;
  writeLeaseState(statePath, state);
  return {
    status: 'queued',
    position,
    waitMs: Math.max(0, queued.not_before - now),
    activeCount: state.active.length,
    queuedCount: state.queue.length,
  };
}

export function releaseContextHandoffLease(ctxRoot: string, agentName: string, leaseId?: string): void {
  const statePath = contextHandoffLeasePath(ctxRoot);
  const state = readLeaseState(statePath, Date.now());
  state.active = state.active.filter((entry) =>
    entry.agent !== agentName || (leaseId !== undefined && entry.lease_id !== leaseId));
  state.queue = state.queue.filter((entry) => entry.agent !== agentName);
  writeLeaseState(statePath, state);
}

/**
 * Read-only check: does this agent currently hold an active lease or a queue entry?
 * Lets a caller decide whether a release-by-name is actually needed without paying the
 * lease-file write that releaseContextHandoffLease always incurs — so a per-tick caller
 * can stay read-only in the common (no stale lease) case. Expired/stale entries are
 * filtered by readLeaseState, so this reflects only live holdings.
 */
export function agentHoldsContextHandoffLease(ctxRoot: string, agentName: string, now: number = Date.now()): boolean {
  const state = readLeaseState(contextHandoffLeasePath(ctxRoot), now);
  return state.active.some((entry) => entry.agent === agentName)
    || state.queue.some((entry) => entry.agent === agentName);
}

function readLeaseState(statePath: string, now: number): HandoffLeaseState {
  let state: HandoffLeaseState = {
    version: 1,
    updated_at: new Date(now).toISOString(),
    active: [],
    queue: [],
  };
  try {
    if (existsSync(statePath)) {
      const parsed = JSON.parse(readFileSync(statePath, 'utf-8')) as Partial<HandoffLeaseState>;
      state = {
        version: 1,
        updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : new Date(now).toISOString(),
        active: Array.isArray(parsed.active) ? parsed.active.filter(isLeaseEntry) : [],
        queue: Array.isArray(parsed.queue) ? parsed.queue.filter(isQueueEntry) : [],
      };
    }
  } catch {
    state = {
      version: 1,
      updated_at: new Date(now).toISOString(),
      active: [],
      queue: [],
    };
  }

  state.active = state.active.filter((entry) => entry.expires_at > now);
  state.queue = state.queue.filter((entry) => now - entry.requested_at <= QUEUE_TTL_MS);
  state.updated_at = new Date(now).toISOString();
  return state;
}

function writeLeaseState(statePath: string, state: HandoffLeaseState): void {
  // Atomic write (temp file + rename) so a concurrent reader never observes a torn or
  // partial lease file — this fleet state is read by every agent's FastChecker on each
  // tick. atomicWriteSync handles directory creation and appends the trailing newline.
  atomicWriteSync(statePath, JSON.stringify(state, null, 2));
}

function deterministicJitter(agentName: string): number {
  const hex = createHash('sha256').update(agentName).digest('hex').slice(0, 8);
  return parseInt(hex, 16) % QUEUE_JITTER_MS;
}

function isLeaseEntry(value: unknown): value is HandoffLeaseEntry {
  if (!isRecord(value)) return false;
  return typeof value.agent === 'string'
    && typeof value.lease_id === 'string'
    && typeof value.acquired_at === 'number'
    && typeof value.expires_at === 'number';
}

function isQueueEntry(value: unknown): value is HandoffQueueEntry {
  if (!isRecord(value)) return false;
  return typeof value.agent === 'string'
    && typeof value.requested_at === 'number'
    && typeof value.not_before === 'number';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
