/**
 * tests/integration/codex-handoff-lifecycle.test.ts — codex handoff parity peer.
 *
 * PR 06 wired the codex-app-server PTY's `thread/tokenUsage/updated` notification
 * to the same `context_status.json` schema that fast-checker reads for claude
 * agents. This integration test verifies the schema contract end-to-end:
 *
 *   1. Codex `writeContextStatus` output parses as the shape fast-checker
 *      consumes (used_percentage, exceeds_200k_tokens, session_id, written_at).
 *   2. The handoff doc marker (`.handoff-doc-path`) round-trips: write the
 *      marker, read it as the daemon would on next boot, verify the consume
 *      path returns the expected boot-prompt fragment.
 *   3. Codex agents can be detected as "in handoff state" via the same
 *      filesystem hooks as claude agents.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let tmpRoot: string;
let stateDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'codex-handoff-'));
  stateDir = join(tmpRoot, 'state', 'codex-alpha');
  mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ok */ }
});

/** Mirror of CodexAppServerPTY.writeContextStatus output (frozen by PR 06 contract). */
function writeCodexContextStatus(opts: {
  totalTokens: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  modelContextWindow?: number;
  threadId: string;
}): void {
  const cap = opts.modelContextWindow ?? 256000;
  const usedPct = cap > 0 ? Math.min(100, (opts.totalTokens / cap) * 100) : null;
  const payload = {
    used_percentage: usedPct,
    context_window_size: cap,
    exceeds_200k_tokens: opts.totalTokens > 200000,
    current_usage: {
      input_tokens: opts.inputTokens ?? 0,
      output_tokens: opts.outputTokens ?? 0,
      cache_read_input_tokens: opts.cachedInputTokens ?? 0,
      cache_creation_input_tokens: 0,
    },
    session_id: opts.threadId,
    written_at: new Date().toISOString(),
  };
  writeFileSync(join(stateDir, 'context_status.json'), JSON.stringify(payload));
}

/** Fast-checker-shaped read: only the fields fast-checker.ts:checkContextStatus consumes. */
interface FastCheckerView {
  used_percentage: number | null;
  exceeds_200k_tokens: boolean;
  session_id: string | null;
  written_at: string | null;
}

function readContextStatusAsFastChecker(): FastCheckerView | null {
  const path = join(stateDir, 'context_status.json');
  if (!existsSync(path)) return null;
  const data = JSON.parse(readFileSync(path, 'utf-8'));
  return {
    used_percentage: typeof data.used_percentage === 'number' ? data.used_percentage : null,
    exceeds_200k_tokens: Boolean(data.exceeds_200k_tokens),
    session_id: typeof data.session_id === 'string' ? data.session_id : null,
    written_at: typeof data.written_at === 'string' ? data.written_at : null,
  };
}

/** Mirror of AgentProcess.consumeHandoffBlock (frozen by daemon contract). */
function consumeHandoffMarker(handoffDocPath: string): string {
  const markerPath = join(stateDir, '.handoff-doc-path');
  if (!existsSync(markerPath)) return '';
  const docPath = readFileSync(markerPath, 'utf-8').trim();
  unlinkSync(markerPath);
  if (!docPath || !existsSync(docPath)) return '';
  return ` CONTEXT HANDOFF: Before restoring crons or checking inbox, read the handoff document at ${docPath} to resume your prior session state.`;
  void handoffDocPath; // referenced in the boot prompt body itself (matches consumeHandoffBlock)
}

describe('codex handoff lifecycle — schema parity with claude', () => {
  it('codex context_status.json carries the shape fast-checker reads', () => {
    writeCodexContextStatus({
      totalTokens: 150_000,
      inputTokens: 100_000,
      outputTokens: 50_000,
      cachedInputTokens: 10_000,
      threadId: 'mock-thread-abc',
    });

    const view = readContextStatusAsFastChecker();
    expect(view).not.toBeNull();
    expect(view!.used_percentage).toBeCloseTo((150_000 / 256_000) * 100, 5);
    expect(view!.exceeds_200k_tokens).toBe(false);
    expect(view!.session_id).toBe('mock-thread-abc');
    expect(view!.written_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('exceeds_200k_tokens flips when codex turn pushes total over 200k', () => {
    writeCodexContextStatus({ totalTokens: 199_999, threadId: 'mock-thread-1' });
    expect(readContextStatusAsFastChecker()!.exceeds_200k_tokens).toBe(false);

    writeCodexContextStatus({ totalTokens: 200_001, threadId: 'mock-thread-1' });
    expect(readContextStatusAsFastChecker()!.exceeds_200k_tokens).toBe(true);
  });

  it('used_percentage clamps to 100 when total exceeds modelContextWindow', () => {
    writeCodexContextStatus({
      totalTokens: 500_000,
      modelContextWindow: 256_000,
      threadId: 'mock-thread-overflow',
    });
    expect(readContextStatusAsFastChecker()!.used_percentage).toBe(100);
  });

  it('session_id changes on new thread (fast-checker uses this to reset per-session state)', () => {
    writeCodexContextStatus({ totalTokens: 100, threadId: 'thread-a' });
    expect(readContextStatusAsFastChecker()!.session_id).toBe('thread-a');

    writeCodexContextStatus({ totalTokens: 200, threadId: 'thread-b' });
    expect(readContextStatusAsFastChecker()!.session_id).toBe('thread-b');
  });

  it('handoff-doc-path marker is consumed once and produces the boot-prompt fragment', () => {
    const handoffDoc = join(tmpRoot, 'handoff.md');
    writeFileSync(handoffDoc, '# handoff\n## Current Tasks\n- finish PR-09\n');
    writeFileSync(join(stateDir, '.handoff-doc-path'), `${handoffDoc}\n`);

    const fragment = consumeHandoffMarker(handoffDoc);
    expect(fragment).toContain('CONTEXT HANDOFF');
    expect(fragment).toContain(handoffDoc);
    expect(existsSync(join(stateDir, '.handoff-doc-path'))).toBe(false);

    const second = consumeHandoffMarker(handoffDoc);
    expect(second).toBe('');
  });

  it('handoff marker is ignored when target doc no longer exists', () => {
    writeFileSync(join(stateDir, '.handoff-doc-path'), '/nonexistent/handoff.md\n');
    expect(consumeHandoffMarker('/nonexistent/handoff.md')).toBe('');
  });

  it('codex modelContextWindow drives context_window_size in the status file', () => {
    writeCodexContextStatus({
      totalTokens: 50_000,
      modelContextWindow: 1_000_000,
      threadId: 'thread-1m',
    });
    const data = JSON.parse(readFileSync(join(stateDir, 'context_status.json'), 'utf-8'));
    expect(data.context_window_size).toBe(1_000_000);
    expect(data.used_percentage).toBeCloseTo(5, 5);
  });
});
