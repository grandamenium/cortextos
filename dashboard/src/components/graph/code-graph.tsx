'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import Graph from 'graphology';
import Sigma from 'sigma';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import circular from 'graphology-layout/circular';
import { cn } from '@/lib/utils';

// ─── Types ───────────────────────────────────────────────────────────────────

interface APINode {
  id: string;
  label: string;
  kind: string;
  module: string;
  file: string;
  color: string;
  community: number;
  size: number;
}

interface APIEdge {
  source: number;
  target: number;
  kind: string;
}

interface APICommunity {
  id: number;
  name: string;
  size: number;
  language: string;
  color: string;
}

interface GraphData {
  nodes: APINode[];
  edges: APIEdge[];
  communities: APICommunity[];
  stats: {
    totalNodes: number;
    totalEdges: number;
    communities: number;
    byKind: { File: number; Class: number; Function: number; Test: number };
  };
  error?: string;
}

interface HoverInfo {
  label: string;
  kind: string;
  module: string;
  file: string;
  community: number;
  connections: number;
  neighbors: Array<{ label: string; color: string }>;
}

type FilterMode = 'all' | 'files' | 'functions' | 'classes';
type EdgeFilter = 'all' | 'calls' | 'imports';

// ─── Component ───────────────────────────────────────────────────────────────

