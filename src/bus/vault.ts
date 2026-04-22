import {
  closeSync,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'path';
import { randomBytes } from 'crypto';
import { ensureDir } from '../utils/atomic.js';

/**
 * Max source file size accepted by publishToVault. 10 MB.
 * Vault is for strategic markdown / text, not binaries or dataset dumps.
 */
export const MAX_SOURCE_BYTES = 10 * 1024 * 1024;

/**
 * Bytes scanned for NUL-byte binary heuristic. Matches `git`'s default.
 */
const BINARY_SCAN_BYTES = 8000;

export interface PublishToVaultOptions {
  /** Absolute path to the source file being published. */
  sourcePath: string;
  /**
   * Target subdirectory *under* `vaultRoot`, forward-slash separated.
   * Auto-created if missing. Must be relative and must not escape the vault.
   */
  vaultDir: string;
  /** Absolute path to the Obsidian Vault root. Must exist. */
  vaultRoot: string;
  /** Agent publishing the file (goes into frontmatter + tags). */
  agentName: string;
  /**
   * Optional task ID. If provided:
   *   - validated against `taskDir` (if `taskDir` is given) — must exist.
   *   - injected as `source_task` in frontmatter.
   *   - appended as `Source: [[<task_id>]]` wikilink in the body.
   */
  taskId?: string;
  /** Optional absolute path to the `tasks/` directory, used to verify taskId. */
  taskDir?: string;
  /** Optional one-liner that lands in frontmatter `summary:`. */
  summary?: string;
  /** Optional extra tags appended to the default tag set. */
  tags?: string[];
  /** Optional injected clock — used by tests for deterministic filenames. */
  now?: Date;
}

export interface PublishToVaultResult {
  /** Absolute path of the published file inside the vault. */
  published_to: string;
  /** Bytes written (final file size, including injected frontmatter). */
  bytes: number;
  /** Task ID that was linked, or null if none was supplied. */
  task_id: string | null;
  /** Absolute source path that was published. */
  source_path: string;
}

const AGENT_NAME_REGEX = /^[a-z0-9_-]+$/;
const TASK_ID_REGEX = /^[A-Za-z0-9_-]+$/;
const DATE_PREFIX_REGEX = /^\d{4}-\d{2}-\d{2}-/;
const FILENAME_REGEX = /^[A-Za-z0-9._-][A-Za-z0-9. _-]*$/;

/**
 * Publish a markdown / text file into Logan's Obsidian Vault with provenance
 * frontmatter and an optional wikilink back to the originating task.
 *
 * Safety posture (hardened against adversarial inputs):
 *   - `vaultDir` rejected if absolute, if it contains `..`, backslashes, or
 *     NUL bytes. Resolved target is verified to stay under `realpath(vaultRoot)`.
 *   - `sourcePath` must be a regular file (no directories, FIFOs, sockets).
 *     Symlinks are resolved and the real target must also be a regular file.
 *   - Size capped at {@link MAX_SOURCE_BYTES}.
 *   - Binary heuristic (NUL byte in first 8 KB) rejects non-text payloads.
 *   - Filename derived from `basename(sourcePath)` and sanitized.
 *   - Filename collisions resolved via `-v2`, `-v3`, … — never overwrites.
 *   - Target file written atomically via temp-file + rename.
 *
 * Returns structured result; caller is responsible for event logging + stdout.
 */
export function publishToVault(
  options: PublishToVaultOptions,
): PublishToVaultResult {
  const {
    sourcePath,
    vaultDir,
    vaultRoot,
    agentName,
    taskId,
    taskDir,
    summary,
    tags = [],
    now = new Date(),
  } = options;

  if (!agentName || !AGENT_NAME_REGEX.test(agentName)) {
    throw new Error(
      `Invalid agent name '${agentName}'. Must match [a-z0-9_-]+.`,
    );
  }
  if (taskId !== undefined && !TASK_ID_REGEX.test(taskId)) {
    throw new Error(
      `Invalid task ID '${taskId}'. Must match [A-Za-z0-9_-]+.`,
    );
  }

  const canonicalVaultRoot = canonicalizeVaultRoot(vaultRoot);
  const safeVaultDir = normalizeVaultDir(vaultDir);
  const targetDir = safeVaultDir
    ? join(canonicalVaultRoot, safeVaultDir)
    : canonicalVaultRoot;

  ensureDir(targetDir);
  assertInsideVault(targetDir, canonicalVaultRoot);

  if (taskId !== undefined) {
    // Require taskDir whenever a taskId is supplied so we never write
    // fabricated provenance (source_task pointing at a non-existent task).
    if (!taskDir) {
      throw new Error(
        'taskId requires taskDir for existence validation (refusing to record fabricated provenance).',
      );
    }
    const taskFile = join(taskDir, `${taskId}.json`);
    if (!existsSync(taskFile)) {
      throw new Error(`Task not found: ${taskId} (looked at ${taskFile})`);
    }
    // Defend against a planted directory / symlink / FIFO named `<id>.json`.
    const taskStat = lstatSync(taskFile);
    if (!taskStat.isFile()) {
      throw new Error(
        `Task file is not a regular file: ${taskFile}`,
      );
    }
  }

  const sourceBuffer = readSourceFile(sourcePath);
  const sourceText = sourceBuffer.toString('utf-8');

  const originalName = sanitizeFilename(basename(sourcePath));
  const datedName = applyDatePrefix(originalName, now);

  const { frontmatter: existingFm, body } = splitFrontmatter(sourceText);

  const mergedFm = buildFrontmatter({
    existing: existingFm,
    agentName,
    taskId,
    sourcePath,
    summary,
    extraTags: tags,
    vaultDirTag: safeVaultDir,
    now,
  });

  const finalBody = taskId
    ? ensureTaskWikilink(body, taskId)
    : body;

  const finalContent = `${mergedFm}\n${finalBody}`.replace(/\n+$/, '\n');

  // Collision-safe atomic write: try candidate names in order, using a
  // create-or-fail primitive (linkSync) so two concurrent publishers never
  // clobber each other even if they observed the same `existsSync` result.
  const targetPath = writeCollisionSafe({
    targetDir,
    desiredName: datedName,
    content: finalContent,
    canonicalVaultRoot,
  });

  const bytes = statSync(targetPath).size;

  return {
    published_to: targetPath,
    bytes,
    task_id: taskId ?? null,
    source_path: sourcePath,
  };
}

function canonicalizeVaultRoot(vaultRoot: string): string {
  if (!vaultRoot || !isAbsolute(vaultRoot)) {
    throw new Error(
      `Vault root must be an absolute path. Got: ${vaultRoot || '(empty)'}`,
    );
  }
  if (!existsSync(vaultRoot)) {
    throw new Error(`Vault root does not exist: ${vaultRoot}`);
  }
  const real = realpathSync(vaultRoot);
  const stat = statSync(real);
  if (!stat.isDirectory()) {
    throw new Error(`Vault root is not a directory: ${vaultRoot}`);
  }
  return real;
}

function normalizeVaultDir(vaultDir: string | undefined): string {
  if (vaultDir === undefined || vaultDir === null || vaultDir === '') return '';
  if (typeof vaultDir !== 'string') {
    throw new Error('vaultDir must be a string.');
  }
  if (vaultDir.includes('\0')) {
    throw new Error('vaultDir contains a NUL byte.');
  }
  if (isAbsolute(vaultDir)) {
    throw new Error(
      `vaultDir must be relative to the vault root. Got absolute: ${vaultDir}`,
    );
  }
  // Normalize to forward slashes, strip leading/trailing slashes.
  const normalized = vaultDir
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  if (!normalized) return '';
  const parts = normalized.split('/');
  for (const part of parts) {
    if (part === '..' || part === '.') {
      throw new Error(
        `vaultDir segment '${part}' is not allowed (traversal).`,
      );
    }
    if (!part) {
      throw new Error('vaultDir contains an empty segment.');
    }
  }
  return parts.join('/');
}

function assertInsideVault(candidate: string, canonicalVaultRoot: string): void {
  // Use realpath where possible so a symlink planted inside the vault cannot
  // trampoline the write outside. We resolve the deepest existing ancestor.
  const resolved = resolveExistingAncestor(candidate);
  const rootWithSep = canonicalVaultRoot.endsWith(sep)
    ? canonicalVaultRoot
    : canonicalVaultRoot + sep;
  if (resolved !== canonicalVaultRoot && !resolved.startsWith(rootWithSep)) {
    throw new Error(
      `Refusing to write outside the vault. Target resolved to: ${resolved}`,
    );
  }
}

function resolveExistingAncestor(abs: string): string {
  let cur = resolve(abs);
  while (cur && !existsSync(cur)) {
    const parent = resolve(cur, '..');
    if (parent === cur) break;
    cur = parent;
  }
  try {
    return realpathSync(cur);
  } catch {
    return cur;
  }
}

function readSourceFile(sourcePath: string): Buffer {
  if (!sourcePath || !isAbsolute(sourcePath)) {
    throw new Error(
      `sourcePath must be an absolute path. Got: ${sourcePath || '(empty)'}`,
    );
  }
  if (!existsSync(sourcePath)) {
    throw new Error(`Source file not found: ${sourcePath}`);
  }

  // Pre-flight with lstat so we never openSync() a FIFO / device / socket
  // (which can block indefinitely) and so we can validate the link target
  // before we follow it.
  const linkStat = lstatSync(sourcePath);
  if (linkStat.isSymbolicLink()) {
    const real = realpathSync(sourcePath);
    const realStat = statSync(real);
    if (!realStat.isFile()) {
      throw new Error(
        `Source symlink does not point to a regular file: ${sourcePath}`,
      );
    }
  } else if (!linkStat.isFile()) {
    throw new Error(`Source is not a regular file: ${sourcePath}`);
  }

  // Single open → fstat (same inode) → bounded read → close. A symlink
  // swap after the lstat/realpath check above cannot affect this fd; the
  // kernel bound the fd to the target at open() time.
  const fd = openSync(sourcePath, 'r');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error(`Source is not a regular file: ${sourcePath}`);
    }
    if (stat.size > MAX_SOURCE_BYTES) {
      throw new Error(
        `Source file exceeds size cap (${stat.size} > ${MAX_SOURCE_BYTES} bytes): ${sourcePath}`,
      );
    }
    // Cap the allocation at MAX + 1 so a file that grew after fstat can't
    // exhaust memory — we'll detect the overflow and reject.
    const bufSize = Math.min(stat.size, MAX_SOURCE_BYTES + 1);
    const buf = Buffer.alloc(bufSize);
    let read = 0;
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, read);
      if (n === 0) break;
      read += n;
    }
    if (read > MAX_SOURCE_BYTES) {
      throw new Error(
        `Source file grew past the size cap during read: ${sourcePath}`,
      );
    }
    const payload = buf.subarray(0, read);
    const scanLen = Math.min(payload.length, BINARY_SCAN_BYTES);
    for (let i = 0; i < scanLen; i++) {
      if (payload[i] === 0) {
        throw new Error(
          `Source file appears to be binary (NUL byte at offset ${i}): ${sourcePath}`,
        );
      }
    }
    return Buffer.from(payload);
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}

