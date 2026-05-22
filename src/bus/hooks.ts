// added 2026-04-29 by collie via dane dispatch — RFC #15 minimal stub; dispatcher wiring pending Aussie/Codex Thu execution
//
// Bus hook framework — registry loader, event matcher, dispatcher stub.
// Schema lives at orgs/<org>/hooks.json. Per RFC #15 §4, this file is the
// in-process surface that fast-checker will eventually call on every logged
// event. Today nothing is wired — loadHookRegistry + matchHooks return data,
// dispatchHook only logs the would-be invocation.

import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { execFile } from 'child_process';
import type { Event, EventCategory, EventSeverity } from '../types/index.js';

// ── Schema types — mirror RFC #15 §4 ─────────────────────────────────────────

export type HandlerType = 'log_event' | 'send_message' | 'bash' | 'webhook';

/**
 * Pattern that an Event must match for a hook to fire.
 * Matching is partial — only the fields present in the pattern are checked.
 * `metadata` keys (when present) require deep equality on the listed keys only.
 */
export interface HookPattern {
  category?: EventCategory;
  type?: string;
  severity?: EventSeverity;
  metadata?: Record<string, unknown>;
}

/**
 * Handler payload. Shape varies by HandlerType but is a flat object at the
 * registry level — the dispatcher narrows by `handler_type` at runtime.
 */
export interface Handler {
  category?: EventCategory;
  type?: string;
  severity?: EventSeverity;
  meta?: Record<string, unknown>;
  to?: string;
  priority?: 'urgent' | 'high' | 'normal' | 'low';
  template?: string;
  command?: string;
  url?: string;
}

export interface HookEntry {
  id: string;
  event_pattern: HookPattern;
  handler_type: HandlerType;
  handler: Handler;
  agent_filter?: string[];
  priority: number;
  enabled: boolean;
  notes?: string;
}

export interface HookRegistry {
  schema_version: string;
  comment?: string;
  hooks: HookEntry[];
}

const EMPTY_REGISTRY: HookRegistry = { schema_version: '0.1', hooks: [] };

// added 2026-04-29 by collie via dane dispatch — Day-2 per-handler wiring: handler-result contract
/**
 * Result a handler can return to influence which bus event the dispatcher emits.
 *
 * - `fire` → handler ran (or implicitly accepts); dispatcher emits `hook_fire`.
 * - `block` → handler refused the action this hook was invoked for; dispatcher emits `hook_block`.
 * - `escalate` → handler bumped severity / re-routed to a higher-priority surface; dispatcher emits `hook_escalate`.
 *
 * `reason` is a short slug intended to slot into the bus event meta `outcome` field.
 * `meta` is merged into the bus event meta, never used to override the dispatcher's own bookkeeping fields.
 */
export interface HandlerResult {
  action: 'fire' | 'block' | 'escalate';
  reason?: string;
  meta?: Record<string, unknown>;
}

/**
 * Synchronous or async handler function. Returns a HandlerResult, or undefined/void
 * for the implicit "fire" default. Throws are caught by the dispatcher and treated
 * as `{action: 'block', reason: 'handler_threw'}` so a buggy handler never breaks the loop.
 */
export type HandlerFn = (
  hook: HookEntry,
  event: Event,
) => Promise<HandlerResult | void | undefined> | HandlerResult | void | undefined;

// added 2026-04-29 by collie via dane dispatch — Day-2 per-handler wiring: in-process handler registry.
// Day-1 stub had a single static `dispatchHook` that always logged-and-fired. Day-2 lets callers
// (Codex Thu / Aussie's Day-3 wiring / future skill-side handlers) register handler implementations
// per HandlerType. If no handler is registered for a hook's handler_type, dispatcher falls back to
// the Day-1 stub behavior (log + emit `hook_fire`). This is backwards-compatible.
const _handlerRegistry: Map<HandlerType, HandlerFn> = new Map();

/**
 * Register a handler function for a given HandlerType. Replaces any existing handler.
 * Returns the previous handler (if any) so callers can chain or restore.
 */
export function registerHandler(type: HandlerType, fn: HandlerFn): HandlerFn | undefined {
  const prev = _handlerRegistry.get(type);
  _handlerRegistry.set(type, fn);
  return prev;
}

