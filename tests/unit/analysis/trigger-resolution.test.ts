import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  resolveTrigger,
  loadCronCatalog,
  extractClaudeOpeners,
  enrichTriggers,
} from '../../../src/analysis/trigger-resolution';
import type { TurnFact } from '../../../src/analysis/types';

function fixtureTurn(over: Partial<TurnFact>): TurnFact {
  return {
    turn_id: 'agent::s1::u1',
    agent: 'engineer',
    runtime: 'claude',
    session_id: 's1',
    ts: '2026-05-12T10:00:00Z',
    model: 'opus',
    input_tokens: 100, output_tokens: 50, cache_read: 0, cache_write: 0,
    usd_input: 0, usd_output: 0, usd_cache_read: 0, usd_cache_write: 0,
    usd_total: 0,
    is_sidechain: false,
    trigger_kind: 'unknown', trigger_name: null, trigger_prompt: null, session_opener: null, parent_session: null,
    tools_used: [], files_touched: [], bash_verbs: [], subagents_spawned: [],
    audit_run_id: 'r', source_file: '/x',
    ...over,
  };
}

describe('resolveTrigger', () => {
  it('identifies bus origin', () => {
    const r = resolveTrigger({
      openerText: '=== AGENT MESSAGE from boss [msg_id: 123]\nplease investigate X',
      sessionStart: new Date('2026-05-12T10:00:00Z'),
      agent: 'engineer',
      cronCatalog: [],
    });
    expect(r.kind).toBe('bus');
    expect(r.name).toBe('boss');
  });

  it('identifies telegram (user)', () => {
    const r = resolveTrigger({
      openerText: '=== TELEGRAM from saurav (chat_id:123)\nhi',
      sessionStart: new Date(),
      agent: 'engineer',
      cronCatalog: [],
    });
    expect(r.kind).toBe('user');
    expect(r.name).toBe('telegram');
  });

  it('identifies cron match with fire-window', () => {
    const sessionStart = new Date('2026-05-12T10:00:00Z');
    const r = resolveTrigger({
      openerText: '[CRON: heartbeat] Read HEARTBEAT.md and update your heartbeat',
      sessionStart,
      agent: 'engineer',
      cronCatalog: [{
        agent: 'engineer',
        cron: {
          name: 'heartbeat',
          prompt: 'Read HEARTBEAT.md and update your heartbeat',
          schedule: '4h',
        },
        last_fire: new Date('2026-05-12T10:00:30Z').toISOString(), // 30s diff
      }],
    });
    expect(r.kind).toBe('cron');
    expect(r.name).toBe('heartbeat');
  });

  it('falls back to user when no match', () => {
    const r = resolveTrigger({
      openerText: 'help me debug this thing',
      sessionStart: new Date(),
      agent: 'engineer',
      cronCatalog: [],
    });
    expect(r.kind).toBe('user');
    expect(r.name).toBe('terminal');
  });

  it('identifies hook origin', () => {
    const r = resolveTrigger({
      openerText: '[CRASH-ALERT] Agent X crashed at 10:00',
      sessionStart: new Date(),
      agent: 'engineer',
      cronCatalog: [],
    });
    expect(r.kind).toBe('hook');
    expect(r.name).toBe('crash-alert');
  });
});

describe('loadCronCatalog', () => {
  let ctxRoot: string;
  beforeEach(() => { ctxRoot = mkdtempSync(join(tmpdir(), 'trigger-')); });
  afterEach(() => rmSync(ctxRoot, { recursive: true, force: true }));

  it('reads crons.json + cron-state.json', () => {
    const cronsDir = join(ctxRoot, '.cortextOS', 'state', 'agents', 'engineer');
    mkdirSync(cronsDir, { recursive: true });
    writeFileSync(join(cronsDir, 'crons.json'), JSON.stringify({
      updated_at: '2026-05-12T00:00:00Z',
      crons: [{ name: 'heartbeat', prompt: 'do heartbeat', schedule: '4h' }],
    }));

    const stateDir = join(ctxRoot, 'state', 'engineer');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'cron-state.json'), JSON.stringify({
      updated_at: '2026-05-12T10:00:00Z',
      crons: [{ name: 'heartbeat', last_fire: '2026-05-12T10:00:00Z', interval: '4h' }],
    }));

    const catalog = loadCronCatalog(ctxRoot);
    expect(catalog).toHaveLength(1);
    expect(catalog[0].agent).toBe('engineer');
    expect(catalog[0].cron.name).toBe('heartbeat');
    expect(catalog[0].last_fire).toBe('2026-05-12T10:00:00Z');
  });
});

describe('extractClaudeOpeners + enrichTriggers', () => {
  let dir: string;
  let fp: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'opener-'));
    fp = join(dir, 't.jsonl');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('finds first user message per session and stamps turn rows', () => {
    writeFileSync(fp, [
      { type: 'user', sessionId: 's1', timestamp: '2026-05-12T10:00:00Z',
        message: { role: 'user', content: '=== AGENT MESSAGE from boss\nhello' } },
      { type: 'user', sessionId: 's1', timestamp: '2026-05-12T10:01:00Z',
        message: { role: 'user', content: 'second message ignored' } },
      { type: 'user', sessionId: 's2', timestamp: '2026-05-12T11:00:00Z',
        message: { role: 'user', content: 'help with thing' } },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n');

    const openers = extractClaudeOpeners(fp, 'engineer');
    expect(openers).toHaveLength(2);
    expect(openers[0].session_id).toBe('s1');
    expect(openers[0].opener_text).toContain('AGENT MESSAGE');

    const turns = [
      fixtureTurn({ turn_id: 'a::s1::u1', session_id: 's1' }),
      fixtureTurn({ turn_id: 'a::s2::u1', session_id: 's2' }),
    ];
    const enriched = enrichTriggers(turns, openers, []);
    expect(enriched[0].trigger_kind).toBe('bus');
    expect(enriched[0].trigger_name).toBe('boss');
    expect(enriched[1].trigger_kind).toBe('user');
  });
});
