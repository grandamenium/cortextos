/**
 * UTF-8 BOM handling utilities for cortextOS.
 *
 * PowerShell `Out-File` / `Set-Content` and many Windows editors (Notepad,
 * older VS Code configs) write text files with a 3-byte UTF-8 BOM (EF BB BF /
 * U+FEFF). Any regex with `^` anchor or `JSON.parse` call run against such
 * a file will silently fail at column 0 because position 0 is a BOM byte,
 * not the expected character. This caused the 2026-05-16 "smith silent
 * Telegram" production incident — 3h debugging traced to one BOM byte in
 * `.env` that broke `/^BOT_TOKEN=/m`.
 *
 * Apply `stripBom` to ALL text reads of operator-editable files (.env,
 * .json, .yaml, .toml, .md if parsed). Reads of files cortextOS itself
 * generates can skip this — but the marginal cost is so low that the
 * default should be "always strip BOM on read."
 */

import { readFileSync } from 'fs';

/**
 * Strip a leading UTF-8 BOM (U+FEFF) if present.
 *
 * Fast path: a single `charCodeAt(0)` check, no allocation when no BOM.
 *
 * Note: a file with multiple stacked BOMs (`﻿﻿...`) is corrupted
 * and outside our supported input domain. We strip exactly one and pass
 * the rest through — downstream parsers will surface the residual BOM as
 * a parse error, which is the right outcome for genuinely corrupt input.
 */
export function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/**
 * Drop-in replacement for `readFileSync(path, 'utf-8')` that strips a
 * leading BOM. Use this everywhere a UTF-8 text file is read for parsing,
 * pattern matching, or splitting on `^`-anchored regex.
 *
 * Example:
 *   // BEFORE (vulnerable to BOM):
 *   const env = readFileSync(envPath, 'utf-8');
 *   // AFTER:
 *   const env = readFileTextStripped(envPath);
 */
export function readFileTextStripped(path: string): string {
  return stripBom(readFileSync(path, 'utf-8'));
}
