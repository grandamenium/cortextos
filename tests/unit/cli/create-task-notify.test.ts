/**
 * tests/unit/cli/create-task-notify.test.ts — #513
 *
 * The assignee inbox notification for create-task used to silently mid-word
 * truncate the description at 120 chars (opts.desc.slice(0, 120)) with no
 * marker. formatTaskAssignmentMessage builds the notification and, when it must
 * shorten a long description, appends a clear marker pointing at the full task.
 */

import { describe, it, expect } from 'vitest';
import { formatTaskAssignmentMessage } from '../../../src/cli/bus.js';

describe('formatTaskAssignmentMessage (#513)', () => {
  it('includes a short description verbatim with no truncation marker', () => {
    const msg = formatTaskAssignmentMessage({
      priority: 'high',
      title: 'spec task',
      desc: 'short and sweet',
      taskId: 't-1',
    });
    expect(msg).toBe('Task assigned: [high] spec task — short and sweet (id: t-1)');
    expect(msg).not.toMatch(/truncated/i);
  });

  it('omits the description segment entirely when no desc is given', () => {
    const msg = formatTaskAssignmentMessage({
      priority: 'normal',
      title: 'no desc',
      taskId: 't-2',
    });
    expect(msg).toBe('Task assigned: [normal] no desc (id: t-2)');
    expect(msg).not.toContain(' — ');
  });

  it('previews ~500 chars (not the old 120 clip) and marks long descriptions', () => {
    const longDesc = 'x'.repeat(900); // no spaces → no word-boundary back-off
    const msg = formatTaskAssignmentMessage({
      priority: 'urgent',
      title: 'big',
      desc: longDesc,
      taskId: 't-3',
    });
    // Retains the 500-char preview (proves it's not the old 120-char clip)...
    expect(msg).toContain('x'.repeat(500));
    // ...and tells the agent it was shortened + where to read the rest.
    expect(msg).toMatch(/truncated/i);
    expect(msg).toMatch(/list-tasks --format json/);
    expect(msg).toContain('(id: t-3)');
  });

  it('backs off to a word boundary and never splits a grapheme', () => {
    // 600 two-char words → well over the limit, with spaces to trim on.
    const longDesc = Array.from({ length: 600 }, () => 'ab').join(' ');
    const msg = formatTaskAssignmentMessage({ priority: 'low', title: 't', desc: longDesc, taskId: 't-4' });
    const preview = msg.slice(msg.indexOf(' — ') + 3, msg.indexOf('… [truncated'));
    // Trimmed at a space → no dangling partial word.
    expect(preview.endsWith(' ')).toBe(false);
    expect(preview).not.toMatch(/\sa$/); // not cut mid-"ab"

    // Emoji (surrogate pair) right at the boundary must not be cut in half.
    const emojiDesc = '😀'.repeat(600); // 1200 UTF-16 units, 600 code points
    const emojiMsg = formatTaskAssignmentMessage({ priority: 'low', title: 't', desc: emojiDesc, taskId: 't-5' });
    expect(emojiMsg).not.toContain('�'); // no replacement char from a split pair
    expect(emojiMsg).toContain('😀'.repeat(500)); // exactly the 500-code-point preview retained
  });
});
