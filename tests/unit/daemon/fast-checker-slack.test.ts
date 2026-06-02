import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../src/bus/message.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/bus/message.js')>();
  return { ...actual, sendMessage: vi.fn() };
});
vi.mock('../../../src/slack/api.js', () => ({
  SlackAPI: vi.fn().mockImplementation(function () {
    return {
      getHistory: vi.fn(),
      getUserName: vi.fn().mockResolvedValue('Test User'),
      getUserInfo: vi.fn().mockResolvedValue({ handle: null, displayName: 'Test User' }),
      postMessage: vi.fn(),
    };
  }),
}));
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FastChecker } from '../../../src/daemon/fast-checker';
import { SlackAPI } from '../../../src/slack/api.js';
import { sendMessage } from '../../../src/bus/message.js';
import type { BusPaths } from '../../../src/types';

// Minimal mock for AgentProcess
function createMockAgent(name = 'test-agent') {
  return {
    name,
    isBootstrapped: vi.fn().mockReturnValue(true),
    injectMessage: vi.fn().mockReturnValue(true),
    write: vi.fn(),
  } as any;
}

function createTestPaths(testDir: string): BusPaths {
  const paths: BusPaths = {
    ctxRoot: testDir,
    inbox: join(testDir, 'inbox'),
    inflight: join(testDir, 'inflight'),
    processed: join(testDir, 'processed'),
    logDir: join(testDir, 'logs'),
    stateDir: join(testDir, 'state'),
    taskDir: join(testDir, 'tasks'),
    approvalDir: join(testDir, 'approvals'),
    analyticsDir: join(testDir, 'analytics'),
    deliverablesDir: join(testDir, 'deliverables'),
  };
  for (const dir of Object.values(paths)) {
    if (dir !== testDir) {
      mkdirSync(dir, { recursive: true });
    }
  }
  return paths;
}

