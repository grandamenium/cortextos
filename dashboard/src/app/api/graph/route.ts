import { existsSync } from 'fs';
import { join, relative } from 'path';
import { getFrameworkRoot } from '@/lib/config';

export const dynamic = 'force-dynamic';

/**
 * GET /api/graph
 *
 * Returns the full codebase graph — every function, class, and file as
 * individual nodes with edges showing CALLS, IMPORTS_FROM, and REFERENCES.
 * Designed for GitNexus-style force-directed visualization with Sigma.js.
 */

// Vibrant color palette for communities (40 distinct colors)
const COMMUNITY_COLORS = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16',
  '#22c55e', '#10b981', '#14b8a6', '#06b6d4', '#0ea5e9',
  '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7', '#d946ef',
  '#ec4899', '#f43f5e', '#fb7185', '#fbbf24', '#a3e635',
  '#4ade80', '#2dd4bf', '#22d3ee', '#38bdf8', '#818cf8',
  '#c084fc', '#e879f9', '#f472b6', '#fb923c', '#facc15',
  '#a78bfa', '#67e8f9', '#34d399', '#fca5a1', '#fdba74',
  '#fde047', '#bef264', '#86efac', '#5eead4', '#7dd3fc',
];

// Module-level color overrides for uncommunity'd nodes
const MODULE_COLORS: Record<string, string> = {
  'src/daemon': '#ef4444',
  'src/bus': '#f59e0b',
  'src/cli': '#10b981',
  'src/hooks': '#8b5cf6',
  'src/pty': '#ec4899',
  'src/types': '#6366f1',
  'src/utils': '#14b8a6',
  'dashboard': '#3b82f6',
  'tests': '#64748b',
  'bus': '#f97316',
  'knowledge-base': '#84cc16',
};

function getModuleColor(filePath: string, frameworkRoot: string): string {
  const rel = relative(frameworkRoot, filePath);
  for (const [prefix, color] of Object.entries(MODULE_COLORS)) {
    if (rel.startsWith(prefix)) return color;
  }
  return '#94a3b8';
}

function getModule(filePath: string, frameworkRoot: string): string {
  const rel = relative(frameworkRoot, filePath);
  const parts = rel.split('/');
  if (parts[0] === 'src' && parts.length > 1) return `src/${parts[1]}`;
  if (parts[0] === 'dashboard' && parts.length > 2) return `dashboard/${parts[2]}`;
  if (parts[0] === 'tests') return 'tests';
  return parts[0] || 'root';
}

interface NodeRow {
  id: number;
  kind: string;
  name: string;
  qualified_name: string;
  file_path: string;
  line_start: number | null;
  language: string | null;
  community_id: number | null;
}

interface EdgeRow {
  kind: string;
  source_qualified: string;
  target_qualified: string;
}

interface CommunityRow {
  id: number;
  name: string;
  size: number;
  dominant_language: string | null;
  description: string | null;
}

export async function GET(request: Request) {
  const frameworkRoot = getFrameworkRoot();
  const graphDbPath = join(frameworkRoot, '.code-review-graph', 'graph.db');

  if (!existsSync(graphDbPath)) {
    return Response.json({
      error: 'Code graph not built yet. Run: build_or_update_graph_tool',
      nodes: [], edges: [], communities: [],
    });
  }

  try {
    const url = new URL(request.url);
    const includeTests = url.searchParams.get('tests') === '1';
    const result = queryFullGraph(graphDbPath, frameworkRoot, includeTests);
    return Response.json(result);
  } catch (err) {
    console.error('[api/graph] Error:', err);
    return Response.json({ error: String(err), nodes: [], edges: [], communities: [] });
  }
}

function queryFullGraph(dbPath: string, frameworkRoot: string, includeTests: boolean) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3');
  const db = new Database(dbPath, { readonly: true });

  try {
    // --- Nodes ---
    const kindFilter = includeTests
      ? ''
      : "WHERE kind != 'Test'";
    const nodeRows: NodeRow[] = db.prepare(
      `SELECT id, kind, name, qualified_name, file_path, line_start, language, community_id
       FROM nodes ${kindFilter}`
    ).all();

    // --- Communities ---
    const communityRows: CommunityRow[] = db.prepare(
      `SELECT id, name, size, dominant_language, description FROM communities ORDER BY size DESC`
    ).all();

    // Build community color map
    const communityColorMap = new Map<number, string>();
    communityRows.forEach((c, i) => {
      communityColorMap.set(c.id, COMMUNITY_COLORS[i % COMMUNITY_COLORS.length]);
    });

    // Build qualified_name → node index map
    const qualifiedToIdx = new Map<string, number>();
    const nodes: Array<{
      id: string;
      label: string;
      kind: string;
      module: string;
      file: string;
      color: string;
      community: number;
      size: number;
    }> = [];

    for (const row of nodeRows) {
      const idx = nodes.length;
      qualifiedToIdx.set(row.qualified_name, idx);

      const color = row.community_id
        ? (communityColorMap.get(row.community_id) ?? getModuleColor(row.file_path, frameworkRoot))
        : getModuleColor(row.file_path, frameworkRoot);

      const relFile = relative(frameworkRoot, row.file_path);
      const module = getModule(row.file_path, frameworkRoot);

      // Size by kind: File > Class > Function
      let size: number;
      switch (row.kind) {
        case 'File': size = 4; break;
        case 'Class': size = 6; break;
        case 'Function': size = 2; break;
        default: size = 2;
      }

      nodes.push({
        id: row.qualified_name,
        label: row.name.includes('/') ? relFile.split('/').pop() ?? row.name : row.name,
        kind: row.kind,
        module,
        file: relFile,
        color,
        community: row.community_id ?? 0,
        size,
      });
    }

    // --- Edges (only between nodes that exist in our set) ---
    const edgeRows: EdgeRow[] = db.prepare(
      `SELECT kind, source_qualified, target_qualified FROM edges
       WHERE kind IN ('CALLS', 'IMPORTS_FROM', 'REFERENCES', 'CONTAINS')
       AND source_qualified IN (SELECT qualified_name FROM nodes ${kindFilter})
       AND target_qualified IN (SELECT qualified_name FROM nodes ${kindFilter})`
    ).all();

    // Deduplicate edges
    const edgeSet = new Set<string>();
    const edges: Array<{ source: number; target: number; kind: string }> = [];

    for (const e of edgeRows) {
      const si = qualifiedToIdx.get(e.source_qualified);
      const ti = qualifiedToIdx.get(e.target_qualified);
      if (si === undefined || ti === undefined) continue;
      if (si === ti) continue;

      const key = `${si}-${ti}`;
      if (edgeSet.has(key)) continue;
      edgeSet.add(key);

      edges.push({ source: si, target: ti, kind: e.kind });
    }

    // --- Community summaries for UI ---
    const communities = communityRows.slice(0, 50).map((c, i) => ({
      id: c.id,
      name: c.name,
      size: c.size,
      language: c.dominant_language ?? 'unknown',
      color: COMMUNITY_COLORS[i % COMMUNITY_COLORS.length],
    }));

    return {
      nodes,
      edges,
      communities,
      stats: {
        totalNodes: nodes.length,
        totalEdges: edges.length,
        communities: communityRows.length,
        byKind: {
          File: nodeRows.filter(n => n.kind === 'File').length,
          Class: nodeRows.filter(n => n.kind === 'Class').length,
          Function: nodeRows.filter(n => n.kind === 'Function').length,
          Test: includeTests ? nodeRows.filter(n => n.kind === 'Test').length : 0,
        },
      },
    };
  } finally {
    db.close();
  }
}
