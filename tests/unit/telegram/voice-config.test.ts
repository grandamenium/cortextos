import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  resolveAgentVoice,
  resolveReadAloudVoice,
  resolveAgentVoiceModel,
  resolveAgentVoiceSpeed,
} from '../../../src/telegram/voice-config';

let tmpRoot: string;
let agentDir: string;
let orgDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cortextos-voicecfg-'));
  orgDir = join(tmpRoot, 'orgs', 'test-org');
  agentDir = join(orgDir, 'agents', 'atlas');
  mkdirSync(agentDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('resolveAgentVoice', () => {
  it('returns agent config.json voice when present', () => {
    writeFileSync(
      join(agentDir, 'config.json'),
      JSON.stringify({ agent_name: 'atlas', voice: 'cedar' }),
    );
    expect(resolveAgentVoice({ agentName: 'atlas', agentDir, orgDir })).toBe('cedar');
  });

  it('trims whitespace on the agent config voice value', () => {
    writeFileSync(
      join(agentDir, 'config.json'),
      JSON.stringify({ voice: '  alloy  ' }),
    );
    expect(resolveAgentVoice({ agentName: 'atlas', agentDir, orgDir })).toBe('alloy');
  });

  it('falls back to org voices.json when agent config has no voice', () => {
    writeFileSync(join(agentDir, 'config.json'), JSON.stringify({ agent_name: 'atlas' }));
    writeFileSync(
      join(orgDir, 'voices.json'),
      JSON.stringify({ atlas: 'fable', sage: 'onyx' }),
    );
    expect(resolveAgentVoice({ agentName: 'atlas', agentDir, orgDir })).toBe('fable');
  });

  it('org voices.json lookup is case-insensitive on agent name', () => {
    writeFileSync(join(orgDir, 'voices.json'), JSON.stringify({ atlas: 'cedar' }));
    expect(resolveAgentVoice({ agentName: 'ATLAS', orgDir })).toBe('cedar');
    expect(resolveAgentVoice({ agentName: 'Atlas', orgDir })).toBe('cedar');
  });

  it('passes a future/unknown voice name through unchanged', () => {
    writeFileSync(
      join(agentDir, 'config.json'),
      JSON.stringify({ voice: 'futurevoice' }),
    );
    expect(resolveAgentVoice({ agentName: 'atlas', agentDir, orgDir })).toBe('futurevoice');
  });

  it('returns null when no layer declares a voice', () => {
    writeFileSync(join(agentDir, 'config.json'), JSON.stringify({ agent_name: 'atlas' }));
    expect(resolveAgentVoice({ agentName: 'atlas', agentDir, orgDir })).toBeNull();
  });

  it('returns null when agentName is empty', () => {
    expect(resolveAgentVoice({ agentName: '', agentDir, orgDir })).toBeNull();
    expect(resolveAgentVoice({ agentName: '   ', agentDir, orgDir })).toBeNull();
  });

  it('skips malformed agent config.json and falls through', () => {
    writeFileSync(join(agentDir, 'config.json'), '{ not valid json ');
    writeFileSync(join(orgDir, 'voices.json'), JSON.stringify({ atlas: 'alloy' }));
    expect(resolveAgentVoice({ agentName: 'atlas', agentDir, orgDir })).toBe('alloy');
  });

  it('skips malformed org voices.json and returns null', () => {
    writeFileSync(join(agentDir, 'config.json'), JSON.stringify({ voice: '' }));
    writeFileSync(join(orgDir, 'voices.json'), '{ also not valid');
    expect(resolveAgentVoice({ agentName: 'atlas', agentDir, orgDir })).toBeNull();
  });

  it('agent config takes precedence over org voices.json when both present', () => {
    writeFileSync(
      join(agentDir, 'config.json'),
      JSON.stringify({ voice: 'cedar' }),
    );
    writeFileSync(
      join(orgDir, 'voices.json'),
      JSON.stringify({ atlas: 'alloy' }),
    );
    expect(resolveAgentVoice({ agentName: 'atlas', agentDir, orgDir })).toBe('cedar');
  });

  it('works when agentDir is not provided (org-only resolution)', () => {
    writeFileSync(join(orgDir, 'voices.json'), JSON.stringify({ atlas: 'alloy' }));
    expect(resolveAgentVoice({ agentName: 'atlas', orgDir })).toBe('alloy');
  });

  it('works when orgDir is not provided (agent-only resolution)', () => {
    writeFileSync(
      join(agentDir, 'config.json'),
      JSON.stringify({ voice: 'cedar' }),
    );
    expect(resolveAgentVoice({ agentName: 'atlas', agentDir })).toBe('cedar');
  });

  it('returns null when neither agentDir nor orgDir is provided', () => {
    expect(resolveAgentVoice({ agentName: 'atlas' })).toBeNull();
  });
});

describe('resolveReadAloudVoice', () => {
  it('returns the _read_aloud entry from org voices.json', () => {
    writeFileSync(
      join(orgDir, 'voices.json'),
      JSON.stringify({ atlas: 'cedar', _read_aloud: 'fable' }),
    );
    expect(resolveReadAloudVoice(orgDir)).toBe('fable');
  });

  it('returns null when _read_aloud is missing', () => {
    writeFileSync(
      join(orgDir, 'voices.json'),
      JSON.stringify({ atlas: 'cedar' }),
    );
    expect(resolveReadAloudVoice(orgDir)).toBeNull();
  });

  it('returns null when voices.json does not exist', () => {
    expect(resolveReadAloudVoice(orgDir)).toBeNull();
  });

  it('returns null when orgDir is undefined', () => {
    expect(resolveReadAloudVoice(undefined)).toBeNull();
  });

  it('skips malformed voices.json', () => {
    writeFileSync(join(orgDir, 'voices.json'), 'not json');
    expect(resolveReadAloudVoice(orgDir)).toBeNull();
  });
});

describe('resolveAgentVoiceModel', () => {
  it('defaults to tts-1 when no agent config is present', () => {
    expect(resolveAgentVoiceModel(agentDir)).toBe('tts-1');
  });

  it('defaults to tts-1 when agentDir is undefined', () => {
    expect(resolveAgentVoiceModel(undefined)).toBe('tts-1');
  });

  it('returns the voice_model from agent config when set', () => {
    writeFileSync(
      join(agentDir, 'config.json'),
      JSON.stringify({ voice_model: 'tts-1-hd' }),
    );
    expect(resolveAgentVoiceModel(agentDir)).toBe('tts-1-hd');
  });

  it('falls back to tts-1 when voice_model is empty string', () => {
    writeFileSync(
      join(agentDir, 'config.json'),
      JSON.stringify({ voice_model: '' }),
    );
    expect(resolveAgentVoiceModel(agentDir)).toBe('tts-1');
  });

  it('falls back to tts-1 when config.json is malformed', () => {
    writeFileSync(join(agentDir, 'config.json'), '{ not json');
    expect(resolveAgentVoiceModel(agentDir)).toBe('tts-1');
  });
});

describe('resolveAgentVoiceSpeed', () => {
  it('defaults to 1.0 when no agent config is present', () => {
    expect(resolveAgentVoiceSpeed(agentDir)).toBe(1.0);
  });

  it('defaults to 1.0 when agentDir is undefined', () => {
    expect(resolveAgentVoiceSpeed(undefined)).toBe(1.0);
  });

  it('returns the voice_speed from agent config when in range', () => {
    writeFileSync(
      join(agentDir, 'config.json'),
      JSON.stringify({ voice_speed: 1.1 }),
    );
    expect(resolveAgentVoiceSpeed(agentDir)).toBe(1.1);
  });

  it('accepts values at the boundaries 0.25 and 4.0', () => {
    writeFileSync(join(agentDir, 'config.json'), JSON.stringify({ voice_speed: 0.25 }));
    expect(resolveAgentVoiceSpeed(agentDir)).toBe(0.25);
    writeFileSync(join(agentDir, 'config.json'), JSON.stringify({ voice_speed: 4.0 }));
    expect(resolveAgentVoiceSpeed(agentDir)).toBe(4.0);
  });

  it('falls back to 1.0 when voice_speed is out of range', () => {
    writeFileSync(join(agentDir, 'config.json'), JSON.stringify({ voice_speed: 5.0 }));
    expect(resolveAgentVoiceSpeed(agentDir)).toBe(1.0);
    writeFileSync(join(agentDir, 'config.json'), JSON.stringify({ voice_speed: 0.1 }));
    expect(resolveAgentVoiceSpeed(agentDir)).toBe(1.0);
  });

  it('falls back to 1.0 when voice_speed is not a number', () => {
    writeFileSync(join(agentDir, 'config.json'), JSON.stringify({ voice_speed: '1.1' }));
    expect(resolveAgentVoiceSpeed(agentDir)).toBe(1.0);
    writeFileSync(join(agentDir, 'config.json'), JSON.stringify({ voice_speed: null }));
    expect(resolveAgentVoiceSpeed(agentDir)).toBe(1.0);
  });

  it('falls back to 1.0 when config.json is malformed', () => {
    writeFileSync(join(agentDir, 'config.json'), '{ not json');
    expect(resolveAgentVoiceSpeed(agentDir)).toBe(1.0);
  });
});
