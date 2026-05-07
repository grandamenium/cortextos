import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { councilCommand } from '../../../src/cli/council';

describe('council review criteria-quality', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes concrete criteria with pinned validation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'council-good-'));
    const target = join(dir, '.goal-context.md');
    writeFileSync(target, [
      '# Goal: x',
      '',
      '## Success criteria',
      "- [ ] hello() returns 'world'",
      '',
      '## Validation',
      'pytest',
      '',
    ].join('\n'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await councilCommand.parseAsync(['node', 'council', 'review', '--target', target, '--rubric', 'criteria-quality']);

    const output = JSON.parse(String(logSpy.mock.calls[0][0]));
    expect(output.passed).toBe(true);
    expect(output.findings).toEqual([]);
  });

  it('rejects filtered pytest and test deletion criteria as critical', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'council-bad-'));
    const target = join(dir, '.goal-context.md');
    writeFileSync(target, [
      '# Goal: x',
      '',
      '## Success criteria',
      '- [ ] pass by deleting tests',
      '',
      '## Validation',
      'pytest -k "not slow"',
      '',
    ].join('\n'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__TEST_PROCESS_EXIT_${code}__`);
    }) as never);

    await expect(
      councilCommand.parseAsync(['node', 'council', 'review', '--target', target, '--rubric', 'criteria-quality'])
    ).rejects.toThrow(/__TEST_PROCESS_EXIT_2__/);

    expect(exitSpy).toHaveBeenCalledWith(2);
  });
});
