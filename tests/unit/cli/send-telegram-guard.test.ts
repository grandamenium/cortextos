/**
 * send-telegram Guard regression tests.
 *
 * Guard 1: message body is a bare flag token (-- separator swallowed it)
 * Guard 2 Pattern A: leading decimal — `.,NNN` at word start (e.g. ".87", ",234")
 * Guard 2 Pattern B: positional-param strip — bash expands `$2` in `$283.87`,
 *   delivering `83.87` to the CLI (confirmed Jul 2026: Victoria saw `.87` not `$283.87`)
 *
 * Both guards exit(1) to prevent corrupted messages reaching tenants.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const sendMessageSpy = vi.fn().mockResolvedValue({ result: { message_id: 1 } });
vi.mock('../../../src/telegram/api.js', () => ({
  TelegramAPI: class {
    constructor(_token: string) {}
    sendMessage(...args: unknown[]) { return sendMessageSpy(...args); }
    sendPhoto = vi.fn().mockResolvedValue({ result: { message_id: 1 } });
    sendDocument = vi.fn().mockResolvedValue({ result: { message_id: 1 } });
  },
}));

import { busCommand } from '../../../src/cli/bus';

let tempCtx: string;
let tempCwd: string;
let originalCtxRoot: string | undefined;
let originalAgentName: string | undefined;
let originalBotToken: string | undefined;
let originalCwd: string;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tempCtx = mkdtempSync(join(tmpdir(), 'guard-ctx-'));
  tempCwd = mkdtempSync(join(tmpdir(), 'guard-cwd-'));
  mkdirSync(join(tempCtx, 'logs', 'test-agent'), { recursive: true });

  originalCtxRoot = process.env.CTX_ROOT;
  originalAgentName = process.env.CTX_AGENT_NAME;
  originalBotToken = process.env.BOT_TOKEN;
  originalCwd = process.cwd();
  process.env.CTX_ROOT = tempCtx;
  process.env.CTX_AGENT_NAME = 'test-agent';
  process.env.BOT_TOKEN = 'fake-token-for-test';
  process.chdir(tempCwd);

  sendMessageSpy.mockClear();
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => { throw new Error('process.exit'); });
});

afterEach(() => {
  exitSpy.mockRestore();
  process.chdir(originalCwd);
  if (originalCtxRoot === undefined) delete process.env.CTX_ROOT;
  else process.env.CTX_ROOT = originalCtxRoot;
  if (originalAgentName === undefined) delete process.env.CTX_AGENT_NAME;
  else process.env.CTX_AGENT_NAME = originalAgentName;
  if (originalBotToken === undefined) delete process.env.BOT_TOKEN;
  else process.env.BOT_TOKEN = originalBotToken;
  rmSync(tempCtx, { recursive: true, force: true });
  rmSync(tempCwd, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Guard 2 Pattern A — leading decimal (original Guard 2)
// ---------------------------------------------------------------------------
describe('Guard 2A — leading decimal (.,NNN at word start)', () => {
  it('blocks ".87" (dollar sign fully stripped, e.g. $2.87 → .87)', async () => {
    await expect(
      busCommand.parseAsync(['send-telegram', '12345', 'Your rent is .87'], { from: 'user' }),
    ).rejects.toThrow('process.exit');
    expect(sendMessageSpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('blocks ",234" (thousands separator stripped, e.g. $1,234 → ,234)', async () => {
    await expect(
      busCommand.parseAsync(['send-telegram', '12345', 'Balance: ,234.00'], { from: 'user' }),
    ).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('blocks ".00" at word start', async () => {
    await expect(
      busCommand.parseAsync(['send-telegram', '12345', 'Amount due .00'], { from: 'user' }),
    ).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

// ---------------------------------------------------------------------------
// Guard 2 Pattern B — positional param strip
// ---------------------------------------------------------------------------
describe('Guard 2B — positional param strip (NNN.NN after financial keyword)', () => {
  it('blocks "83.87" after "rent" (from $283.87 — $2 stripped)', async () => {
    // In bash double-quotes: "Your rent is $283.87"
    // $2 positional param (empty) + "83.87" → CLI receives "Your rent is 83.87"
    await expect(
      busCommand.parseAsync(['send-telegram', '12345', 'Your rent is 83.87'], { from: 'user' }),
    ).rejects.toThrow('process.exit');
    expect(sendMessageSpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('blocks "3.87" after "payment" (from $3.87 — $3 stripped)', async () => {
    await expect(
      busCommand.parseAsync(['send-telegram', '12345', 'payment of 3.87 received'], { from: 'user' }),
    ).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('blocks "83.87" after "balance"', async () => {
    await expect(
      busCommand.parseAsync(['send-telegram', '12345', 'balance: 83.87'], { from: 'user' }),
    ).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('blocks "43.50" after "fee"', async () => {
    await expect(
      busCommand.parseAsync(['send-telegram', '12345', 'Late fee of 43.50 applies'], { from: 'user' }),
    ).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('blocks production-observed case: Victoria rent notification', async () => {
    // Exact shape of the incident: $283.87 → $2="" + 83.87
    const corruptedMsg = 'Hi Victoria! Your rent payment of 83.87 is due Friday.';
    await expect(
      busCommand.parseAsync(['send-telegram', '12345', corruptedMsg], { from: 'user' }),
    ).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('does NOT block "2.30 PM" (time, no financial keyword)', async () => {
    await busCommand.parseAsync(
      ['send-telegram', '12345', 'Meeting at 2.30 PM tomorrow'],
      { from: 'user' },
    );
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('does NOT block "3.14" (scientific, no financial keyword)', async () => {
    await busCommand.parseAsync(
      ['send-telegram', '12345', 'PI is approximately 3.14'],
      { from: 'user' },
    );
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('does NOT block "Section 2.50" (non-financial context)', async () => {
    await busCommand.parseAsync(
      ['send-telegram', '12345', 'See Section 2.50 of the contract'],
      { from: 'user' },
    );
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Clean messages — should NOT be blocked
// ---------------------------------------------------------------------------
describe('Guard 2 — clean messages pass through', () => {
  it('sends a message with a real dollar sign (heredoc/positional with no stripping)', async () => {
    await busCommand.parseAsync(
      ['send-telegram', '12345', 'Your rent is $283.87 — thank you!'],
      { from: 'user' },
    );
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    const sent = sendMessageSpy.mock.calls[0][1] as string;
    expect(sent).toContain('$283.87');
  });

  it('sends a plain message with no amounts', async () => {
    await busCommand.parseAsync(
      ['send-telegram', '12345', 'Hello! Just checking in.'],
      { from: 'user' },
    );
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
  });

  it('sends a message with a decimal number in non-financial context', async () => {
    await busCommand.parseAsync(
      ['send-telegram', '12345', 'The property is 3.5 acres and has 2.30 miles of road.'],
      { from: 'user' },
    );
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
  });
});
