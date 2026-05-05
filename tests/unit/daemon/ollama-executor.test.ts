import { describe, it, expect } from 'vitest';
import { OllamaExecutor } from '../../../src/daemon/ollama-executor';

describe('OllamaExecutor.parseCommands', () => {
  const executor = new OllamaExecutor({ logger: () => {} });

  it('extracts $ prefixed bus commands', () => {
    const response = `
I'll update the heartbeat now.
$ cortextos bus update-heartbeat "monitoring - all healthy"
$ cortextos bus log-event heartbeat agent_heartbeat info
Done.
    `;
    const cmds = executor.parseCommands(response);
    expect(cmds).toEqual([
      'cortextos bus update-heartbeat "monitoring - all healthy"',
      'cortextos bus log-event heartbeat agent_heartbeat info',
    ]);
  });

  it('extracts bare cortextos bus commands', () => {
    const response = `cortextos bus check-inbox`;
    const cmds = executor.parseCommands(response);
    expect(cmds).toEqual(['cortextos bus check-inbox']);
  });

  it('blocks non-whitelisted commands', () => {
    const logs: string[] = [];
    const ex = new OllamaExecutor({ logger: (m) => logs.push(m) });
    const response = `
$ rm -rf /
$ cortextos bus update-heartbeat "safe"
$ curl http://evil.com
$ echo "hello"
    `;
    const cmds = ex.parseCommands(response);
    expect(cmds).toEqual(['cortextos bus update-heartbeat "safe"']);
    expect(logs.filter(l => l.includes('BLOCKED')).length).toBe(3);
  });

  it('returns empty array for no commands', () => {
    const response = 'Everything looks good. No action needed.';
    expect(executor.parseCommands(response)).toEqual([]);
  });

  it('handles all whitelisted command prefixes', () => {
    const prefixes = [
      'cortextos bus update-heartbeat "ok"',
      'cortextos bus check-inbox',
      'cortextos bus ack-inbox msg123',
      'cortextos bus read-all-heartbeats',
      'cortextos bus list-approvals --format json',
      'cortextos bus list-tasks --status pending',
      'cortextos bus send-telegram 123 "hello"',
      'cortextos bus send-message agent1 normal "msg"',
      'cortextos bus log-event action test info',
      'cortextos bus update-task task123 in_progress',
      'cortextos bus complete-task task123 --result "done"',
      'cortextos bus kb-ingest ./file.md --org test',
    ];
    const response = prefixes.map(p => `$ ${p}`).join('\n');
    const cmds = executor.parseCommands(response);
    expect(cmds.length).toBe(prefixes.length);
  });
});
