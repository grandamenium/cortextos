import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// Regression test for the CLI error boundary. Before the fix, src/cli/index.ts
// ended with a synchronous `program.parse()` and NO catch, so any Error thrown
// by an action handler (e.g. "Task <id> not found" from complete-task /
// update-task) escaped as an uncaught exception — crashing with a full JS stack
// trace + "Node.js vX" footer and leaving task transitions looking "stuck".
// The fix uses `program.parseAsync().catch()` to print a clean one-line message
// and exit(1). We run the real source via tsx so no prior build step is needed.

const ROOT = join(__dirname, '..', '..');
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');
const ENTRY = join(ROOT, 'src', 'cli', 'index.ts');

function runCli(args: string[]) {
  return spawnSync(TSX, [ENTRY, ...args], { encoding: 'utf8', cwd: ROOT });
}

const NO_STACK = /^\s+at\s.+\(/m; // a JS stack frame line
const CRASH_FOOTER = /Node\.js v\d/; // the uncaught-exception process crash footer

describe('CLI error boundary — index.ts parseAsync().catch()', () => {
  it('complete-task with an unknown id → clean error, exit 1, no stack/crash', () => {
    const r = runCli(['bus', 'complete-task', 'nonexistent-task-id-xyz', '--result', 'x']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not found/i);
    expect(r.stderr).not.toMatch(NO_STACK);
    expect(r.stderr).not.toMatch(CRASH_FOOTER);
  }, 30000);

  it('update-task <id> completed with an unknown id → clean error, exit 1', () => {
    const r = runCli(['bus', 'update-task', 'nonexistent-task-id-xyz', 'completed']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not found/i);
    expect(r.stderr).not.toMatch(NO_STACK);
    expect(r.stderr).not.toMatch(CRASH_FOOTER);
  }, 30000);
});
