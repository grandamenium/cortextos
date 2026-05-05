// added 2026-04-29 by collie via dane dispatch — RFC #15 Day-2 per-handler wiring tests.
// Covers HandlerResult-driven dispatch (fire / block / escalate / undefined / throw) and
// the basic loadHookRegistry + matchHooks paths so a regression in either surface is caught.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { Event } from '../../../src/types/index';

// Capture every execFile invocation so we can assert which bus event was emitted.
// The dispatcher uses execFile('cortextos', ['bus', 'log-event', 'action', <name>, 'info', '--meta', <json>])
// fire-and-forget — we intercept before it spawns anything.
const execFileCalls: Array<{ cmd: string; args: string[] }> = [];
vi.mock('child_process', () => ({
  execFile: (cmd: string, args: string[], _opts: unknown, cb?: () => void) => {
    execFileCalls.push({ cmd, args: [...args] });
    if (typeof cb === 'function') cb();
    return { unref: () => {} };
  },
}));

// Imported AFTER vi.mock so the mocked execFile is in effect.
import {
  loadHookRegistry,
  matchHooks,
  dispatchHook,
  registerHandler,
  clearHandlerRegistry,
  _getRegisteredHandler,
  type HookEntry,
  type HandlerResult,
} from '../../../src/bus/hooks';

function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: 'evt-1',
    agent: 'collie',
    org: 'ascendops',
    timestamp: '2026-04-29T20:00:00Z',
    category: 'action',
    event: 'pm_meld_completed',
    severity: 'info',
    metadata: {},
    ...overrides,
  };
}

function makeHook(overrides: Partial<HookEntry> = {}): HookEntry {
  return {
    id: 'h1',
    event_pattern: { category: 'action', type: 'pm_meld_completed' },
    handler_type: 'log_event',
    handler: { category: 'action', type: 'demo', severity: 'info', meta: {} },
    agent_filter: [],
    priority: 100,
    enabled: true,
    ...overrides,
  };
}

// Helper: read the meta JSON from the most recent execFile call.
function lastEmittedEvent(): { name: string; meta: Record<string, unknown> } | null {
  if (execFileCalls.length === 0) return null;
  const args = execFileCalls[execFileCalls.length - 1].args;
  // shape: [bus, log-event, action, <name>, info, --meta, <json>]
  const name = args[3];
  const metaIdx = args.indexOf('--meta');
  const meta = metaIdx >= 0 && metaIdx + 1 < args.length ? JSON.parse(args[metaIdx + 1]) : {};
  return { name, meta };
}

