import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getOperatorChatCreds } from '../../../src/daemon/index';

// Regression guard for GAP-0035 (2026-05-17 silent-failure audit). Before this
// fix, a UTF-8 BOM or missing BOT_TOKEN line on the first scanned agent's .env
// silently caused getOperatorChatCreds to return null — daemon's entire
// crash-loop Telegram alert pipeline went dark with no operator signal.

const BOM = '﻿';
const VALID_TOKEN = '123456789:ABCdefGHIjklMNOpqrSTUvwxYZ012345678';

function mkFrameworkRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cortextos-creds-'));
  return dir;
}

function writeAgentEnv(frameworkRoot: string, org: string, agent: string, content: string): void {
  const agentDir = join(frameworkRoot, 'orgs', org, 'agents', agent);
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, '.env'), content, 'utf-8');
}

describe('getOperatorChatCreds BOM + warn-on-skip behavior (GAP-0035)', () => {
  let frameworkRoot: string;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  const origChatEnv = process.env.CTX_OPERATOR_CHAT_ID;
  const origTokenEnv = process.env.CTX_OPERATOR_BOT_TOKEN;

  beforeEach(() => {
    frameworkRoot = mkFrameworkRoot();
    delete process.env.CTX_OPERATOR_CHAT_ID;
    delete process.env.CTX_OPERATOR_BOT_TOKEN;
    stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(frameworkRoot, { recursive: true, force: true });
    if (origChatEnv !== undefined) process.env.CTX_OPERATOR_CHAT_ID = origChatEnv;
    if (origTokenEnv !== undefined) process.env.CTX_OPERATOR_BOT_TOKEN = origTokenEnv;
    stderrSpy.mockRestore();
  });

  it('returns creds from a clean .env (baseline)', () => {
    writeAgentEnv(frameworkRoot, 'org1', 'agent1',
      `BOT_TOKEN=${VALID_TOKEN}\nCHAT_ID=999\n`);
    const creds = getOperatorChatCreds(frameworkRoot);
    expect(creds).toEqual({ chatId: '999', botToken: VALID_TOKEN });
  });

  it('returns creds from a .env that has a UTF-8 BOM prefix (GAP-0035 regression)', () => {
    writeAgentEnv(frameworkRoot, 'org1', 'agent1',
      `${BOM}BOT_TOKEN=${VALID_TOKEN}\nCHAT_ID=999\n`);
    const creds = getOperatorChatCreds(frameworkRoot);
    expect(creds).toEqual({ chatId: '999', botToken: VALID_TOKEN });
  });

  it('warns to stderr and skips when an agent .env is missing BOT_TOKEN', () => {
    writeAgentEnv(frameworkRoot, 'org1', 'broken', `CHAT_ID=999\n`);
    writeAgentEnv(frameworkRoot, 'org1', 'good',
      `BOT_TOKEN=${VALID_TOKEN}\nCHAT_ID=888\n`);
    const creds = getOperatorChatCreds(frameworkRoot);
    expect(creds).toEqual({ chatId: '888', botToken: VALID_TOKEN });
    const warnings = stderrSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(warnings).toContain('org1/broken');
    expect(warnings).toContain('BOT_TOKEN');
  });

  it('warns to stderr and continues when BOT_TOKEN format is invalid', () => {
    writeAgentEnv(frameworkRoot, 'org1', 'badtoken',
      `BOT_TOKEN=not-a-real-token\nCHAT_ID=999\n`);
    writeAgentEnv(frameworkRoot, 'org1', 'good',
      `BOT_TOKEN=${VALID_TOKEN}\nCHAT_ID=888\n`);
    const creds = getOperatorChatCreds(frameworkRoot);
    expect(creds).toEqual({ chatId: '888', botToken: VALID_TOKEN });
    const warnings = stderrSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(warnings).toContain('org1/badtoken');
    expect(warnings).toContain('BOT_TOKEN format invalid');
  });

  it('returns null and warns if no agent has usable creds (defensive)', () => {
    writeAgentEnv(frameworkRoot, 'org1', 'agent1', `CHAT_ID=999\n`);
    const creds = getOperatorChatCreds(frameworkRoot);
    expect(creds).toBeNull();
  });

  it('prefers CTX_OPERATOR_* env over .env scan when both set', () => {
    process.env.CTX_OPERATOR_CHAT_ID = '111';
    process.env.CTX_OPERATOR_BOT_TOKEN = VALID_TOKEN;
    writeAgentEnv(frameworkRoot, 'org1', 'agent1',
      `BOT_TOKEN=${VALID_TOKEN}\nCHAT_ID=999\n`);
    const creds = getOperatorChatCreds(frameworkRoot);
    expect(creds).toEqual({ chatId: '111', botToken: VALID_TOKEN });
  });
});
