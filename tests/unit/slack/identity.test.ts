import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadSlackIdentity, isSlackUserAllowed, slackIdentityKey, type SlackConfig } from '../../../src/slack/identity';

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
});

describe('slackIdentityKey', () => {
  it('composes team_id and user_id into a single key', () => {
    expect(slackIdentityKey('T123', 'U456')).toBe('T123:U456');
  });

  it('does not collide across teams for the same user_id (the bug the composite key prevents)', () => {
    expect(slackIdentityKey('T-A', 'U-SAME')).not.toBe(slackIdentityKey('T-B', 'U-SAME'));
  });
});

describe('isSlackUserAllowed', () => {
  const baseConfig: SlackConfig = {
    display_name: 'test',
    channels: {},
    allowed_channels: ['C1'],
    allowed_users: ['T1:U1', 'T1:U2'],
  };

  it('true for a team_id+user_id pair in allowed_users', () => {
    expect(isSlackUserAllowed(baseConfig, 'T1', 'U1')).toBe(true);
  });

  it('false for a user_id not in allowed_users', () => {
    expect(isSlackUserAllowed(baseConfig, 'T1', 'U999')).toBe(false);
  });

  it('false when the user_id matches but the team_id does not (cross-workspace collision guard)', () => {
    expect(isSlackUserAllowed(baseConfig, 'T-OTHER', 'U1')).toBe(false);
  });

  it('fail-closed: false when allowed_users is empty', () => {
    expect(isSlackUserAllowed({ ...baseConfig, allowed_users: [] }, 'T1', 'U1')).toBe(false);
  });

  it('fail-closed: false when allowed_users is missing entirely', () => {
    const cfg = { ...baseConfig } as Partial<SlackConfig>;
    delete cfg.allowed_users;
    expect(isSlackUserAllowed(cfg as SlackConfig, 'T1', 'U1')).toBe(false);
  });
});
