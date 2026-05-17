import { execFileSync } from 'child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import type { BusPaths } from '../types/index.js';
import { normalizeOrgName } from '../utils/org.js';

/**
 * Knowledge base integration — calls mmrag.py directly (cross-platform,
 * no bash dependency).  Previously wrapped kb-*.sh bash scripts.
 *
 * gbrain fast-path: when /root/.gbrain/config.json exists (gbrain initialized),
 * queryKnowledgeBase and ingestKnowledgeBase route through gbrain instead of
 * mmrag.py.  Set GBRAIN_KB_BACKEND=false to force the legacy path.
 */

const GBRAIN_CLI = '/usr/local/bin/gbrain';

/**
 * True when gbrain is installed, initialized, and not explicitly disabled.
 * Checks binary + config file existence so cold machines without gbrain
 * fall back to mmrag transparently.
 */
function gbrainAvailable(): boolean {
  return (
    existsSync(GBRAIN_CLI) &&
    existsSync(join(homedir(), '.gbrain', 'config.json')) &&
    process.env.GBRAIN_KB_BACKEND !== 'false'
  );
}

/**
 * Parse one line of `gbrain query` text output.
 * Format: "[2.0000] slug -- first 100 chars of chunk_text"
 */
function parseGbrainLine(line: string): { slug: string; score: number } | null {
  const m = line.match(/^\[([0-9.]+)\]\s+(\S+)/);
  if (!m) return null;
  return { score: parseFloat(m[1]), slug: m[2] };
}

/**
 * Fetch the full page content for a gbrain slug.
 * Returns null on error (e.g. slug not found).
 */
