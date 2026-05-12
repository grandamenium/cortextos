// Join codex-tokens turns with codex-thread tool/file events.
//
// codex-tokens.jsonl (written by appendCodexTokenLog) captures usage per turn.
// codex-thread.jsonl (NOT YET WRITTEN by the codex PTY as of this plan) would
// capture per-turn tool calls, file edits, etc. This module is a no-op until
// that file is being written — at which point it'll start filling in
// tools_used / files_touched / bash_verbs on codex TurnFact rows.
//
// Shape expected when present (one line per tool-call event):
//   { ts, session_id, turn_id, kind: 'tool_call', tool: 'patch'|'shell'|..., file_path?: string, command?: string }
//
// If the file isn't there, ingest emits codex turns with empty attribution
// (Phase-1 behavior). When upstream adds it, drop this comment and the join
// fills the columns automatically.

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { TurnFact, ToolUse } from './types.js';

interface CodexThreadEvent {
  ts?: string;
  session_id?: string;
  turn_id?: string;
  kind?: string;
  tool?: string;
  file_path?: string;
  command?: string;
  pattern?: string;
}

export function joinCodexTools(turns: TurnFact[], ctxRoot: string): TurnFact[] {
  // Group codex turns by agent so we only read each file once.
  const codexByAgent = new Map<string, TurnFact[]>();
  for (const t of turns) {
    if (t.runtime !== 'codex') continue;
    if (!codexByAgent.has(t.agent)) codexByAgent.set(t.agent, []);
    codexByAgent.get(t.agent)!.push(t);
  }
  if (codexByAgent.size === 0) return turns;

  // Build per-turn attribution from the thread log, keyed by (session_id, turn_id).
  const attribution = new Map<string, { tools: ToolUse[]; files: Set<string>; bash: Set<string> }>();

  for (const agent of codexByAgent.keys()) {
    const fp = join(ctxRoot, 'logs', agent, 'codex-thread.jsonl');
    if (!existsSync(fp)) continue;
    let raw: string;
    try { raw = readFileSync(fp, 'utf-8'); } catch { continue; }

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let ev: CodexThreadEvent;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.kind !== 'tool_call' || !ev.session_id || !ev.turn_id || !ev.tool) continue;
      const key = `${ev.session_id}::${ev.turn_id}`;
      let bucket = attribution.get(key);
      if (!bucket) { bucket = { tools: [], files: new Set(), bash: new Set() }; attribution.set(key, bucket); }

      const tu: ToolUse = { name: ev.tool, input_chars: 0 };
      if (ev.file_path) {
        tu.file_path = ev.file_path;
        bucket.files.add(ev.file_path);
      }
      if (ev.command) {
        tu.command = ev.command.slice(0, 200);
        const verb = ev.command.trim().split(/\s+/)[0] ?? '';
        if (verb) bucket.bash.add(verb);
        tu.input_chars = ev.command.length;
      }
      if (ev.pattern) tu.pattern = ev.pattern.slice(0, 200);
      bucket.tools.push(tu);
    }
  }

  if (attribution.size === 0) return turns;

  return turns.map((t) => {
    if (t.runtime !== 'codex') return t;
    // turn_id is "agent::session_id::turn_id"; recover the codex (session_id, turn_id).
    const parts = t.turn_id.split('::');
    const key = parts.length >= 3 ? `${parts[1]}::${parts.slice(2).join('::')}` : '';
    const bucket = attribution.get(key);
    if (!bucket) return t;
    return {
      ...t,
      tools_used: bucket.tools,
      files_touched: Array.from(bucket.files),
      bash_verbs: Array.from(bucket.bash),
    };
  });
}
