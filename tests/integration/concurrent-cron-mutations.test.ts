/**
 * tests/integration/concurrent-cron-mutations.test.ts — Iter 12 audit
 *
 * Pins the lost-update race in bus/crons.ts: addCron / updateCron /
 * removeCron all do `readCrons -> mutate -> writeCrons` with no
 * inter-process lock.  Two concurrent processes that interleave between
 * the read and the write will overwrite each other's mutations.
 *
 * The repro spawns N real child processes via the production CLI
 * (`node dist/cli.js bus ...`), each operating on a DIFFERENT cron name
 * within the same agent's crons.json.  After all complete, every
 * mutation MUST be reflected on disk.  Pre-fix, some mutations are lost
 * because the second writer's `readCrons` fired before the first
 * writer's `writeCrons` completed, so the second writer's snapshot was
 * stale and the rename overwrote the first writer's update.
 *
 * NOTE: this test invokes the compiled `dist/cli.js`, so the test
 * suite assumes `npm run build` ran beforehand (the CI workflow does
 * this).  If `dist/cli.js` is absent locally, the test is skipped with
 * a clear message rather than failing on a missing file.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { CronDefinition } from '../../src/types/index';

const execFileAsync = promisify(execFile);

const REPO_ROOT = join(__dirname, '..', '..');
const DIST_CLI  = join(REPO_ROOT, 'dist', 'cli.js');
const CRONS_DIR = '.cortextOS/state/agents';

let tmpRoot: string;
const originalCtxRoot = process.env.CTX_ROOT;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'concurrent-crons-'));
});

afterEach(() => {
  if (originalCtxRoot !== undefined) {
    process.env.CTX_ROOT = originalCtxRoot;
  } else {
    delete process.env.CTX_ROOT;
  }
  try { rmSync(tmpRoot, { recursive: true }); } catch { /* ignore */ }
});

function writeEnabledAgents(agent: string): void {
  const configDir = join(tmpRoot, 'config');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, 'enabled-agents.json'),
    JSON.stringify({ [agent]: { enabled: true, org: 'lifeos' } }, null, 2),
  );
}

function readCronsFromDisk(agent: string): CronDefinition[] {
  const filePath = join(tmpRoot, CRONS_DIR, agent, 'crons.json');
  if (!existsSync(filePath)) return [];
  const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
  return parsed.crons as CronDefinition[];
}

function seedCrons(agent: string, count: number): string[] {
  const dir = join(tmpRoot, CRONS_DIR, agent);
  mkdirSync(dir, { recursive: true });
  const names = Array.from({ length: count }, (_, i) => `cron-${i}`);
  const crons = names.map(name => ({
    name,
    prompt: `original-${name}`,
    schedule: '6h',
    enabled: true,
    created_at: new Date().toISOString(),
  }));
  writeFileSync(
    join(dir, 'crons.json'),
    JSON.stringify({ updated_at: new Date().toISOString(), crons }, null, 2),
  );
  return names;
}

async function runUpdate(agent: string, name: string, newPrompt: string): Promise<void> {
  await execFileAsync(
    process.execPath,
    [DIST_CLI, 'bus', 'update-cron', agent, name, '--prompt', newPrompt],
    { env: { ...process.env, CTX_ROOT: tmpRoot } },
  );
}

describe.skipIf(!existsSync(DIST_CLI))('Iter 12 audit: concurrent bus update-cron lost-update race', () => {
  it('N parallel update-cron processes against same agent — every mutation MUST survive (pinned, expected to FAIL pre-fix)', async () => {
    const agent = 'race-agent';
    writeEnabledAgents(agent);

    const N = 8;
    const ITERATIONS = 5;
    const lostUpdatesPerIteration: number[] = [];

    for (let iter = 0; iter < ITERATIONS; iter++) {
      const names = seedCrons(agent, N);

      // Launch N parallel CLI invocations updating N distinct crons.
      // Each writes a unique prompt so we can detect lost updates.
      const newPromptFor = (name: string) => `updated-iter${iter}-${name}`;
      await Promise.all(names.map(n => runUpdate(agent, n, newPromptFor(n))));

      // Verify all N mutations survived.
      const onDisk = readCronsFromDisk(agent);
      let lost = 0;
      for (const name of names) {
        const cron = onDisk.find(c => c.name === name);
        if (!cron || cron.prompt !== newPromptFor(name)) {
          lost++;
        }
      }
      lostUpdatesPerIteration.push(lost);
    }

    const totalLost = lostUpdatesPerIteration.reduce((a, b) => a + b, 0);
    // Diagnostic for debugging:
    if (totalLost > 0) {
      // eslint-disable-next-line no-console
      console.warn(`[iter12 audit] lost updates per iteration: ${lostUpdatesPerIteration.join(', ')} (total ${totalLost} of ${N * ITERATIONS})`);
    }
    expect(totalLost, 'concurrent bus update-cron must not lose any updates').toBe(0);
  }, 60_000);
});
