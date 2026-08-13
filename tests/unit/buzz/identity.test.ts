import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  loadBuzzChannelConfig,
  loadBuzzSecretKey,
  loadBuzzConfig,
  isBuzzPubkeyAllowed,
  isBuzzChannelConfigured,
  type BuzzChannelConfig,
} from '../../../src/buzz/identity';

function makeAgentDir(root: string, name: string): string {
  const dir = join(root, 'orgs', 'test-org', 'agents', name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const VALID_KEY = 'a'.repeat(64);

describe('loadBuzzChannelConfig', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'buzz-id-'));
  });

  it('returns null when buzz.json is absent (Buzz disabled for this agent)', () => {
    const dir = makeAgentDir(root, 'no-buzz');
    expect(loadBuzzChannelConfig(dir)).toBeNull();
  });

  it('returns null when buzz.json is malformed JSON', () => {
    const dir = makeAgentDir(root, 'broken');
    writeFileSync(join(dir, 'buzz.json'), '{ not json');
    expect(loadBuzzChannelConfig(dir)).toBeNull();
  });

  it('returns null when pubkey is missing (required field)', () => {
    const dir = makeAgentDir(root, 'no-pubkey');
    writeFileSync(join(dir, 'buzz.json'), JSON.stringify({ display_name: 'x', channels: [], allowed_pubkeys: [] }));
    expect(loadBuzzChannelConfig(dir)).toBeNull();
  });

  it('loads a well-formed buzz.json', () => {
    const dir = makeAgentDir(root, 'ok');
    writeFileSync(join(dir, 'buzz.json'), JSON.stringify({
      pubkey: 'abc123',
      display_name: 'My Agent',
      channels: ['chan-1', 'chan-2'],
      allowed_pubkeys: ['sender-1'],
      relay_url: 'wss://relay.example.com',
    }));
    const config = loadBuzzChannelConfig(dir);
    expect(config).toEqual({
      pubkey: 'abc123',
      display_name: 'My Agent',
      channels: ['chan-1', 'chan-2'],
      allowed_pubkeys: ['sender-1'],
      relay_url: 'wss://relay.example.com',
    });
  });

  it('defaults channels/allowed_pubkeys to empty arrays when absent (fail-closed shape)', () => {
    const dir = makeAgentDir(root, 'minimal');
    writeFileSync(join(dir, 'buzz.json'), JSON.stringify({ pubkey: 'abc123' }));
    const config = loadBuzzChannelConfig(dir);
    expect(config?.channels).toEqual([]);
    expect(config?.allowed_pubkeys).toEqual([]);
  });

  it('filters out non-string entries from channels/allowed_pubkeys rather than throwing', () => {
    const dir = makeAgentDir(root, 'dirty');
    writeFileSync(join(dir, 'buzz.json'), JSON.stringify({
      pubkey: 'abc123',
      channels: ['good', 42, null],
      allowed_pubkeys: ['good', {}],
    }));
    const config = loadBuzzChannelConfig(dir);
    expect(config?.channels).toEqual(['good']);
    expect(config?.allowed_pubkeys).toEqual(['good']);
  });
});

describe('loadBuzzSecretKey', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'buzz-key-'));
  });

  it('returns undefined when .env is absent', () => {
    const dir = makeAgentDir(root, 'no-env');
    expect(loadBuzzSecretKey(dir)).toBeUndefined();
  });

  it('returns undefined when BUZZ_PRIVATE_KEY is not set in .env', () => {
    const dir = makeAgentDir(root, 'no-key');
    writeFileSync(join(dir, '.env'), 'OTHER_VAR=foo\n');
    expect(loadBuzzSecretKey(dir)).toBeUndefined();
  });

  it('extracts BUZZ_PRIVATE_KEY from .env', () => {
    const dir = makeAgentDir(root, 'has-key');
    writeFileSync(join(dir, '.env'), `OTHER_VAR=foo\nBUZZ_PRIVATE_KEY=${VALID_KEY}\n`);
    expect(loadBuzzSecretKey(dir)).toBe(VALID_KEY);
  });
});

describe('loadBuzzConfig', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'buzz-full-'));
  });

  it('returns null when buzz.json exists but BUZZ_PRIVATE_KEY does not (both required)', () => {
    const dir = makeAgentDir(root, 'partial');
    writeFileSync(join(dir, 'buzz.json'), JSON.stringify({ pubkey: 'abc', channels: [], allowed_pubkeys: [] }));
    expect(loadBuzzConfig(dir)).toBeNull();
  });

  it('returns null when the secret key is not valid 64-char hex (fail closed, not passed to signer)', () => {
    const dir = makeAgentDir(root, 'bad-key');
    writeFileSync(join(dir, 'buzz.json'), JSON.stringify({ pubkey: 'abc', channels: [], allowed_pubkeys: [] }));
    writeFileSync(join(dir, '.env'), 'BUZZ_PRIVATE_KEY=not-hex-at-all\n');
    expect(loadBuzzConfig(dir)).toBeNull();
  });

  it('returns the merged config when both buzz.json and a valid key are present', () => {
    const dir = makeAgentDir(root, 'complete');
    writeFileSync(join(dir, 'buzz.json'), JSON.stringify({ pubkey: 'abc', display_name: 'x', channels: ['c1'], allowed_pubkeys: ['p1'] }));
    writeFileSync(join(dir, '.env'), `BUZZ_PRIVATE_KEY=${VALID_KEY}\n`);
    const config = loadBuzzConfig(dir);
    expect(config?.secret_key).toBe(VALID_KEY);
    expect(config?.pubkey).toBe('abc');
  });
});

describe('isBuzzPubkeyAllowed', () => {
  const baseConfig: BuzzChannelConfig = {
    pubkey: 'agent-pubkey',
    display_name: 'test',
    channels: ['c1'],
    allowed_pubkeys: ['sender-1', 'Sender-2'],
  };

  it('true for an exact-case match', () => {
    expect(isBuzzPubkeyAllowed(baseConfig, 'sender-1')).toBe(true);
  });

  it('true for a case-insensitive match (hex pubkeys are sometimes pasted mixed-case)', () => {
    expect(isBuzzPubkeyAllowed(baseConfig, 'SENDER-1')).toBe(true);
    expect(isBuzzPubkeyAllowed(baseConfig, 'sender-2')).toBe(true);
  });

  it('false for a pubkey not in the allowlist', () => {
    expect(isBuzzPubkeyAllowed(baseConfig, 'stranger')).toBe(false);
  });

  it('fail-closed: false when allowed_pubkeys is empty', () => {
    expect(isBuzzPubkeyAllowed({ ...baseConfig, allowed_pubkeys: [] }, 'sender-1')).toBe(false);
  });

  it('fail-closed: false when allowed_pubkeys is missing entirely', () => {
    const cfg = { ...baseConfig } as Partial<BuzzChannelConfig>;
    delete cfg.allowed_pubkeys;
    expect(isBuzzPubkeyAllowed(cfg as BuzzChannelConfig, 'sender-1')).toBe(false);
  });
});

describe('isBuzzChannelConfigured', () => {
  const config: BuzzChannelConfig = {
    pubkey: 'agent-pubkey',
    display_name: 'test',
    channels: ['c1', 'c2'],
    allowed_pubkeys: [],
  };

  it('true when the channel is in the agent config', () => {
    expect(isBuzzChannelConfigured(config, 'c1')).toBe(true);
  });

  it('false when the channel is not configured', () => {
    expect(isBuzzChannelConfigured(config, 'c-unknown')).toBe(false);
  });
});