describe('src/bus/hooks — Day-2 per-handler wiring', () => {
  beforeEach(() => {
    execFileCalls.length = 0;
    clearHandlerRegistry();
  });

  describe('loadHookRegistry', () => {
    let tmp: string;

    beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'cx-hooks-')); });
    afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

    it('returns empty registry when hooks.json is missing', () => {
      const reg = loadHookRegistry(tmp);
      expect(reg.hooks).toEqual([]);
      expect(reg.schema_version).toBe('0.1');
    });

    it('returns empty registry on malformed JSON (fail-open)', () => {
      writeFileSync(join(tmp, 'hooks.json'), '{not json');
      const reg = loadHookRegistry(tmp);
      expect(reg.hooks).toEqual([]);
    });

    it('parses a valid registry', () => {
      const valid = {
        schema_version: '1.0',
        hooks: [makeHook({ id: 'a' }), makeHook({ id: 'b' })],
      };
      writeFileSync(join(tmp, 'hooks.json'), JSON.stringify(valid));
      const reg = loadHookRegistry(tmp);
      expect(reg.hooks).toHaveLength(2);
      expect(reg.hooks.map(h => h.id)).toEqual(['a', 'b']);
    });
  });

  describe('matchHooks', () => {
    it('matches enabled hooks by category + type', () => {
      const reg = { schema_version: '1.0', hooks: [makeHook({ id: 'a' })] };
      const matched = matchHooks(reg, makeEvent(), 'collie');
      expect(matched).toHaveLength(1);
      expect(matched[0].id).toBe('a');
    });

    it('skips disabled hooks', () => {
      const reg = { schema_version: '1.0', hooks: [makeHook({ id: 'a', enabled: false })] };
      expect(matchHooks(reg, makeEvent(), 'collie')).toHaveLength(0);
    });

    it('respects agent_filter', () => {
      const reg = { schema_version: '1.0', hooks: [makeHook({ id: 'a', agent_filter: ['blue'] })] };
      expect(matchHooks(reg, makeEvent({ agent: 'collie' }), 'collie')).toHaveLength(0);
      expect(matchHooks(reg, makeEvent({ agent: 'blue' }), 'blue')).toHaveLength(1);
    });

    it('sorts matches by priority descending', () => {
      const reg = {
        schema_version: '1.0',
        hooks: [makeHook({ id: 'a', priority: 10 }), makeHook({ id: 'b', priority: 100 })],
      };
      const matched = matchHooks(reg, makeEvent(), 'collie');
      expect(matched.map(h => h.id)).toEqual(['b', 'a']);
    });

    it('matches metadata deeply (extra event keys allowed)', () => {
      const reg = {
        schema_version: '1.0',
        hooks: [makeHook({
          id: 'a',
          event_pattern: { category: 'action', type: 'pm_meld_completed', metadata: { tech: 'carlos' } },
        })],
      };
      expect(matchHooks(reg, makeEvent({ metadata: { tech: 'carlos', meld: 12345 } }), 'collie'))
        .toHaveLength(1);
      expect(matchHooks(reg, makeEvent({ metadata: { tech: 'silvano' } }), 'collie'))
        .toHaveLength(0);
    });
  });

  describe('dispatchHook — Day-2 result-driven emit', () => {
    it('falls back to hook_fire (no_handler_registered) when no handler is registered', async () => {
      await dispatchHook(makeHook(), makeEvent());
      const e = lastEmittedEvent();
      expect(e?.name).toBe('hook_fire');
      expect(e?.meta.outcome).toBe('no_handler_registered');
    });

    it('emits hook_fire (implicit_default) when handler returns undefined', async () => {
      registerHandler('log_event', () => undefined);
      await dispatchHook(makeHook(), makeEvent());
      const e = lastEmittedEvent();
      expect(e?.name).toBe('hook_fire');
      expect(e?.meta.outcome).toBe('implicit_default');
    });

    it('emits hook_fire with custom meta when handler returns {action:fire, meta}', async () => {
      registerHandler('log_event', (): HandlerResult => ({
        action: 'fire',
        reason: 'handler_ran',
        meta: { processed_meld_id: 12345 },
      }));
      await dispatchHook(makeHook(), makeEvent());
      const e = lastEmittedEvent();
      expect(e?.name).toBe('hook_fire');
      expect(e?.meta.outcome).toBe('handler_ran');
      expect(e?.meta.processed_meld_id).toBe(12345);
    });

    it('emits hook_block when handler returns {action:block}', async () => {
      registerHandler('log_event', (): HandlerResult => ({
        action: 'block',
        reason: 'guardrail_triggered',
      }));
      await dispatchHook(makeHook(), makeEvent());
      const e = lastEmittedEvent();
      expect(e?.name).toBe('hook_block');
      expect(e?.meta.outcome).toBe('guardrail_triggered');
    });

    it('emits hook_escalate when handler returns {action:escalate}', async () => {
      registerHandler('log_event', (): HandlerResult => ({
        action: 'escalate',
        reason: 'severity_upgraded_to_critical',
      }));
      await dispatchHook(makeHook(), makeEvent());
      const e = lastEmittedEvent();
      expect(e?.name).toBe('hook_escalate');
      expect(e?.meta.outcome).toBe('severity_upgraded_to_critical');
    });

    it('treats handler throw as hook_block with handler_threw reason', async () => {
      registerHandler('log_event', () => {
        throw new Error('intentional fault for test');
      });
      await dispatchHook(makeHook(), makeEvent());
      const e = lastEmittedEvent();
      expect(e?.name).toBe('hook_block');
      expect(typeof e?.meta.outcome).toBe('string');
      expect(String(e?.meta.outcome)).toContain('handler_threw');
      expect(String(e?.meta.outcome)).toContain('intentional fault');
    });

    it('awaits async handlers and routes their result correctly', async () => {
      registerHandler('log_event', async (): Promise<HandlerResult> => {
        await new Promise(r => setTimeout(r, 1));
        return { action: 'block', reason: 'async_block' };
      });
      await dispatchHook(makeHook(), makeEvent());
      const e = lastEmittedEvent();
      expect(e?.name).toBe('hook_block');
      expect(e?.meta.outcome).toBe('async_block');
    });

    it('always carries hook_id, handler_type, event_id in the meta payload', async () => {
      registerHandler('log_event', (): HandlerResult => ({ action: 'fire', reason: 'check_meta' }));
      await dispatchHook(
        makeHook({ id: 'h-meta', handler_type: 'log_event' }),
        makeEvent({ id: 'evt-meta' }),
      );
      const e = lastEmittedEvent();
      expect(e?.meta.hook_id).toBe('h-meta');
      expect(e?.meta.handler_type).toBe('log_event');
      expect(e?.meta.event_id).toBe('evt-meta');
    });

    it('handler meta cannot override dispatcher bookkeeping fields', async () => {
      registerHandler('log_event', (): HandlerResult => ({
        action: 'fire',
        reason: 'meta_override_check',
        meta: {
          hook_id: 'OVERRIDE_ATTEMPT',
          handler_type: 'OVERRIDE_ATTEMPT',
          event_id: 'OVERRIDE_ATTEMPT',
          event_category: 'OVERRIDE_ATTEMPT',
          event_type: 'OVERRIDE_ATTEMPT',
          source_agent: 'OVERRIDE_ATTEMPT',
          outcome: 'OVERRIDE_ATTEMPT',
          extra_handler_field: 'kept',
        },
      }));
      await dispatchHook(
        makeHook({ id: 'h-real', handler_type: 'log_event' }),
        makeEvent({ id: 'evt-real', agent: 'real-agent', category: 'action', event: 'real_event' }),
      );
      const e = lastEmittedEvent();
      expect(e?.meta.hook_id).toBe('h-real');
      expect(e?.meta.handler_type).toBe('log_event');
      expect(e?.meta.event_id).toBe('evt-real');
      expect(e?.meta.event_category).toBe('action');
      expect(e?.meta.event_type).toBe('real_event');
      expect(e?.meta.source_agent).toBe('real-agent');
      expect(e?.meta.outcome).toBe('meta_override_check');
      expect(e?.meta.extra_handler_field).toBe('kept');
    });
  });

  describe('handler registry', () => {
    it('registerHandler replaces existing handler and returns the prior one', () => {
      const fnA = () => undefined;
      const fnB = () => undefined;
      expect(registerHandler('log_event', fnA)).toBeUndefined();
      const prev = registerHandler('log_event', fnB);
      expect(prev).toBe(fnA);
      expect(_getRegisteredHandler('log_event')).toBe(fnB);
    });

    it('clearHandlerRegistry removes all registrations', () => {
      registerHandler('log_event', () => undefined);
      registerHandler('bash', () => undefined);
      clearHandlerRegistry();
      expect(_getRegisteredHandler('log_event')).toBeUndefined();
      expect(_getRegisteredHandler('bash')).toBeUndefined();
    });
  });
});