describe('FastChecker', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-fastchecker-slack-test-'));
    paths = createTestPaths(testDir);
  });

  describe('checkSlackWatch — Slack watch', () => {
    let checker: FastChecker;
    let mockApi: any;

    beforeEach(() => {
      vi.clearAllMocks();
      checker = new FastChecker(createMockAgent(), paths, '/framework', {
        slackWatch: { channel: 'C1234567890', intervalMs: 60000, token: 'xoxb-test' },
      });
      (checker as any).slackLastCheckedAt = 0;
      mockApi = vi.mocked(SlackAPI).mock.results[vi.mocked(SlackAPI).mock.results.length - 1].value;
    });

    it('TC-S1: empty channel — no messages, no inbox write', async () => {
      mockApi.getHistory.mockResolvedValue([]);
      await (checker as any).checkSlackWatch();
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('TC-S2: new message — wakes agent with correct inbox format', async () => {
      mockApi.getHistory.mockResolvedValue([{ ts: '1234.0001', user: 'U123', text: 'Hello', type: 'message' }]);
      mockApi.getUserInfo.mockResolvedValue({ handle: 'jordan.lee', displayName: 'Jordan Lee' });
      await (checker as any).checkSlackWatch();
      expect(sendMessage).toHaveBeenCalledTimes(1);
      const text = (sendMessage as any).mock.calls[0][4];
      // Handle present, no team_members -> "Name (@handle)".
      expect(text).toContain('=== SLACK from Jordan Lee (@jordan.lee)');
      expect(text).toContain('channel:C1234567890');
      expect(text).toContain('Hello');
      expect(text).toContain('Reply using: cortextos bus send-slack');
    });

    it('TC-S9: untrusted user dropped when allowlist configured', async () => {
      const gated = new FastChecker(createMockAgent(), paths, '/framework', {
        slackWatch: {
          channel: 'C1234567890',
          intervalMs: 60000,
          token: 'xoxb-test',
          trustedSlackUsers: ['jordan.lee'],
        },
      });
      (gated as any).slackLastCheckedAt = 0;
      const gatedApi = vi.mocked(SlackAPI).mock.results[vi.mocked(SlackAPI).mock.results.length - 1].value;
      gatedApi.getHistory.mockResolvedValue([{ ts: '9.0', user: 'URAND', text: 'intruder', type: 'message' }]);
      gatedApi.getUserInfo.mockResolvedValue({ handle: 'random.person', displayName: 'Random Person' });
      await (gated as any).checkSlackWatch();
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('TC-S10: missing msg.user falls back to username, still delivered', async () => {
      mockApi.getHistory.mockResolvedValue([{ ts: '11.0', username: 'webhook-bot', text: 'no user id', type: 'message' }]);
      await (checker as any).checkSlackWatch();
      expect(sendMessage).toHaveBeenCalledTimes(1);
      const text = (sendMessage as any).mock.calls[0][4];
      expect(text).toContain('=== SLACK from webhook-bot');
      expect(mockApi.getUserInfo).not.toHaveBeenCalled();
    });

    it('TC-S11: userless message DROPPED when allowlist configured (fail-closed, no bypass)', async () => {
      const gated = new FastChecker(createMockAgent(), paths, '/framework', {
        slackWatch: {
          channel: 'C1234567890',
          intervalMs: 60000,
          token: 'xoxb-test',
          trustedSlackUsers: ['jordan.lee'],
        },
      });
      (gated as any).slackLastCheckedAt = 0;
      const gatedApi = vi.mocked(SlackAPI).mock.results[vi.mocked(SlackAPI).mock.results.length - 1].value;
      // App/webhook-style message with NO user id — must not bypass the allowlist.
      gatedApi.getHistory.mockResolvedValue([{ ts: '12.0', username: 'webhook-bot', text: 'sneaky', type: 'message' }]);
      await (gated as any).checkSlackWatch();
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('TC-S12: trusted message past the first 10 still delivered (gate before display cap)', async () => {
      const gated = new FastChecker(createMockAgent(), paths, '/framework', {
        slackWatch: {
          channel: 'C1234567890',
          intervalMs: 60000,
          token: 'xoxb-test',
          trustedSlackUsers: ['jordan.lee'],
          teamMembers: [{ name: 'Jordan Lee', role: 'Ops', slack_handle: 'jordan.lee', trust_level: 'owner' }],
        },
      });
      (gated as any).slackLastCheckedAt = 0;
      const gatedApi = vi.mocked(SlackAPI).mock.results[vi.mocked(SlackAPI).mock.results.length - 1].value;
      // 10 untrusted messages, then a trusted one 11th. slackLastTs advances to
      // the newest, so if the cap were applied to raw history the trusted msg
      // would be permanently lost. Gating-before-cap must still deliver it.
      const history = [];
      for (let i = 0; i < 10; i++) history.push({ ts: `${i}.0`, user: 'URAND', text: `spam ${i}`, type: 'message' });
      history.push({ ts: '11.0', user: 'UBRIT', text: 'real request', type: 'message' });
      gatedApi.getHistory.mockResolvedValue(history);
      gatedApi.getUserInfo.mockImplementation(async (id: string) =>
        id === 'UBRIT'
          ? { handle: 'jordan.lee', displayName: 'Jordan Lee' }
          : { handle: 'random.person', displayName: 'Random Person' },
      );
      await (gated as any).checkSlackWatch();
      expect(sendMessage).toHaveBeenCalledTimes(1);
      const text = (sendMessage as any).mock.calls[0][4];
      expect(text).toContain('real request');
      expect(text).toContain('from Jordan Lee (@jordan.lee, owner)');
      expect(text).not.toContain('spam');
    });

    it('TC-S3: cursor-based dedup — same message not processed twice', async () => {
      mockApi.getHistory.mockResolvedValueOnce([{ ts: '100.0001', text: 'msg1', type: 'message', user: 'U1' }]);
      await (checker as any).checkSlackWatch();
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect((checker as any).slackLastTs).toBe('100.0001');
      (checker as any).slackLastCheckedAt = 0;
      mockApi.getHistory.mockResolvedValueOnce([]);
      await (checker as any).checkSlackWatch();
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(mockApi.getHistory).toHaveBeenCalledWith('C1234567890', '100.0001');
    });

    it('TC-S4: cursor advances to newest message ts', async () => {
      mockApi.getHistory.mockResolvedValue([
        { ts: '100.0', text: 'first', type: 'message', user: 'U1' },
        { ts: '200.0', text: 'second', type: 'message', user: 'U1' },
      ]);
      await (checker as any).checkSlackWatch();
      expect((checker as any).slackLastTs).toBe('200.0');
    });

    it('TC-S5: rate limit response — no crash, no inbox write', async () => {
      mockApi.getHistory.mockRejectedValue(new Error('Slack conversations.history failed: ratelimited'));
      await expect((checker as any).checkSlackWatch()).resolves.not.toThrow();
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('TC-S6: invalid/expired token — no crash, no inbox write', async () => {
      mockApi.getHistory.mockRejectedValue(new Error('Slack conversations.history failed: invalid_auth'));
      await expect((checker as any).checkSlackWatch()).resolves.not.toThrow();
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('TC-S7: network failure — recovers on next poll', async () => {
      mockApi.getHistory.mockRejectedValueOnce(new Error('fetch failed: ECONNREFUSED'));
      await expect((checker as any).checkSlackWatch()).resolves.not.toThrow();
      expect(sendMessage).not.toHaveBeenCalled();
      (checker as any).slackLastCheckedAt = 0;
      mockApi.getHistory.mockResolvedValueOnce([{ ts: '500.0', text: 'recovered', type: 'message', user: 'U1' }]);
      await (checker as any).checkSlackWatch();
      expect(sendMessage).toHaveBeenCalledTimes(1);
      const text = (sendMessage as any).mock.calls[0][4];
      expect(text).toContain('recovered');
    });

    it('TC-S8: bot own messages ignored — no self-wake loop', async () => {
      mockApi.getHistory.mockResolvedValue([
        { ts: '100.0', user: 'U123', text: 'human msg', type: 'message' },
        { ts: '200.0', text: 'bot msg', type: 'message', subtype: 'bot_message', bot_id: 'B001' },
      ]);
      await (checker as any).checkSlackWatch();
      expect(sendMessage).toHaveBeenCalledTimes(1);
      const text = (sendMessage as any).mock.calls[0][4];
      expect(text).toContain('human msg');
      expect(text).not.toContain('bot msg');
    });

    it('TC-S13: self-echo dropped — bot_id present WITHOUT bot_message subtype', async () => {
      // The agent's own outbound post via its bot token arrives as a NORMAL
      // message (no bot_message subtype) carrying bot_id. The subtype filter
      // alone would let it through and loop it back into our inbox.
      mockApi.getHistory.mockResolvedValue([
        { ts: '100.0', user: 'U123', text: 'human msg', type: 'message' },
        { ts: '200.0', user: 'UBOTSELF', text: 'my own reply', type: 'message', bot_id: 'B001' },
      ]);
      mockApi.getUserInfo.mockResolvedValue({ handle: 'someone', displayName: 'Someone' });
      await (checker as any).checkSlackWatch();
      expect(sendMessage).toHaveBeenCalledTimes(1);
      const text = (sendMessage as any).mock.calls[0][4];
      expect(text).toContain('human msg');
      expect(text).not.toContain('my own reply');
    });

    it('TC-S14: cursor advances to raw newest past a filtered bot_id message (no re-fetch stall)', async () => {
      // Newest fetched event is the agent's own reply (bot_id) at ts 200. The
      // cursor must advance to 200, NOT stick at the human msg (100) — otherwise
      // the next poll re-fetches + re-drops the bot reply every cycle forever.
      mockApi.getHistory.mockResolvedValue([
        { ts: '100.0', user: 'U123', text: 'human msg', type: 'message' },
        { ts: '200.0', user: 'UBOTSELF', text: 'my own reply', type: 'message', bot_id: 'B001' },
      ]);
      mockApi.getUserInfo.mockResolvedValue({ handle: 'someone', displayName: 'Someone' });
      await (checker as any).checkSlackWatch();
      expect((checker as any).slackLastTs).toBe('200.0');
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect((sendMessage as any).mock.calls[0][4]).toContain('human msg');
    });

    it('TC-S15: cursor advances even when ALL fetched messages are bot-authored (no stall)', async () => {
      mockApi.getHistory.mockResolvedValue([
        { ts: '300.0', user: 'UBOTSELF', text: 'echo', type: 'message', bot_id: 'B001' },
      ]);
      await (checker as any).checkSlackWatch();
      expect((checker as any).slackLastTs).toBe('300.0');
      expect(sendMessage).not.toHaveBeenCalled();
    });
  });
});