function sanitizeFilename(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Source filename is empty.');
  if (trimmed.includes('\0')) throw new Error('Source filename contains NUL byte.');
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    throw new Error(`Source filename contains path separator: ${name}`);
  }
  if (trimmed === '.' || trimmed === '..' || trimmed.startsWith('..')) {
    throw new Error(`Source filename is not allowed: ${name}`);
  }
  if (!FILENAME_REGEX.test(trimmed)) {
    throw new Error(
      `Source filename contains unsafe characters: ${name}. Allowed: letters, digits, space, dot, underscore, hyphen.`,
    );
  }
  return trimmed;
}

function applyDatePrefix(name: string, now: Date): string {
  if (DATE_PREFIX_REGEX.test(name)) return name;
  const date = now.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  return `${date}-${name}`;
}

function candidateFilename(desired: string, n: number): string {
  if (n === 0) return desired;
  const ext = extname(desired);
  const stem = ext ? desired.slice(0, -ext.length) : desired;
  return `${stem}-v${n + 1}${ext}`;
}

/**
 * Write `content` to a fresh file inside `targetDir`. Candidate filenames
 * are tried in order (desired, desired-v2, desired-v3, ...). Each candidate
 * is claimed via a temp-file + `linkSync` — `link(2)` fails with EEXIST when
 * the target already exists, which closes the TOCTOU window that plain
 * `existsSync` + `rename` leaves open. On collision, the temp is cleaned up
 * and the next candidate is tried. Returns the successful absolute path.
 */
