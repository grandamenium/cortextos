import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock TelegramAPI so createDecision does not hit the network. The mock
// returns a stable message_id so tests can assert state-file contents
// without coupling to fetch internals.
const sendMessageSpy = vi.fn();
vi.mock('../../../src/telegram/api', () => {
  class TelegramAPI {
    sendMessage(...args: unknown[]) {
      return sendMessageSpy(...args);
    }
  }
  return { TelegramAPI };
});

import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createDecision,
  getDecision,
  listDecisions,
  resolveDecision,
  getDecisionStatePath,
} from '../../../src/bus/decision';
import type { BusPaths } from '../../../src/types';

let testDir: string;
let paths: BusPaths;

function mkPaths(root: string): BusPaths {
  return {
    ctxRoot: root,
    inbox: join(root, 'inbox'),
    inflight: join(root, 'inflight'),
    processed: join(root, 'processed'),
    logDir: join(root, 'logs'),
    stateDir: join(root, 'state'),
    taskDir: join(root, 'tasks'),
    approvalDir: join(root, 'approvals'),
    analyticsDir: join(root, 'analytics'),
    deliverablesDir: join(root, 'deliverables'),
  };
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'cortextos-decision-test-'));
  paths = mkPaths(testDir);
  sendMessageSpy.mockClear();
  sendMessageSpy.mockResolvedValue({ result: { message_id: 4242 } });
  process.env.BOT_TOKEN = 'fake-token';
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  delete process.env.BOT_TOKEN;
});

describe('createDecision', () => {
  it('writes a pending entry to pending-decisions.json with the right shape', async () => {
    const { id, message_id } = await createDecision(paths, {
      title: 'Ship it?',
      context: 'PR #123 is green.',
      options: ['YES', 'NO', 'HOLD'],
      chat_id: '6585156851',
      agent: 'devops',
    });

    expect(id).toMatch(/^decision_\d+_[a-z0-9]{5}$/);
    expect(message_id).toBe(4242);

    // Telegram sendMessage was called with inline_keyboard reply_markup.
    expect(sendMessageSpy).toHaveBeenCalledOnce();
    const [chatIdArg, textArg, replyMarkupArg] = sendMessageSpy.mock.calls[0];
    expect(chatIdArg).toBe('6585156851');
    expect(textArg).toContain('Ship it?');
    expect(textArg).toContain('PR #123 is green.');
    expect(replyMarkupArg).toEqual({
      inline_keyboard: [[
        { text: 'YES', callback_data: `decision_${id}_0` },
        { text: 'NO', callback_data: `decision_${id}_1` },
        { text: 'HOLD', callback_data: `decision_${id}_2` },
      ]],
    });

    // State file written and parses to expected shape.
    const statePath = getDecisionStatePath(paths);
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    expect(state.decisions).toHaveLength(1);
    const d = state.decisions[0];
    expect(d).toMatchObject({
      id,
      title: 'Ship it?',
      context: 'PR #123 is green.',
      options: ['YES', 'NO', 'HOLD'],
      chat_id: '6585156851',
      message_id: 4242,
      agent: 'devops',
      status: 'pending',
    });
    expect(d.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(d.chosen).toBeUndefined();
  });

  it('throws if options is empty', async () => {
    await expect(
      createDecision(paths, {
        title: 't',
        context: 'c',
        options: [],
        chat_id: '1',
        agent: 'devops',
      }),
    ).rejects.toThrow(/options must be a non-empty array/);
  });
});

describe('getDecision / listDecisions / resolveDecision', () => {
  it('round-trips: create -> get -> list pending -> resolve -> list resolved', async () => {
    const { id } = await createDecision(paths, {
      title: 'Pick lunch',
      context: 'taco or pizza',
      options: ['taco', 'pizza'],
      chat_id: '1',
      agent: 'devops',
    });

    const fetched = getDecision(paths, id);
    expect(fetched?.id).toBe(id);
    expect(fetched?.status).toBe('pending');

    const pending = listDecisions(paths, 'pending');
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(id);

    const resolved = resolveDecision(paths, id, 'taco');
    expect(resolved?.status).toBe('resolved');
    expect(resolved?.chosen).toBe('taco');
    expect(resolved?.resolved_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(listDecisions(paths, 'pending')).toHaveLength(0);
    expect(listDecisions(paths, 'resolved')).toHaveLength(1);

    // Idempotent: second resolve returns undefined (already resolved).
    expect(resolveDecision(paths, id, 'pizza')).toBeUndefined();
  });

  it('returns undefined for unknown ids', () => {
    expect(getDecision(paths, 'decision_0_nope0')).toBeUndefined();
    expect(resolveDecision(paths, 'decision_0_nope0', 'YES')).toBeUndefined();
  });
});
