import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runTestSend } from '../../../src/cli/slack';

describe('runTestSend', () => {
  let root: string;
  let api: { postMessage: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sp3a-cli-'));
    api = { postMessage: vi.fn().mockResolvedValue({ ok: true, channel: 'C1', ts: '1' }) };
  });

  it('posts a test message under the agent identity', async () => {
    const agentDir = join(root, 'orgs', 'wyre', 'agents', 'boss');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, 'slack.json'),
      JSON.stringify({
        display_name: 'boss',
        icon_emoji: ':robot_face:',
        channels: {},
        allowed_channels: [],
      }),
    );
    await runTestSend(
      { frameworkRoot: root, org: 'wyre', agent: 'boss', channel: 'C1', text: 'hi' },
      api as never,
    );
    expect(api.postMessage).toHaveBeenCalledWith({
      channel: 'C1',
      text: 'hi',
      username: 'boss',
      icon_emoji: ':robot_face:',
    });
  });

  it('posts without identity when --as is omitted', async () => {
    await runTestSend(
      { frameworkRoot: root, org: 'wyre', channel: 'C1', text: 'plain' },
      api as never,
    );
    expect(api.postMessage).toHaveBeenCalledWith({ channel: 'C1', text: 'plain' });
  });
});