function writeCollisionSafe(args: {
  targetDir: string;
  desiredName: string;
  content: string;
  canonicalVaultRoot: string;
}): string {
  const { targetDir, desiredName, content, canonicalVaultRoot } = args;
  const maxAttempts = 10_000;
  for (let n = 0; n < maxAttempts; n++) {
    const name = candidateFilename(desiredName, n);
    const targetPath = join(targetDir, name);
    // Re-assert containment on every candidate — mkdirSync only ran once,
    // but a concurrent writer could have planted a symlink under targetDir.
    assertInsideVault(targetPath, canonicalVaultRoot);
    const tmpPath = join(
      targetDir,
      `.tmp.vault.${randomBytes(6).toString('hex')}`,
    );
    try {
      writeFileSync(tmpPath, content, { encoding: 'utf-8', mode: 0o600 });
    } catch (err) {
      safeUnlink(tmpPath);
      throw err;
    }
    try {
      linkSync(tmpPath, targetPath);
      safeUnlink(tmpPath);
      return targetPath;
    } catch (err) {
      safeUnlink(tmpPath);
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        continue; // collision — try the next candidate name
      }
      throw err;
    }
  }
  throw new Error(
    `Could not resolve non-colliding filename in ${targetDir} for ${desiredName}`,
  );
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* ignore — temp may already be gone */
  }
}