export function CodeGraph() {
  const containerRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  const graphRef = useRef<Graph | null>(null);

  const [data, setData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [layoutProgress, setLayoutProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<HoverInfo | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [edgeFilter, setEdgeFilter] = useState<EdgeFilter>('all');
  const [showTests, setShowTests] = useState(false);
  const [highlightedCommunity, setHighlightedCommunity] = useState<number | null>(null);

  // Original colors for reset
  const originalColorsRef = useRef<Map<string, string>>(new Map());

  // Fetch
  useEffect(() => {
    const url = showTests ? '/api/graph?tests=1' : '/api/graph';
    setLoading(true);
    fetch(url)
      .then((r) => r.json())
      .then((json: GraphData) => {
        if (json.error) setError(json.error);
        else setData(json);
        setLoading(false);
      })
      .catch((e) => { setError(String(e)); setLoading(false); });
  }, [showTests]);

  // Build & render graph
  useEffect(() => {
    if (!data || !containerRef.current || data.nodes.length === 0) return;

    // Cleanup
    if (sigmaRef.current) { sigmaRef.current.kill(); sigmaRef.current = null; }

    const graph = new Graph();
    graphRef.current = graph;
    originalColorsRef.current = new Map();

    // Filter nodes by kind
    const nodeFilter = (n: APINode) => {
      if (filterMode === 'files') return n.kind === 'File';
      if (filterMode === 'functions') return n.kind === 'Function';
      if (filterMode === 'classes') return n.kind === 'Class';
      return true;
    };

    // Build index for filtered nodes
    const filteredIdx = new Set<number>();
    data.nodes.forEach((n, i) => {
      if (nodeFilter(n)) filteredIdx.add(i);
    });

    // Add nodes
    for (const idx of filteredIdx) {
      const n = data.nodes[idx];
      const nodeId = String(idx);
      graph.addNode(nodeId, {
        label: n.label,
        size: n.size,
        color: n.color,
        kind: n.kind,
        module: n.module,
        file: n.file,
        community: n.community,
        x: 0, y: 0,
      });
      originalColorsRef.current.set(nodeId, n.color);
    }

    // Add edges
    const addedEdges = new Set<string>();
    for (const e of data.edges) {
      if (!filteredIdx.has(e.source) || !filteredIdx.has(e.target)) continue;
      if (edgeFilter === 'calls' && e.kind !== 'CALLS') continue;
      if (edgeFilter === 'imports' && e.kind !== 'IMPORTS_FROM') continue;

      const sId = String(e.source);
      const tId = String(e.target);
      const key = `${sId}-${tId}`;
      if (addedEdges.has(key)) continue;
      if (!graph.hasNode(sId) || !graph.hasNode(tId)) continue;
      addedEdges.add(key);

      const edgeColor = e.kind === 'CALLS' ? 'rgba(99,102,241,0.12)'
        : e.kind === 'IMPORTS_FROM' ? 'rgba(16,185,129,0.12)'
        : e.kind === 'CONTAINS' ? 'rgba(148,163,184,0.05)'
        : 'rgba(148,163,184,0.08)';

      graph.addEdge(sId, tId, {
        size: e.kind === 'CONTAINS' ? 0.3 : 0.5,
        color: edgeColor,
        kind: e.kind,
      });
    }

    // Layout: circular seed → ForceAtlas2
    circular.assign(graph);
    setLayoutProgress(10);

    // Run ForceAtlas2 in batches for progress feedback
    const totalIterations = 150;
    const batchSize = 30;
    let done = 0;

    const runBatch = () => {
      const iters = Math.min(batchSize, totalIterations - done);
      forceAtlas2.assign(graph, {
        iterations: iters,
        settings: {
          gravity: 0.05,
          scalingRatio: 15,
          barnesHutOptimize: true,
          barnesHutTheta: 0.8,
          strongGravityMode: false,
          slowDown: 3,
          outboundAttractionDistribution: true,
          adjustSizes: false,
          linLogMode: false,
        },
      });
      done += iters;
      setLayoutProgress(10 + Math.round((done / totalIterations) * 90));

      if (done < totalIterations) {
        requestAnimationFrame(runBatch);
      } else {
        initSigma();
      }
    };

    const initSigma = () => {
      if (!containerRef.current) return;

      const sigma = new Sigma(graph, containerRef.current, {
        renderEdgeLabels: false,
        enableEdgeEvents: false,
        defaultEdgeType: 'line',
        labelSize: 12,
        labelWeight: '500',
        labelColor: { color: '#cbd5e1' },
        labelRenderedSizeThreshold: 6,
        defaultNodeColor: '#94a3b8',
        defaultEdgeColor: 'rgba(148,163,184,0.08)',
        minCameraRatio: 0.05,
        maxCameraRatio: 10,
        stagePadding: 30,
        nodeReducer: (node, attrs) => {
          const res = { ...attrs };
          // Search highlight
          if (searchTerm) {
            const label = (attrs.label ?? '').toLowerCase();
            const file = (attrs.file ?? '').toLowerCase();
            const term = searchTerm.toLowerCase();
            if (!label.includes(term) && !file.includes(term)) {
              res.color = 'rgba(100,116,139,0.08)';
              res.label = '';
              res.size = 1;
            } else {
              res.size = (attrs.size ?? 2) * 2;
              res.zIndex = 1;
            }
          }
          return res;
        },
        edgeReducer: (_edge, attrs) => {
          const res = { ...attrs };
          if (searchTerm) {
            res.color = 'rgba(100,116,139,0.02)';
          }
          return res;
        },
      });

      // Hover
      sigma.on('enterNode', ({ node }) => {
        const a = graph.getNodeAttributes(node);
        const neighbors = graph.neighbors(node).slice(0, 12);
        const neighborInfo = neighbors.map((n) => ({
          label: graph.getNodeAttribute(n, 'label') ?? n,
          color: graph.getNodeAttribute(n, 'color') ?? '#94a3b8',
        }));

        setHovered({
          label: a.label,
          kind: a.kind,
          module: a.module,
          file: a.file,
          community: a.community,
          connections: graph.degree(node),
          neighbors: neighborInfo,
        });

        // Dim non-neighbors
        const neighborSet = new Set(graph.neighbors(node));
        neighborSet.add(node);

        graph.forEachNode((n) => {
          if (neighborSet.has(n)) {
            graph.setNodeAttribute(n, 'color', originalColorsRef.current.get(n) ?? '#94a3b8');
            graph.setNodeAttribute(n, 'zIndex', 1);
          } else {
            graph.setNodeAttribute(n, 'color', 'rgba(100,116,139,0.06)');
            graph.setNodeAttribute(n, 'zIndex', 0);
          }
        });

        graph.forEachEdge((e, _a, s, t) => {
          if (s === node || t === node) {
            graph.setEdgeAttribute(e, 'color', 'rgba(226,232,240,0.4)');
            graph.setEdgeAttribute(e, 'size', 1.5);
          } else {
            graph.setEdgeAttribute(e, 'color', 'rgba(100,116,139,0.01)');
            graph.setEdgeAttribute(e, 'size', 0.2);
          }
        });
        sigma.refresh();
      });

      sigma.on('leaveNode', () => {
        setHovered(null);
        // Reset all
        graph.forEachNode((n) => {
          graph.setNodeAttribute(n, 'color', originalColorsRef.current.get(n) ?? '#94a3b8');
          graph.setNodeAttribute(n, 'zIndex', 0);
        });
        graph.forEachEdge((e) => {
          const kind = graph.getEdgeAttribute(e, 'kind');
          const color = kind === 'CALLS' ? 'rgba(99,102,241,0.12)'
            : kind === 'IMPORTS_FROM' ? 'rgba(16,185,129,0.12)'
            : kind === 'CONTAINS' ? 'rgba(148,163,184,0.05)'
            : 'rgba(148,163,184,0.08)';
          graph.setEdgeAttribute(e, 'color', color);
          graph.setEdgeAttribute(e, 'size', kind === 'CONTAINS' ? 0.3 : 0.5);
        });
        sigma.refresh();
      });

      sigmaRef.current = sigma;
      setLayoutProgress(100);
    };

    requestAnimationFrame(runBatch);

    return () => {
      if (sigmaRef.current) { sigmaRef.current.kill(); sigmaRef.current = null; }
      graphRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, filterMode, edgeFilter]);

  // Search: trigger sigma refresh
  useEffect(() => {
    sigmaRef.current?.refresh();
  }, [searchTerm]);

  // Community highlight
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;

    if (highlightedCommunity === null) {
      graph.forEachNode((n) => {
        graph.setNodeAttribute(n, 'color', originalColorsRef.current.get(n) ?? '#94a3b8');
      });
      graph.forEachEdge((e) => {
        const kind = graph.getEdgeAttribute(e, 'kind');
        graph.setEdgeAttribute(e, 'color',
          kind === 'CALLS' ? 'rgba(99,102,241,0.12)'
          : kind === 'IMPORTS_FROM' ? 'rgba(16,185,129,0.12)'
          : 'rgba(148,163,184,0.06)'
        );
      });
    } else {
      graph.forEachNode((n) => {
        const comm = graph.getNodeAttribute(n, 'community');
        if (comm === highlightedCommunity) {
          graph.setNodeAttribute(n, 'color', originalColorsRef.current.get(n) ?? '#94a3b8');
          graph.setNodeAttribute(n, 'size', (graph.getNodeAttribute(n, 'size') ?? 2));
        } else {
          graph.setNodeAttribute(n, 'color', 'rgba(100,116,139,0.06)');
        }
      });
      graph.forEachEdge((e, _a, s, t) => {
        const sc = graph.getNodeAttribute(s, 'community');
        const tc = graph.getNodeAttribute(t, 'community');
        if (sc === highlightedCommunity || tc === highlightedCommunity) {
          graph.setEdgeAttribute(e, 'color', 'rgba(226,232,240,0.3)');
        } else {
          graph.setEdgeAttribute(e, 'color', 'rgba(100,116,139,0.01)');
        }
      });
    }
    sigmaRef.current?.refresh();
  }, [highlightedCommunity]);

  // Controls
  const handleZoomIn = useCallback(() => {
    sigmaRef.current?.getCamera().animatedZoom({ duration: 200 });
  }, []);
  const handleZoomOut = useCallback(() => {
    sigmaRef.current?.getCamera().animatedUnzoom({ duration: 200 });
  }, []);
  const handleReset = useCallback(() => {
    sigmaRef.current?.getCamera().animatedReset({ duration: 200 });
    setHighlightedCommunity(null);
    setSearchTerm('');
  }, []);

  // ─── Render ────────────────────────────────────────────────────────────────

  if (loading || (layoutProgress > 0 && layoutProgress < 100)) {
    return (
      <div className="flex h-[calc(100vh-10rem)] items-center justify-center rounded-lg border bg-[#0a0b0f]">
        <div className="flex flex-col items-center gap-4">
          <div className="h-10 w-10 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
          <p className="text-sm text-slate-400">
            {layoutProgress < 10
              ? 'Loading graph data...'
              : `Computing layout... ${layoutProgress}%`}
          </p>
          {layoutProgress >= 10 && (
            <div className="w-48 h-1 bg-slate-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-indigo-500 rounded-full transition-all duration-300"
                style={{ width: `${layoutProgress}%` }}
              />
            </div>
          )}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-[calc(100vh-10rem)] items-center justify-center rounded-lg border bg-[#0a0b0f]">
        <div className="text-center max-w-md">
          <div className="h-12 w-12 mx-auto mb-3 rounded-full bg-red-500/10 flex items-center justify-center">
            <span className="text-red-400 text-xl">!</span>
          </div>
          <p className="text-sm text-slate-400">{error}</p>
        </div>
      </div>
    );
  }

  if (!data || data.nodes.length === 0) {
    return (
      <div className="flex h-[calc(100vh-10rem)] items-center justify-center rounded-lg border bg-[#0a0b0f]">
        <p className="text-sm text-slate-400">
          No graph data. Run <code className="text-xs bg-slate-800 px-1.5 py-0.5 rounded text-slate-300">build_or_update_graph_tool</code>
        </p>
      </div>
    );
  }

  return (
    <div className="relative h-[calc(100vh-10rem)] min-h-[600px]">
      {/* Graph canvas */}
      <div
        ref={containerRef}
        className="absolute inset-0 rounded-lg border border-slate-800 bg-[#0a0b0f]"
      />

      {/* Top bar: search + filters */}
      <div className="absolute left-3 top-3 flex items-center gap-2 z-10">
        {/* Search */}
        <div className="relative">
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search nodes..."
            className="w-52 rounded-md bg-slate-900/90 backdrop-blur border border-slate-700 px-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-indigo-500"
          />
          {searchTerm && (
            <button
              onClick={() => setSearchTerm('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 text-xs"
            >
              ✕
            </button>
          )}
        </div>

        {/* Node type filters */}
        <div className="flex rounded-md bg-slate-900/90 backdrop-blur border border-slate-700 overflow-hidden">
          {([['all', 'All'], ['files', 'Files'], ['functions', 'Fn'], ['classes', 'Class']] as [FilterMode, string][]).map(([mode, label]) => (
            <button
              key={mode}
              onClick={() => setFilterMode(mode)}
              className={cn(
                'px-2.5 py-1.5 text-[11px] font-medium transition-colors',
                filterMode === mode
                  ? 'bg-indigo-500/20 text-indigo-300'
                  : 'text-slate-500 hover:text-slate-300'
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Edge type filters */}
        <div className="flex rounded-md bg-slate-900/90 backdrop-blur border border-slate-700 overflow-hidden">
          {([['all', 'All edges'], ['calls', 'Calls'], ['imports', 'Imports']] as [EdgeFilter, string][]).map(([mode, label]) => (
            <button
              key={mode}
              onClick={() => setEdgeFilter(mode)}
              className={cn(
                'px-2.5 py-1.5 text-[11px] font-medium transition-colors',
                edgeFilter === mode
                  ? 'bg-emerald-500/20 text-emerald-300'
                  : 'text-slate-500 hover:text-slate-300'
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Stats pills */}
      <div className="absolute right-14 top-3 flex gap-2 z-10">
        <span className="rounded bg-slate-900/80 backdrop-blur border border-slate-700 px-2.5 py-1 text-[11px] text-slate-400">
          <span className="text-slate-200 font-medium">{data.stats.totalNodes.toLocaleString()}</span> nodes
        </span>
        <span className="rounded bg-slate-900/80 backdrop-blur border border-slate-700 px-2.5 py-1 text-[11px] text-slate-400">
          <span className="text-slate-200 font-medium">{data.stats.totalEdges.toLocaleString()}</span> edges
        </span>
        <span className="rounded bg-slate-900/80 backdrop-blur border border-slate-700 px-2.5 py-1 text-[11px] text-slate-400">
          <span className="text-slate-200 font-medium">{data.stats.communities}</span> communities
        </span>
      </div>

      {/* Zoom controls */}
      <div className="absolute right-3 top-3 flex flex-col gap-1 z-10">
        <button onClick={handleZoomIn} className="h-7 w-7 rounded bg-slate-900/80 backdrop-blur border border-slate-700 text-slate-400 hover:text-white text-sm flex items-center justify-center">+</button>
        <button onClick={handleZoomOut} className="h-7 w-7 rounded bg-slate-900/80 backdrop-blur border border-slate-700 text-slate-400 hover:text-white text-sm flex items-center justify-center">−</button>
        <button onClick={handleReset} className="h-7 w-7 rounded bg-slate-900/80 backdrop-blur border border-slate-700 text-slate-400 hover:text-white text-xs flex items-center justify-center">⊙</button>
      </div>

      {/* Hover tooltip */}
      {hovered && (
        <div className="absolute left-3 bottom-3 rounded-lg bg-slate-900/95 backdrop-blur border border-slate-700 p-4 min-w-[240px] max-w-[320px] z-10">
          <div className="flex items-center gap-2 mb-2">
            <span className={cn(
              'text-[10px] font-mono uppercase px-1.5 py-0.5 rounded',
              hovered.kind === 'Function' ? 'bg-indigo-500/20 text-indigo-300' :
              hovered.kind === 'Class' ? 'bg-amber-500/20 text-amber-300' :
              hovered.kind === 'File' ? 'bg-cyan-500/20 text-cyan-300' :
              'bg-slate-500/20 text-slate-300'
            )}>
              {hovered.kind}
            </span>
            <span className="font-medium text-sm text-slate-100 truncate">{hovered.label}</span>
          </div>

          <div className="text-[11px] text-slate-500 mb-2 truncate">{hovered.file}</div>

          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <span className="text-slate-500">Module</span>
            <span className="text-slate-300">{hovered.module}</span>
            <span className="text-slate-500">Connections</span>
            <span className="text-slate-300 font-mono">{hovered.connections}</span>
            <span className="text-slate-500">Community</span>
            <span className="text-slate-300 font-mono">#{hovered.community}</span>
          </div>

          {hovered.neighbors.length > 0 && (
            <div className="mt-3 pt-2 border-t border-slate-800">
              <p className="text-[10px] text-slate-600 mb-1.5">Connected to:</p>
              <div className="flex flex-wrap gap-1">
                {hovered.neighbors.map((n, i) => (
                  <span key={i} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] bg-slate-800 text-slate-400">
                    <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ backgroundColor: n.color }} />
                    {n.label}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Community legend (right side, scrollable) */}
      <div className="absolute right-3 bottom-3 rounded-lg bg-slate-900/80 backdrop-blur border border-slate-700 p-3 max-w-[200px] max-h-[40%] overflow-y-auto z-10">
        <p className="text-[10px] font-semibold text-slate-600 uppercase tracking-wider mb-2">
          Communities
        </p>
        <div className="space-y-0.5">
          {data.communities.slice(0, 20).map((c) => (
            <button
              key={c.id}
              onClick={() => setHighlightedCommunity(prev => prev === c.id ? null : c.id)}
              className={cn(
                'flex items-center gap-2 text-[11px] w-full text-left rounded px-1.5 py-0.5 transition-colors',
                highlightedCommunity === c.id
                  ? 'bg-slate-700 text-slate-200'
                  : 'text-slate-500 hover:text-slate-300 hover:bg-slate-800'
              )}
            >
              <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: c.color }} />
              <span className="truncate">{c.name}</span>
              <span className="ml-auto text-[10px] text-slate-600 font-mono">{c.size}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Kind breakdown (bottom center) */}
      <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex gap-3 z-10">
        <span className="flex items-center gap-1.5 text-[11px] text-slate-500">
          <span className="h-2 w-2 rounded-full bg-cyan-400" />
          {data.stats.byKind.File} files
        </span>
        <span className="flex items-center gap-1.5 text-[11px] text-slate-500">
          <span className="h-2 w-2 rounded-full bg-indigo-400" />
          {data.stats.byKind.Function} functions
        </span>
        <span className="flex items-center gap-1.5 text-[11px] text-slate-500">
          <span className="h-2 w-2 rounded-full bg-amber-400" />
          {data.stats.byKind.Class} classes
        </span>
      </div>
    </div>
  );
}
