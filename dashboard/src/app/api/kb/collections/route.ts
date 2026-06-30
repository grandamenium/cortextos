import { NextRequest } from 'next/server';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { getFrameworkRoot, getKnowledgeBaseDir, getCTXInstanceId } from '@/lib/config';

export const dynamic = 'force-dynamic';

/**
 * GET /api/kb/collections?org=<org>
 *
 * Lists knowledge base collections and document counts for an org.
 *
 * Response:
 * {
 *   collections: Array<{ name: string, count: number }>,
 *   org: string
 * }
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const org = searchParams.get('org') || '';

  if (!org || !/^[a-z0-9_-]+$/.test(org)) {
    return Response.json({ error: 'org parameter required (lowercase alphanumeric, hyphens, underscores)' }, { status: 400 });
  }

  const frameworkRoot = getFrameworkRoot();
  // Council [medium]: use the real CTX_INSTANCE_ID, not path.basename(ctxRoot).
  // A relocated CTX_ROOT (e.g. /agentic/cortextos-data) basenames to a bogus
  // instance name ("cortextos-data") that mmrag.py would mis-scope on.
  const instanceId = getCTXInstanceId();

  // #38: resolve the KB data root through CTX_ROOT (same tree the bus-side KB
  // writer ingests into) instead of rebuilding ~/.cortextos/<instanceId>/...,
  // which broke whenever CTX_ROOT was relocated.
  const kbRoot = getKnowledgeBaseDir(org);
  const chromaDir = path.join(kbRoot, 'chromadb');
  const configPath = path.join(kbRoot, 'config.json');
  const isWin = process.platform === 'win32';
  const venvBin = isWin ? 'Scripts' : 'bin';
  const pythonExe = isWin ? 'python.exe' : 'python3';
  const pythonPath = path.join(frameworkRoot, 'knowledge-base', 'venv', venvBin, pythonExe);
  const mmragPath = path.join(frameworkRoot, 'knowledge-base', 'scripts', 'mmrag.py');

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CTX_FRAMEWORK_ROOT: frameworkRoot,
    CTX_INSTANCE_ID: instanceId,
    CTX_ORG: org,
    PATH: process.env.PATH ?? '',
    MMRAG_DIR: kbRoot,
    MMRAG_CHROMADB_DIR: chromaDir,
    MMRAG_CONFIG: configPath,
  };

  // Load GEMINI_API_KEY from secrets if available
  const secretsPath = path.join(frameworkRoot, 'orgs', org, 'secrets.env');
  try {
    const secrets = readFileSync(secretsPath, 'utf-8');
    const match = secrets.match(/^GEMINI_API_KEY=(.+)$/m);
    if (match) env.GEMINI_API_KEY = match[1].trim();
  } catch {
    // No secrets file — GEMINI_API_KEY may be in process.env already
  }
  if (!env.GEMINI_API_KEY && process.env.GEMINI_API_KEY) {
    env.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  }

  // Pre-flight checks matching kb-collections.sh behavior
  if (!existsSync(path.join(frameworkRoot, 'knowledge-base', 'venv'))) {
    return Response.json({ collections: [], org });
  }
  if (!existsSync(chromaDir)) {
    return Response.json({ collections: [], org });
  }

  // Helper: parse tabular output from mmrag.py collections command
  function parseCollectionsOutput(rawOut: string): Array<{ name: string; count: number }> {
    const collections: Array<{ name: string; count: number }> = [];
    for (const line of rawOut.trim().split('\n')) {
      if (!line || line.startsWith('Collection') || line.startsWith('---')) continue;
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2) {
        const count = parseInt(parts[parts.length - 1], 10);
        const name = parts.slice(0, parts.length - 1).join(' ');
        if (name && !isNaN(count)) {
          collections.push({ name, count });
        }
      }
    }
    return collections;
  }

  let rawOut = '';
  try {
    rawOut = execFileSync(pythonPath, [mmragPath, 'collections'], {
      timeout: 15000,
      encoding: 'utf-8',
      env: env as NodeJS.ProcessEnv,
    });
  } catch (err: unknown) {
    // ChromaDB may crash mid-output (e.g. pickle corruption) after printing some collections.
    // Recover partial stdout rather than returning 500.
    const execErr = err as { stdout?: string; message?: string };
    rawOut = execErr.stdout || '';
    if (!rawOut) {
      const message = execErr.message || String(err);
      if (
        message.includes('not set up') ||
        message.includes('No collections') ||
        message.includes('not found')
      ) {
        return Response.json({ collections: [], org });
      }
      console.error('[api/kb/collections] Error:', message);
      return Response.json({ collections: [], org });
    }
  }

  return Response.json({ collections: parseCollectionsOutput(rawOut), org });
}
