import { stripControlChars } from './validate.js';

/**
 * Neutralise untrusted text before embedding it in (or near) a ```-fenced block
 * that is injected into an agent's PTY (see src/daemon/fast-checker.ts).
 *
 * Vectors closed:
 *  1. Terminal control injection — stripControlChars() removes ANSI CSI/OSC/ESC
 *     sequences and C0 control bytes + DEL; we additionally drop \r (a PTY
 *     line-overwrite primitive it keeps) and the C1 control range (U+0080-009F)
 *     it does not cover.
 *  2. Fence breakout — a triple-backtick run closes the surrounding fence, so
 *     text after it is read by the agent as prompt input. We insert a zero-width
 *     space between backticks in any run of 2+, so no run of three survives,
 *     while leaving single-backtick inline code (a run of one) intact.
 */
// Built from char codes so no literal control/zero-width bytes live in source.
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
const CARRIAGE_RETURN = new RegExp(String.fromCharCode(0x0d), 'g');
const C1_CONTROLS = new RegExp(
  '[' + String.fromCharCode(0x80) + '-' + String.fromCharCode(0x9f) + ']',
  'g',
);

export function sanitizeForPtyFence(text: string): string {
  return stripControlChars(text)
    .replace(CARRIAGE_RETURN, '')
    .replace(C1_CONTROLS, '')
    .replace(/`{2,}/g, (run) => run.split('').join(ZERO_WIDTH_SPACE));
}