// --- Frontmatter (minimal YAML-subset parser) -------------------------------

interface ParsedFrontmatter {
  /** Ordered key → raw-value entries preserved from the source file. */
  entries: Array<{ key: string; raw: string }>;
}

function splitFrontmatter(text: string): { frontmatter: ParsedFrontmatter; body: string } {
  const empty: ParsedFrontmatter = { entries: [] };
  if (!text.startsWith('---')) return { frontmatter: empty, body: text };
  // Accept `---\n` or `---\r\n` as the opening fence.
  const fenceMatch = text.match(/^---(\r?\n)/);
  if (!fenceMatch) return { frontmatter: empty, body: text };
  const afterOpen = fenceMatch[0].length;
  // Find closing fence on its own line.
  const closeMatch = text.slice(afterOpen).match(/(\r?\n)---(\r?\n|$)/);
  if (!closeMatch || closeMatch.index === undefined) {
    return { frontmatter: empty, body: text };
  }
  const block = text.slice(afterOpen, afterOpen + closeMatch.index);
  const bodyStart = afterOpen + closeMatch.index + closeMatch[0].length;
  const body = text.slice(bodyStart);

  const entries: ParsedFrontmatter['entries'] = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx <= 0) continue; // preserve nothing we can't parse as key: value
    const key = line.slice(0, colonIdx).trim();
    const raw = line.slice(colonIdx + 1).trim();
    if (!/^[A-Za-z0-9_-]+$/.test(key)) continue;
    entries.push({ key, raw });
  }
  return { frontmatter: { entries }, body };
}

function buildFrontmatter(input: {
  existing: ParsedFrontmatter;
  agentName: string;
  taskId?: string;
  sourcePath: string;
  summary?: string;
  extraTags: string[];
  vaultDirTag: string;
  now: Date;
}): string {
  const {
    existing,
    agentName,
    taskId,
    sourcePath,
    summary,
    extraTags,
    vaultDirTag,
    now,
  } = input;

  const publishedAt = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const existingKeys = new Set(existing.entries.map((e) => e.key));

  const tags = dedupe([
    'agent-output',
    agentName,
    ...(vaultDirTag ? vaultDirTag.split('/').filter(Boolean) : []),
    ...extraTags.filter((t) => typeof t === 'string' && t.trim().length > 0),
  ]);

  // Injected provenance fields — authoritative; always override.
  const injected: Array<[string, string]> = [
    ['published_by', yamlScalar(agentName)],
    ['published_at', yamlScalar(publishedAt)],
    ['source_path', yamlScalar(sourcePath)],
  ];
  if (taskId) injected.push(['source_task', yamlScalar(taskId)]);
  if (summary) injected.push(['summary', yamlScalar(summary)]);
  injected.push(['tags', yamlInlineList(tags)]);

  const injectedKeys = new Set(injected.map(([k]) => k));

  // Preserve non-conflicting keys from the source file's frontmatter.
  const preserved: Array<[string, string]> = [];
  for (const { key, raw } of existing.entries) {
    if (injectedKeys.has(key)) continue;
    preserved.push([key, raw]);
  }
  // Reference silences unused-variable warnings for diagnostics.
  void existingKeys;

  const lines = ['---'];
  for (const [k, v] of injected) lines.push(`${k}: ${v}`);
  for (const [k, v] of preserved) lines.push(`${k}: ${v}`);
  lines.push('---');
  return lines.join('\n');
}

function ensureTaskWikilink(body: string, taskId: string): string {
  const link = `[[${taskId}]]`;
  if (body.includes(link)) return body;
  const trimmed = body.replace(/\s*$/, '');
  const separator = trimmed ? '\n\n---\n' : '';
  return `${trimmed}${separator}Source: ${link}\n`;
}

function yamlScalar(value: string): string {
  // Quote conservatively when special chars might confuse a YAML parser.
  if (value === '') return '""';
  if (/[:#\[\]{},&*!|>'%@`"\n\r\t]/.test(value)) {
    // Use double-quoted form with minimal escaping.
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  // Leading/trailing whitespace or reserved words — quote defensively.
  if (/^\s|\s$/.test(value) || /^(true|false|null|yes|no|~)$/i.test(value)) {
    return `"${value}"`;
  }
  return value;
}

function yamlInlineList(items: string[]): string {
  if (items.length === 0) return '[]';
  return `[${items.map(yamlScalar).join(', ')}]`;
}

function dedupe(items: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const key = item.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}