function gbrainGetPage(slug: string): string | null {
  try {
    return execFileSync(GBRAIN_CLI, ['get', slug], {
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function queryKnowledgeBaseViaGbrain(
  question: string,
  options: {
    org: string;
    agent?: string;
    topK?: number;
    projectId?: string | null;
  },
): KBQueryResponse {
  // B1 (Phase 2a): projectId is accepted for API stability but the underlying
  // `gbrain query` CLI does not yet expose project-scoped filtering. Pass-through
  // for now — Phase 2c/B5 will wire project filtering once gbrain grows the flag.
  const { org, agent, topK = 5 } = options;

  let stdout: string;
  try {
    stdout = execFileSync(GBRAIN_CLI, ['query', question, '--limit', String(topK)], {
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch {
    return { results: [], total: 0, query: question, collection: `gbrain-${org}` };
  }

  const entries = stdout
    .split('\n')
    .map(parseGbrainLine)
    .filter((e): e is NonNullable<typeof e> => e !== null);

  const results: KBQueryResult[] = [];
  for (const entry of entries) {
    const content = gbrainGetPage(entry.slug) ?? '';
    if (!content) continue;
    results.push({
      content,
      source_file: entry.slug,
      org,
      agent_name: agent,
      score: entry.score,
      doc_type: 'markdown',
    });
  }

  return {
    results,
    total: results.length,
    query: question,
    collection: `gbrain-${org}`,
  };
}

/**
 * Normalize a filename into a gbrain-compatible slug.
 * gbrain rejects content puts on slugs that aren't lowercase-kebab-case
 * (returns a misleading "Page not found" error). Lowercase + map any
 * non-alphanumeric run to a single hyphen + trim hyphens. Example:
 * "MEMORY.md" → "memory"; "My Doc 2.md" → "my-doc-2".
 */
function normalizeSlugForGbrain(filePath: string): string {
  return (filePath.split('/').pop() ?? filePath)
    .replace(/\.md$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Inject `project_id: <id>` into the YAML frontmatter of a markdown page so
 * gbrain stores it as page metadata. Three cases:
 *   1. Page has frontmatter already with NO `project_id` key → insert the line
 *      before the closing `---`.
 *   2. Page has frontmatter and an existing `project_id` key → leave unchanged
 *      (idempotent; matches B7 NULL-tolerant "skip already stamped" semantics).
 *   3. Page has no frontmatter → prepend a fresh frontmatter block.
 */
function stampProjectIdFrontmatter(content: string, projectId: string): string {
  const fmStart = /^---\s*\n/;
  if (!fmStart.test(content)) {
    return `---\nproject_id: ${projectId}\n---\n${content}`;
  }
  const closeIdx = content.indexOf('\n---', 4);
  if (closeIdx === -1) {
    // Malformed frontmatter (open but no close) — prepend a fresh block to be safe.
    return `---\nproject_id: ${projectId}\n---\n${content}`;
  }
  const fmBlock = content.slice(0, closeIdx);
  if (/^project_id\s*:/m.test(fmBlock)) {
    return content; // already stamped, idempotent
  }
  return content.slice(0, closeIdx) + `\nproject_id: ${projectId}` + content.slice(closeIdx);
}

function ingestKnowledgeBaseViaGbrain(
  paths: string[],
  options: { org: string; agent?: string; projectId?: string | null },
): void {
  for (const filePath of paths) {
    const slug = normalizeSlugForGbrain(filePath);
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      console.warn(`[kb:gbrain] skipping ${filePath}: cannot read`);
      continue;
    }

    // B1 (Phase 2a): stamp project_id into YAML frontmatter when caller provides it.
    // gbrain CLI has no --meta flag — frontmatter is the only metadata channel.
    // NULL-tolerant: when projectId is nullish, content passes through unchanged.
    if (options.projectId) {
      content = stampProjectIdFrontmatter(content, options.projectId);
    }

    // gbrain (Bun-based) reads page body from stdin. Passing content via the
    // execFileSync `input:` option fails with "ENXIO: no such device or
    // address, open '/dev/stdin'" because Bun's stdin reader can't open the
    // piped fd via /dev/stdin under Node's child_process. Workaround: stage
    // the content in a temp file and pass the file's fd as stdin (stdio[0]),
    // which gbrain sees as a real file descriptor it can read normally.
    const tmpPath = join(tmpdir(), `cortextos-kb-${process.pid}-${Date.now()}-${slug}.md`);
    let fd: number | null = null;
    try {
      writeFileSync(tmpPath, content);
      fd = openSync(tmpPath, 'r');
      execFileSync(GBRAIN_CLI, ['put', slug], {
        stdio: [fd, 'pipe', 'ignore'],
        encoding: 'utf-8',
        timeout: 60_000,
      });
      console.log(`  gbrain put → ${slug}`);
    } catch (err) {
      console.warn(
        `[kb:gbrain] put failed for ${slug}: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      if (fd !== null) {
        try { closeSync(fd); } catch { /* fd may have been closed by spawn */ }
      }
      try { unlinkSync(tmpPath); } catch { /* temp file may not exist if writeFileSync threw */ }
    }
  }
}

/**
 * Resolve the Python interpreter inside the knowledge-base venv,
 * accounting for Windows vs Unix layout.
 */
function getVenvPython(frameworkRoot: string): string {
  const isWin = process.platform === 'win32';
  const venvBin = isWin ? 'Scripts' : 'bin';
  const pythonExe = isWin ? 'python.exe' : 'python3';
  return join(frameworkRoot, 'knowledge-base', 'venv', venvBin, pythonExe);
}

/**
 * Load .env and secrets.env files the same way the bash scripts did
 * (`set -o allexport && source …`).  Returns a flat key→value map.
 */
function loadSecretsEnv(frameworkRoot: string, org: string): Record<string, string> {
  const secretsPath = join(frameworkRoot, 'orgs', org, 'secrets.env');
  const dotenvPath = join(frameworkRoot, '.env');
  const vars: Record<string, string> = {};
  for (const p of [dotenvPath, secretsPath]) {
    if (existsSync(p)) {
      for (const line of readFileSync(p, 'utf-8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=');
        if (idx > 0) {
          let val = trimmed.slice(idx + 1);
          // Strip surrounding quotes (single or double) that some .env files use
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          vars[trimmed.slice(0, idx)] = val;
        }
      }
    }
  }
  return vars;
}

/**
 * Check whether the knowledge base config file exists for a given env.
 *
 * The Python MMRAG tool loads its config from env.MMRAG_CONFIG
 * (`knowledge-base/config.json` under the org's state dir) and exits with
 * "Config not found. Run setup first" if the file is absent. When that
 * happens, execFileSync throws a non-zero-exit error which — if not caught
 * — produces a user-facing unhandled-throw stack dump on top of the
 * already-printed Python error. This helper lets callers detect the
 * missing-config state UP FRONT and respond gracefully (warn + return)
 * instead of relying on brittle stderr string matching after the throw.
 */
function kbConfigured(env: Record<string, string>): boolean {
  return existsSync(env.MMRAG_CONFIG);
}

/**
 * Build the full env object needed by mmrag.py calls.
 */
function buildKBEnv(
  frameworkRoot: string,
  org: string,
  instanceId: string,
  agent?: string,
): Record<string, string> {
  // Normalize org to its canonical filesystem casing BEFORE touching any
  // paths. Without this, a lowercase --org arg produces a ghost state dir
  // (~/.cortextos/<instance>/orgs/<lowercase>/knowledge-base/) with its own
  // MMRAG config.json, splitting KB state across two directories and
  // polluting dashboard sync with hits against a non-existent org.
  const canonicalOrg = normalizeOrgName(frameworkRoot, org);
  const kbRoot = join(homedir(), '.cortextos', instanceId, 'orgs', canonicalOrg, 'knowledge-base');
  const secrets = loadSecretsEnv(frameworkRoot, canonicalOrg);
  return {
    ...process.env as Record<string, string>,
    ...secrets,
    CTX_ORG: canonicalOrg,
    CTX_AGENT_NAME: agent || '',
    CTX_INSTANCE_ID: instanceId,
    CTX_FRAMEWORK_ROOT: frameworkRoot,
    MMRAG_DIR: kbRoot,
    MMRAG_CHROMADB_DIR: join(kbRoot, 'chromadb'),
    MMRAG_CONFIG: join(kbRoot, 'config.json'),
  };
}

export interface KBQueryResult {
  content: string;
  source_file: string;
  agent_name?: string;
  org: string;
  score: number;
  doc_type: string;
}

export interface KBQueryResponse {
  results: KBQueryResult[];
  total: number;
  query: string;
  collection: string;
}

/**
 * Query the knowledge base.
 * Returns parsed JSON results when --json is used internally.
 */
export function queryKnowledgeBase(
  paths: BusPaths,
  question: string,
  options: {
    org: string;
    agent?: string;
    scope?: 'shared' | 'private' | 'all';
    topK?: number;
    threshold?: number;
    frameworkRoot: string;
    instanceId: string;
    projectId?: string | null;
  },
): KBQueryResponse {
  const { agent, scope = 'all', topK = 5, threshold = 0.5, frameworkRoot, instanceId, projectId } = options;
  const org = normalizeOrgName(frameworkRoot, options.org);

  // gbrain fast-path — bypasses mmrag when gbrain is initialized.
  // B1 (Phase 2a): projectId passes through; gbrain query filtering is Phase 2c work.
  if (gbrainAvailable()) {
    return queryKnowledgeBaseViaGbrain(question, { org, agent, topK, projectId });
  }

  const env = buildKBEnv(frameworkRoot, org, instanceId, agent);

  // UX safety net: if the KB is not configured for this org (no config.json
  // on disk yet), skip the python probe entirely and return empty results
  // with a visible warning. Previously the inner runQuery() try/catch would
  // swallow the Config-not-found error silently and the operator would see
  // "0 results" with no hint about WHY — indistinguishable from a legitimate
  // empty query against a configured KB. The warn-and-empty shape makes the
  // distinction obvious and actionable.
  if (!kbConfigured(env)) {
    console.warn(
      `[kb] Knowledge base not configured for org ${org}. Returning empty results — run setup to enable.`,
    );
    return { results: [], total: 0, query: question, collection: `shared-${org}` };
  }

  const pythonPath = getVenvPython(frameworkRoot);
  const mmragPath = join(frameworkRoot, 'knowledge-base', 'scripts', 'mmrag.py');

  // Determine which collections to query based on scope
  const collections: string[] = [];
  switch (scope) {
    case 'shared':
      collections.push(`shared-${org}`);
      break;
    case 'private':
      collections.push(agent ? `agent-${agent}` : `shared-${org}`);
      break;
    case 'all':
      collections.push(`shared-${org}`);
      if (agent) collections.push(`agent-${agent}`);
      break;
  }

  const runQuery = (col: string): string | null => {
    try {
      return execFileSync(pythonPath, [
        mmragPath, 'query', question,
        '--collection', col,
        '--top-k', String(topK),
        '--threshold', String(threshold),
        '--json',
      ], {
        encoding: 'utf-8',
        timeout: 30000,
        env,
      });
    } catch {
      return null;
    }
  };

  const parseOutput = (output: string | null): KBQueryResult[] => {
    if (!output) return [];
    // mmrag.py --json outputs pretty-printed JSON; find and parse the JSON block
    const trimmed = output.trim();
    const jsonStart = trimmed.indexOf('{');
    if (jsonStart === -1) return [];
    try {
      const raw = JSON.parse(trimmed.slice(jsonStart)) as {
        results?: Array<{ content?: string; result?: string; similarity?: number; source?: string; type?: string }>;
        result_count?: number;
        query?: string;
        collection?: string;
      };
      return (raw.results || []).map((r) => ({
        content: r.content || r.result || '',
        source_file: r.source || '',
        org,
        agent_name: agent,
        score: r.similarity ?? 0,
        doc_type: r.type || 'markdown',
      }));
    } catch {
      return [];
    }
  };

  try {
    let allResults: KBQueryResult[] = [];
    let lastCollection = `shared-${org}`;
    for (const col of collections) {
      const output = runQuery(col);
      allResults = allResults.concat(parseOutput(output));
      lastCollection = col;
    }

    if (allResults.length > 0) {
      return {
        results: allResults,
        total: allResults.length,
        query: question,
        collection: collections.length === 1 ? lastCollection : `shared-${org}`,
      };
    }
  } catch {
    // Failed — return empty
  }

  return { results: [], total: 0, query: question, collection: `shared-${org}` };
}

/**
 * Ingest files into the knowledge base.
 */
export function ingestKnowledgeBase(
  paths: string[],
  options: {
    org: string;
    agent?: string;
    scope?: 'shared' | 'private';
    force?: boolean;
    frameworkRoot: string;
    instanceId: string;
    projectId?: string | null;
  },
): void {
  const { agent, scope = 'shared', force, frameworkRoot, instanceId, projectId } = options;
  const org = normalizeOrgName(frameworkRoot, options.org);

  // gbrain fast-path
  // B1 (Phase 2a): projectId stamps YAML frontmatter when provided.
  if (gbrainAvailable()) {
    ingestKnowledgeBaseViaGbrain(paths, { org, agent, projectId });
    return;
  }

  const env = buildKBEnv(frameworkRoot, org, instanceId, agent);

  // Correctness fix: if the KB is not configured for this org, the underlying
  // python MMRAG tool exits with "Config not found. Run setup first" and
  // execFileSync (below, stdio: inherit) throws a non-zero-exit error. That
  // throw used to bubble up through the CLI action handler as an unhandled
  // exception, dumping a full Node stack trace on top of the python error
  // message — ugly and alarming for operators who were just running ingest
  // without setting up the KB first. Detect the missing-config state
  // up-front and warn-and-skip instead of letting execFileSync crash.
  if (!kbConfigured(env)) {
    console.warn(
      `[kb] Knowledge base not configured for org ${org}. Skipping ingest — ` +
      `run setup to enable (see HEARTBEAT.md step 10 for the config path).`,
    );
    return;
  }

  const pythonPath = getVenvPython(frameworkRoot);
  const mmragPath = join(frameworkRoot, 'knowledge-base', 'scripts', 'mmrag.py');

  // Determine collection name (same logic as kb-ingest.sh)
  let collection: string;
  if (scope === 'private') {
    if (!agent) throw new Error('--agent or CTX_AGENT_NAME required for --scope private');
    collection = `agent-${agent}`;
  } else {
    collection = `shared-${org}`;
  }

  // Ensure chromadb dir exists
  const kbRoot = join(homedir(), '.cortextos', instanceId, 'orgs', org, 'knowledge-base');
  const chromaDir = join(kbRoot, 'chromadb');
  if (!existsSync(chromaDir)) {
    mkdirSync(chromaDir, { recursive: true });
  }

  console.log(`Ingesting into collection: ${collection}`);
  for (const p of paths) {
    console.log(`  Source: ${p}`);
  }

  const args = [mmragPath, 'ingest', ...paths, '--collection', collection];
  if (force) args.push('--force');

  // Multimodal PDF ingestion via Gemini Flash routinely takes 2–5 min for
  // documents over ~10 pages with images/tables. Two minutes was too low and
  // produced ETIMEDOUT mid-Gemini-call. Default 10 min, override via env,
  // floored at 60s so nobody accidentally sets it to 0 or a value smaller
  // than a single Gemini call needs.
  const KB_INGEST_TIMEOUT_FLOOR_MS = 60_000;
  const KB_INGEST_TIMEOUT_DEFAULT_MS = 600_000;
  const requestedTimeout = Number(process.env.KB_INGEST_TIMEOUT_MS);
  const ingestTimeoutMs = Math.max(
    KB_INGEST_TIMEOUT_FLOOR_MS,
    Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? requestedTimeout
      : KB_INGEST_TIMEOUT_DEFAULT_MS,
  );

  execFileSync(pythonPath, args, {
    encoding: 'utf-8',
    timeout: ingestTimeoutMs,
    env,
    stdio: 'inherit',
  });

  console.log(`\nIngest complete → collection: ${collection}`);
}

/**
 * Ensure the knowledge base directories exist for an org.
 *
 * `frameworkRoot` is required so the org name can be normalized to its
 * canonical filesystem casing — without that, a caller passing a drifted
 * name (e.g. "acmecorp") would create a ghost state dir identical
 * to the one this module was written to prevent.
 */
export function ensureKBDirs(instanceId: string, frameworkRoot: string, org: string): void {
  const canonicalOrg = normalizeOrgName(frameworkRoot, org);
  const kbRoot = join(homedir(), '.cortextos', instanceId, 'orgs', canonicalOrg, 'knowledge-base');
  const chromaDir = join(kbRoot, 'chromadb');
  if (!existsSync(chromaDir)) {
    mkdirSync(chromaDir, { recursive: true });
  }
}
