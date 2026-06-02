import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadSlackIdentity } from '../../../src/slack/identity';

function makeAgent(root: string, name: string, slackJson?: object): string {
  const dir = join(root, 'orgs', 'wyre', 'agents', name);
  mkdirSync(dir, { recursive: true });
  if (slackJson) writeFileSync(join(dir, 'slack.json'), JSON.stringify(slackJson));
  return dir;
}

describe('loadSlackIdentity', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sp3a-id-'));
  });

  it('returns display_name + icon_emoji from slack.json', () => {
    makeAgent(root, 'boss', {
      display_name: 'boss',
      icon_emoji: ':robot_face:',
      channels: { recap: 'C01' },
      allowed_channels: ['C01'],
    });
    const id = loadSlackIdentity(root, 'wyre', 'boss');
    expect(id).toEqual({ username: 'boss', icon_emoji: ':robot_face:' });
  });

  it('returns icon_url when slack.json has it instead of icon_emoji', () => {
    makeAgent(root, 'analyst', {
      display_name: 'analyst',
      icon_url: 'https://example.com/a.png',
      channels: {},
      allowed_channels: [],
    });
    const id = loadSlackIdentity(root, 'wyre', 'analyst');
    expect(id).toEqual({ username: 'analyst', icon_url: 'https://example.com/a.png' });
  });

  it('returns null when slack.json is absent (agent is Slack-disabled)', () => {
    makeAgent(root, 'dev'); // no slack.json
    expect(loadSlackIdentity(root, 'wyre', 'dev')).toBeNull();
  });

  it('throws on malformed slack.json', () => {
    const dir = makeAgent(root, 'broken');
    writeFileSync(join(dir, 'slack.json'), '{ not json');
    expect(() => loadSlackIdentity(root, 'wyre', 'broken')).toThrow(/parse/i);
  });

  it('resolves namespaced agent (engineer/agent)', () => {
    const nsDir = join(root, 'orgs', 'wyre', 'engineers', 'aaron', 'agents', 'dev');
    mkdirSync(nsDir, { recursive: true });
    writeFileSync(
      join(nsDir, 'slack.json'),
      JSON.stringify({
        display_name: 'aaron-dev',
        icon_emoji: ':computer:',
        channels: {},
        allowed_channels: [],
      }),
    );
    const id = loadSlackIdentity(root, 'wyre', 'aaron/dev');
    expect(id).toEqual({ username: 'aaron-dev', icon_emoji: ':computer:' });
  });
});
