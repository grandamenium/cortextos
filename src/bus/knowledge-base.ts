import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { BusPaths } from '../types/index.js';
import { normalizeOrgName } from '../utils/org.js';

/**
 * Knowledge base integration.
 *
 * Chroma/MMRAG/Gemini embeddings were deprecated on 2026-05-14. Runtime
 * retrieval is now deterministic text search over the version-controlled
 * team-brain wiki, including the Open Brain thought mirror under
 * `wiki/sources/thoughts`.
 */

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
 * Resolve the wiki directory path.
 * Uses WIKI_PATH env var, then ~/work/team-brain default.
 */
function resolveWikiPath(): string {
  if (process.env.WIKI_PATH) return process.env.WIKI_PATH;
  return join(homedir(), 'work', 'team-brain');
}

/**
 * Search across the team-brain wiki and Open Brain thought mirror.
 * Returns results formatted as KBQueryResult so callers get a consistent shape.
 */
function wikiGrepFallback(
  query: string,
  org: string,
  topK: number,
): KBQueryResult[] {
  const wikiDir = resolveWikiPath();
  if (!existsSync(wikiDir)) return [];

  try {
    // -i: case-insensitive, -r: recursive, -n: line numbers, -C 2: 2 lines context
    // Escape query for shell safety — use only the first "word" portion for grep
    const safeQuery = query.replace(/[^a-zA-Z0-9 _-]/g, '').trim().split(/\s+/).slice(0, 4).join(' ');
    if (!safeQuery) return [];

    let output = execSync(
      `git grep -i -r -n -C 2 --max-count=10 -- ${JSON.stringify(safeQuery)} docs wiki .claude 2>/dev/null | head -n 400 || true`,
      { cwd: wikiDir, encoding: 'utf-8', timeout: 10000, maxBuffer: 512 * 1024 },
    );
    if (!output.trim()) {
      const terms = safeQuery.split(/\s+/).filter((term) => term.length > 2).slice(0, 4);
      if (terms.length > 0) {
        const termArgs = terms.map((term) => `-e ${JSON.stringify(term)}`).join(' ');
        output = execSync(
          `git grep -i -r -n -C 2 --max-count=10 ${termArgs} -- docs wiki .claude 2>/dev/null | head -n 400 || true`,
          { cwd: wikiDir, encoding: 'utf-8', timeout: 10000, maxBuffer: 512 * 1024 },
        );
      }
    }

    // Each match block is separated by '--'; within a block lines are: file:linenum-context or file:linenum:match
    const blocks = output.split(/^--$/m).slice(0, topK);
    return blocks.map((block) => {
      const lines = block.trim().split('\n').filter(Boolean);
      if (lines.length === 0) return null;
      // Extract file path from first line (format: filepath:linenum:text or filepath:linenum-text)
      const firstLine = lines[0];
      const sourceMatch = firstLine.match(/^(.+?)(?::\d+:|-\d+-)/);
      const sourceFile = sourceMatch ? sourceMatch[1] : firstLine;
      const content = lines.join('\n').substring(0, 500);
      return {
        content,
        source_file: join(wikiDir, sourceFile),
        org,
        score: 1.0,
        doc_type: sourceFile.includes('wiki/sources/thoughts/')
          ? 'open-brain-thought'
          : 'wiki-grep',
      } as KBQueryResult;
    }).filter((r): r is KBQueryResult => r !== null);
  } catch {
    return [];
  }
}

/**
 * Query the knowledge base.
 * ChromaDB is intentionally bypassed; all queries use wiki-grep directly.
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
    noEmbed?: boolean;
  },
): KBQueryResponse {
  const { topK = 5, frameworkRoot } = options;
  void paths;
  // Normalize once at the top so result metadata uses canonical org casing.
  const org = normalizeOrgName(frameworkRoot, options.org);

  const wikiResults = wikiGrepFallback(question, org, topK);
  return { results: wikiResults, total: wikiResults.length, query: question, collection: 'wiki-grep' };
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
  },
): void {
  const { frameworkRoot } = options;
  // Normalize once (see queryKnowledgeBase for rationale).
  const org = normalizeOrgName(frameworkRoot, options.org);

  console.warn(
    `[kb] Chroma/MMRAG ingestion is deprecated for org ${org}. ` +
    'No vector index was written; commit source docs to team-brain/wiki instead.',
  );
  for (const p of paths) {
    console.log(`  Skipped deprecated ingest source: ${p}`);
  }
}

/**
 * Retained for CLI compatibility. Chroma directories are no longer created.
 */
export function ensureKBDirs(instanceId: string, frameworkRoot: string, org: string): void {
  normalizeOrgName(frameworkRoot, org);
  void instanceId;
}
