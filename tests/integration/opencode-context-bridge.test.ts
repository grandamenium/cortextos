import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { OpencodeContextReporter } from '../../src/pty/opencode-context-reporter.js';

function sqliteAvailable(): boolean {
  try {
    execFileSync('sqlite3', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const maybeIt = sqliteAvailable() ? it : it.skip;

describe('OpenCode context bridge SQLite fixture', () => {
  maybeIt('reports latest per-step context usage instead of session cumulative totals', () => {
    const root = mkdtempSync(join(tmpdir(), 'opencode-context-bridge-'));
    const stateDir = join(root, 'state', 'opencode-agent');
    const agentDir = join(root, 'orgs', 'acme', 'agents', 'opencode-agent');
    const opencodeRoot = join(stateDir, 'opencode');
    const dbPath = join(opencodeRoot, 'data', 'opencode', 'opencode.db');
    mkdirSync(join(opencodeRoot, 'data', 'opencode'), { recursive: true });
    mkdirSync(join(opencodeRoot, 'cache', 'opencode'), { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(opencodeRoot, 'cache', 'opencode', 'models.json'), JSON.stringify({
      'opencode-go': {
        models: {
          'deepseek-v4-pro': { limit: { context: 1_000_000 } },
        },
      },
    }));

    execFileSync('sqlite3', [dbPath, [
      'create table session (id text primary key, directory text not null, model text, tokens_input integer, tokens_output integer, tokens_cache_read integer, time_updated integer);',
      'create table part (id text primary key, message_id text, session_id text not null, time_created integer, time_updated integer, data text not null);',
      `insert into session values ('ses-1','${agentDir.replace(/'/g, "''")}','{"providerID":"opencode-go","id":"deepseek-v4-pro"}',999999,999999,999999,20);`,
      `insert into part values ('part-old','msg-1','ses-1',10,10,'{"type":"step-finish","tokens":{"total":100000,"input":10,"output":5,"reasoning":0,"cache":{"read":99985,"write":0}}}');`,
      `insert into part values ('part-new','msg-2','ses-1',20,20,'{"type":"step-finish","tokens":{"total":450000,"input":100,"output":50,"reasoning":25,"cache":{"read":449850,"write":0}}}');`,
    ].join('\n')]);

    const reporter = new OpencodeContextReporter({
      stateDir,
      agentDir,
      workingDir: agentDir,
      opencodeStateRoot: opencodeRoot,
      config: {},
      startedAtMs: 0,
    });

    expect(reporter.reportOnce()).toBe(true);
    const statusPath = join(stateDir, 'context_status.json');
    expect(existsSync(statusPath)).toBe(true);
    const status = JSON.parse(readFileSync(statusPath, 'utf-8')) as Record<string, unknown>;
    expect(status.used_percentage).toBe(45);
    expect(status.context_window_size).toBe(1_000_000);
    expect(status.session_id).toBe('ses-1');
    expect(status.current_usage).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 449850,
      cache_creation_input_tokens: 0,
    });
  });
});