/**
 * Remove all registered handlers. Intended for tests + setup-teardown blocks.
 */
export function clearHandlerRegistry(): void {
  _handlerRegistry.clear();
}

/**
 * Look up a registered handler. Internal — exported for tests only.
 */
export function _getRegisteredHandler(type: HandlerType): HandlerFn | undefined {
  return _handlerRegistry.get(type);
}

// ── Registry loading ─────────────────────────────────────────────────────────

/**
 * Read orgs/<org>/hooks.json and return its parsed contents.
 *
 * Per RFC #15 §9 fail-open default: a missing file or malformed JSON returns
 * an empty registry, never throws. The caller is fast-checker, which must
 * never crash on registry errors.
 *
 * @param orgPath Absolute path to the org directory (e.g. /Users/.../orgs/ascendops).
 */
export function loadHookRegistry(orgPath: string): HookRegistry {
  const file = join(orgPath, 'hooks.json');
  if (!existsSync(file)) {
    return EMPTY_REGISTRY;
  }
  try {
    const raw = readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<HookRegistry>;
    if (!parsed || !Array.isArray(parsed.hooks)) {
      logRegistryWarn(orgPath, `hooks.json is missing 'hooks' array`);
      return EMPTY_REGISTRY;
    }
    return {
      schema_version: parsed.schema_version ?? '0.1',
      comment: parsed.comment,
      hooks: parsed.hooks,
    };
  } catch (err) {
    logRegistryWarn(orgPath, `hooks.json parse error: ${(err as Error).message}`);
    return EMPTY_REGISTRY;
  }
}

// ── Event matching ───────────────────────────────────────────────────────────

/**
 * Filter the registry to hooks that should fire for this event.
 *
 * Match rules:
 * - `enabled` must be true.
 * - `agent_filter` empty/missing matches all agents; otherwise must include `agentName`.
 * - `event_pattern.category` (if present) must equal `event.category`.
 * - `event_pattern.type` (if present) must equal `event.event` (note: registry
 *   uses `type` while the Event object uses `event` — bridged here).
 * - `event_pattern.severity` (if present) must equal `event.severity`.
 * - `event_pattern.metadata` (if present) — every key/value must deep-match
 *   `event.metadata` (extra keys on the event are OK).
 *
 * Result is sorted by `priority` descending (highest first).
 */
export function matchHooks(
  registry: HookRegistry,
  event: Event,
  agentName: string,
): HookEntry[] {
  const matched = registry.hooks.filter((hook) => {
    if (!hook.enabled) return false;

    const filter = hook.agent_filter;
    if (filter && filter.length > 0 && !filter.includes(agentName)) return false;

    const pattern = hook.event_pattern;
    if (pattern.category !== undefined && pattern.category !== event.category) return false;
    if (pattern.type !== undefined && pattern.type !== event.event) return false;
    if (pattern.severity !== undefined && pattern.severity !== event.severity) return false;

    if (pattern.metadata) {
      for (const [key, value] of Object.entries(pattern.metadata)) {
        if (!deepEqual(event.metadata?.[key], value)) return false;
      }
    }

    return true;
  });

  return matched.sort((a, b) => b.priority - a.priority);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  const keysA = Object.keys(a as Record<string, unknown>);
  const keysB = Object.keys(b as Record<string, unknown>);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) =>
    deepEqual(
      (a as Record<string, unknown>)[key],
      (b as Record<string, unknown>)[key],
    ),
  );
}

// ── Dispatch (STUB) ──────────────────────────────────────────────────────────

/**
 * Dispatch a matched hook against an event.
 *
 * Day-1 (stub): no handlers registered → logged-and-fired.
 * Day-2 (this commit): handlers may be registered via `registerHandler(type, fn)`.
 *   Their HandlerResult drives which bus event fires:
 *     - `{action: 'fire'}` (or undefined return) → emits `hook_fire`
 *     - `{action: 'block', reason}` → emits `hook_block`
 *     - `{action: 'escalate', reason}` → emits `hook_escalate`
 *   A handler that throws is caught and treated as `block` with `reason: 'handler_threw: <msg>'`.
 *
 * Day-3+ (Codex Thu): the per-HandlerType built-in implementations
 * (log_event / send_message / bash / webhook) register themselves at module
 * init using this same `registerHandler` API. No further dispatcher changes.
 */
