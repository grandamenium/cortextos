import { NextRequest } from 'next/server';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { getCTXRoot, getFrameworkRoot } from '@/lib/config';

export const dynamic = 'force-dynamic';

interface ListedFile {
  source: string;
  type: string;
  chunks: number;
  collection: string;
}

/**
 * GET /api/kb/list?org=<org>&collection=<name>&limit=<n>
 *
 * Lists ingested source files (deduplicated by source path) across the org's
 * knowledge-base collections. Used by the dashboard to show a default
 * "browse all" view before the user has typed a search query.
 *
 * If `collection` is provided, only that collection is listed. Otherwise all
 * collections for the org are scanned.
 *
 * Response: { files: ListedFile[], total: number }
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const org = searchParams.get('org') ?? '';
  const onlyCollection = searchParams.get('collection') ?? '';
  const limit = Math.min(parseInt(searchParams.get('limit') || '200', 10), 500);

  if (org && !/^[a-z0-9_-]+$/.test(org)) {
    return Response.json({ error: 'Invalid org' }, { status: 400 });
  }
  if (onlyCollection && !/^[a-z0-9_-]+$/.test(onlyCollection)) {
    return Response.json({ error: 'Invalid collection' }, { status: 400 });
  }

  const frameworkRoot = getFrameworkRoot();
  const ctxRoot = getCTXRoot();
  const instanceId = path.basename(ctxRoot);
  const kbRoot = path.join(os.homedir(), '.cortextos', instanceId, 'orgs', org, 'knowledge-base');
  const chromaDir = path.join(kbRoot, 'chromadb');
  const configPath = path.join(kbRoot, 'config.json');
  const isWin = process.platform === 'win32';
  const venvBin = isWin ? 'Scripts' : 'bin';
  const pythonExe = isWin ? 'python.exe' : 'python3';
  const pythonPath = path.join(frameworkRoot, 'knowledge-base', 'venv', venvBin, pythonExe);
  const mmragPath = path.join(frameworkRoot, 'knowledge-base', 'scripts', 'mmrag.py');

  if (!existsSync(pythonPath) || !existsSync(mmragPath)) {
    return Response.json({ files: [], total: 0 });
  }

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CTX_FRAMEWORK_ROOT: frameworkRoot,
    CTX_INSTANCE_ID: instanceId,
    PATH: process.env.PATH ?? '',
    MMRAG_DIR: kbRoot,
    MMRAG_CHROMADB_DIR: chromaDir,
    MMRAG_CONFIG: configPath,
  };
  if (org) env.CTX_ORG = org;

  // Load Gemini key from org secrets — `mmrag.py list` does not call the API
  // but the script's config loader still validates the key is present.
  const secretsPath = org ? path.join(frameworkRoot, 'orgs', org, 'secrets.env') : null;
  if (secretsPath) {
    try {
      const secrets = readFileSync(secretsPath, 'utf-8');
      const match = secrets.match(/^GEMINI_API_KEY=(.+)$/m);
      if (match) env.GEMINI_API_KEY = match[1].trim();
    } catch { /* ignore */ }
  }
  if (!env.GEMINI_API_KEY && process.env.GEMINI_API_KEY) {
    env.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  }

  function runRaw(args: string[]): string {
    try {
      return execFileSync(pythonPath, [mmragPath, ...args], {
        timeout: 30000,
        encoding: 'utf-8',
        env: env as NodeJS.ProcessEnv,
      });
    } catch (e: unknown) {
      return (e as { stdout?: string }).stdout || '';
    }
  }

  function listCollections(): string[] {
    const out = runRaw(['collections']);
    const names: string[] = [];
    for (const line of out.trim().split('\n')) {
      if (!line || line.startsWith('Collection') || line.startsWith('---')) continue;
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2) {
        const name = parts.slice(0, parts.length - 1).join(' ');
        if (name) names.push(name);
      }
    }
    return names;
  }

  // Use mmrag.py's JSON list mode. The text mode truncates long source paths
  // with leading "..." which breaks downstream consumers that need absolute
  // paths (e.g. /api/kb/file).
  function listFiles(collection: string): ListedFile[] {
    const out = runRaw(['list', '--collection', collection, '--json']);
    const trimmed = out.trim();
    const jsonStart = trimmed.indexOf('{');
    if (jsonStart === -1) return [];
    try {
      const parsed = JSON.parse(trimmed.slice(jsonStart)) as {
        files?: Array<{ source?: string; type?: string; chunks?: number }>;
      };
      const files = parsed.files ?? [];
      return files
        .filter((f): f is { source: string; type?: string; chunks?: number } => typeof f.source === 'string')
        .map((f) => ({
          source: f.source,
          type: f.type ?? 'text',
          chunks: typeof f.chunks === 'number' ? f.chunks : 0,
          collection,
        }));
    } catch {
      return [];
    }
  }

  try {
    const collections = onlyCollection ? [onlyCollection] : listCollections();
    if (collections.length === 0) {
      return Response.json({ files: [], total: 0 });
    }

    const all: ListedFile[] = [];
    for (const col of collections) {
      for (const f of listFiles(col)) {
        all.push(f);
        if (all.length >= limit) break;
      }
      if (all.length >= limit) break;
    }

    return Response.json({ files: all, total: all.length });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[api/kb/list] Error:', message);
    return Response.json({ error: 'Failed to list knowledge base' }, { status: 500 });
  }
}
