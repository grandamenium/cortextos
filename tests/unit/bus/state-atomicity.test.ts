import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import { tmpdir } from 'os';

const execFileAsync = promisify(execFile);

const REPO_ROOT = join(__dirname, '..', '..', '..');
const DIST_CLI = join(REPO_ROOT, 'dist', 'cli.js');
const INSTANCE_ID = 'atomicity';
const AGENT = 'codexer';
const ORG = 'clearworksai';

interface CliContext {
  homeDir: string;
  ctxRoot: string;
  preloadPath: string;
}

interface TaskFileShape {
  id: string;
  blocks?: string[];
}

interface CronFireRecord {
  name: string;
  interval?: string;
  last_fire: string;
}

interface CronStateFile {
  updated_at: string;
  crons: CronFireRecord[];
}

interface ReminderFileShape {
  id: string;
  status: 'pending' | 'acked';
}

type DedupLedger = Record<string, number>;

function normalizeForMatch(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function createCliContext(): CliContext {
  const homeDir = mkdtempSync(join(tmpdir(), 'atomic-state-home-'));
  const ctxRoot = join(homeDir, '.cortextos', INSTANCE_ID);
  mkdirSync(ctxRoot, { recursive: true });

  const preloadPath = join(homeDir, 'atomicity-preload.cjs');
  writeFileSync(preloadPath, `
const fs = require('fs');

const sleeper = new Int32Array(new SharedArrayBuffer(4));
const delayMs = Number(process.env.ATOMICITY_DELAY_MS || '0');
const matchNeedle = String(process.env.ATOMICITY_DELAY_MATCH || '');
const normalize = (value) => String(value).replace(/\\\\/g, '/');
const sleep = (ms) => {
  if (ms > 0) Atomics.wait(sleeper, 0, 0, ms);
};

const originalReadFileSync = fs.readFileSync;
fs.readFileSync = function patchedReadFileSync(filePath, ...args) {
  const result = originalReadFileSync.call(this, filePath, ...args);
  if (matchNeedle && normalize(filePath).includes(matchNeedle)) {
    sleep(delayMs);
  }
  return result;
};

global.fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ ok: true, result: { message_id: 1 } }),
  arrayBuffer: async () => new ArrayBuffer(0),
  text: async () => '',
});
`, 'utf-8');

  return { homeDir, ctxRoot, preloadPath };
}

function cleanupCliContext(ctx: CliContext): void {
  rmSync(ctx.homeDir, { recursive: true, force: true });
}

function baseEnv(ctx: CliContext): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: ctx.homeDir,
    CTX_INSTANCE_ID: INSTANCE_ID,
    CTX_ROOT: ctx.ctxRoot,
    CTX_AGENT_NAME: AGENT,
    CTX_ORG: ORG,
    BOT_TOKEN: '123456:test-token',
    NODE_OPTIONS: `--require ${ctx.preloadPath}`,
  };
}

async function runCli(
  ctx: CliContext,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(
    process.execPath,
    [DIST_CLI, ...args],
    {
      cwd: REPO_ROOT,
      env: {
        ...baseEnv(ctx),
        ...extraEnv,
      },
    },
  );
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
}

function taskFilePath(ctx: CliContext, taskId: string): string {
  return join(ctx.ctxRoot, 'orgs', ORG, 'tasks', `${taskId}.json`);
}

function cronStatePath(ctx: CliContext): string {
  return join(ctx.ctxRoot, 'state', AGENT, 'cron-state.json');
}

function remindersPath(ctx: CliContext): string {
  return join(ctx.ctxRoot, 'state', AGENT, 'pending-reminders.json');
}

function dedupLedgerPath(ctx: CliContext): string {
  return join(ctx.ctxRoot, 'state', 'telegram-dedup.json');
}