export async function dispatchHook(hook: HookEntry, event: Event): Promise<void> {
  // Always write the local activity-log line (Day-1 behavior) for postmortem/audit.
  logHookAttempt(hook, event);

  // added 2026-04-29 by collie via dane dispatch — Day-2 per-handler wiring: result-driven emit
  const handler = _handlerRegistry.get(hook.handler_type);
  let result: HandlerResult;
  if (!handler) {
    // No handler registered for this type — Day-1 stub semantic: implicit fire.
    result = { action: 'fire', reason: 'no_handler_registered' };
  } else {
    try {
      const ret = await handler(hook, event);
      if (!ret) {
        // undefined / void → implicit fire (backwards-compatible default per Dane spec)
        result = { action: 'fire', reason: 'implicit_default' };
      } else {
        result = ret;
      }
    } catch (err) {
      // Buggy handler must never break the dispatcher loop. Treat throw as block.
      const msg = err instanceof Error ? err.message : String(err);
      result = { action: 'block', reason: `handler_threw: ${msg.slice(0, 120)}` };
    }
  }

  const eventName: HookEmitName =
    result.action === 'block' ? 'hook_block' :
    result.action === 'escalate' ? 'hook_escalate' :
    'hook_fire';

  emitHookBusEvent(eventName, {
    ...(result.meta ?? {}),
    hook_id: hook.id,
    handler_type: hook.handler_type,
    event_id: event.id,
    event_category: event.category,
    event_type: event.event,
    source_agent: event.agent,
    outcome: result.reason ?? `${result.action}_no_reason`,
  });
}

// ── Logging helpers (best-effort, never throw) ───────────────────────────────

function logHookAttempt(hook: HookEntry, event: Event): void {
  const line = JSON.stringify({
    ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    kind: 'hook_attempt',  // Day-2: no longer a stub — real result-driven emit follows in dispatchHook
    hook_id: hook.id,
    handler_type: hook.handler_type,
    event_id: event.id,
    event_category: event.category,
    event_type: event.event,
    agent: event.agent,
  });
  appendActivityLine(event.agent, line);
  // Day-2 (2026-04-29): bus event is now emitted by dispatchHook AFTER the handler returns,
  // so the bus-event taxonomy reflects the real action (fire/block/escalate). The local
  // activity-log line above stays for postmortem/audit — it records every attempt regardless.
}

// added 2026-04-29 by collie via dane dispatch — Task 1: queryable hook telemetry via cortextos bus log-event
// Best-effort: never throws, never blocks the dispatcher loop. Events go to the canonical
// per-agent JSONL at <analyticsDir>/events/<agent>/<YYYY-MM-DD>.jsonl so they show up in
// the same surface as task_completed, agent_message_sent, etc.
//
// Emit names follow Aussie's 8:10p test report taxonomy:
//   - hook_fire     — a hook matched + its dispatch was attempted (today: stub-logged only)
//   - hook_block    — a hook matched + actively blocked the calling action (gate said NO)
//   - hook_escalate — a hook matched + raised severity / re-routed (future use; not emitted by current code paths)
type HookEmitName = 'hook_fire' | 'hook_block' | 'hook_escalate';
function emitHookBusEvent(name: HookEmitName, meta: Record<string, unknown>): void {
  try {
    execFile(
      'cortextos',
      ['bus', 'log-event', 'action', name, 'info', '--meta', JSON.stringify(meta)],
      { timeout: 5_000 },
      () => { /* fire-and-forget */ },
    );
  } catch {
    // best-effort: never propagate logging failures
  }
}

function logRegistryWarn(orgPath: string, reason: string): void {
  const line = JSON.stringify({
    ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    kind: 'hook_registry_warn',
    org_path: orgPath,
    reason,
  });
  appendActivityLine('shared', line);
}

function appendActivityLine(scope: string, line: string): void {
  try {
    const dir = join(process.env.CTX_ROOT ?? '', 'logs', scope);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'hooks.log'), `${line}\n`, 'utf-8');
  } catch {
    // best-effort: never throw from a hook-side log path
  }
}

// Silence unused-import tsc warnings for symbols reserved for the upcoming
// dispatcher implementation (handler dispatch will use `dirname` to resolve
// relative paths in bash-handler templates per RFC #15 §5).
void dirname;