describe.skipIf(!existsSync(DIST_CLI))('state atomicity proof against built cli', () => {
  let ctx: CliContext;

  beforeEach(() => {
    ctx = createCliContext();
  });

  afterEach(() => {
    cleanupCliContext(ctx);
  });

  it('lost-update: concurrent create-task peer-edge writes preserve every symmetric edge', async () => {
    const batches = 3;
    const parallelCreates = 8;
    let totalLostEdges = 0;

    for (let batch = 0; batch < batches; batch += 1) {
      const blockerId = (await runCli(ctx, ['bus', 'create-task', `blocker-${batch}`])).stdout.trim();
      const delayMatch = normalizeForMatch(`/orgs/${ORG}/tasks/${blockerId}.json`);

      const childCreates = await Promise.all(
        Array.from({ length: parallelCreates }, (_, idx) => (
          runCli(
            ctx,
            ['bus', 'create-task', `child-${batch}-${idx}`, '--blocked-by', blockerId],
            {
              ATOMICITY_DELAY_MATCH: delayMatch,
              ATOMICITY_DELAY_MS: '60',
            },
          )
        )),
      );

      const childIds = childCreates.map(result => result.stdout.trim());
      const blocker = readJsonFile<TaskFileShape>(taskFilePath(ctx, blockerId));
      const blocks = blocker.blocks ?? [];
      totalLostEdges += childIds.filter(id => !blocks.includes(id)).length;
    }

    expect(totalLostEdges).toBe(0);
  }, 60_000);

  it('torn-read: cron-state and reminders recover from truncated primaries without resetting to empty', async () => {
    await runCli(ctx, ['bus', 'update-cron-fire', 'heartbeat', '--interval', '6h']);
    await runCli(ctx, ['bus', 'update-cron-fire', 'inbox-triage', '--interval', '2h']);

    const cronFile = cronStatePath(ctx);
    expect(existsSync(cronFile + '.bak')).toBe(true);
    writeFileSync(cronFile, '{', 'utf-8');

    await runCli(ctx, ['bus', 'update-cron-fire', 'autoresearch', '--interval', '24h']);

    const cronState = readJsonFile<CronStateFile>(cronFile);
    const cronNames = cronState.crons.map(record => record.name);
    expect(cronNames).toContain('heartbeat');
    expect(cronNames).toContain('autoresearch');

    const firstFireAt = new Date(Date.now() + 3_600_000).toISOString();
    const secondFireAt = new Date(Date.now() + 7_200_000).toISOString();
    const firstReminderId = (await runCli(ctx, ['bus', 'create-reminder', firstFireAt, 'first reminder'])).stdout.trim();
    await runCli(ctx, ['bus', 'create-reminder', secondFireAt, 'second reminder']);

    const remindersFile = remindersPath(ctx);
    expect(existsSync(remindersFile + '.bak')).toBe(true);
    writeFileSync(remindersFile, '[', 'utf-8');

    await runCli(ctx, ['bus', 'ack-reminder', firstReminderId]);

    const reminders = readJsonFile<ReminderFileShape[]>(remindersFile);
    const firstReminder = reminders.find(reminder => reminder.id === firstReminderId);
    expect(firstReminder?.status).toBe('acked');
  }, 60_000);

  it('dedup TOCTOU: concurrent send-telegram calls suppress exactly one duplicate and keep the ledger entry', async () => {
    const ledgerFile = dedupLedgerPath(ctx);
    mkdirSync(join(ctx.ctxRoot, 'state'), { recursive: true });
    writeFileSync(ledgerFile, '{}\n', 'utf-8');

    const runs = await Promise.all([
      runCli(
        ctx,
        ['bus', 'send-telegram', '12345', 'atomic dedup probe', '--dedup-window', '3600', '--plain-text'],
        {
          ATOMICITY_DELAY_MATCH: normalizeForMatch('/state/telegram-dedup.json'),
          ATOMICITY_DELAY_MS: '60',
        },
      ),
      runCli(
        ctx,
        ['bus', 'send-telegram', '12345', 'atomic dedup probe', '--dedup-window', '3600', '--plain-text'],
        {
          ATOMICITY_DELAY_MATCH: normalizeForMatch('/state/telegram-dedup.json'),
          ATOMICITY_DELAY_MS: '60',
        },
      ),
    ]);

    const sentCount = runs.filter(run => run.stdout.includes('Message sent')).length;
    const suppressedCount = runs.filter(run => run.stdout.includes('Message suppressed')).length;
    const ledger = readJsonFile<DedupLedger>(ledgerFile);

    expect(sentCount).toBe(1);
    expect(suppressedCount).toBe(1);
    expect(Object.keys(ledger)).toHaveLength(1);
  }, 60_000);
});
