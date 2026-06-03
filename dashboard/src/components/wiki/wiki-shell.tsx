'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { WikiRenderer } from './wiki-renderer';
import { FolderTree, type TreeNode } from './folder-tree';

// Re-export TreeNode for upstream API typing convenience
export type { TreeNode };

type Frontmatter = {
  type?: string;
  tags?: string[];
  created?: string;
  updated?: string;
  status?: string;
  agent?: string;
  session?: string;
  relates_to?: string[];
  [key: string]: unknown;
};


type SearchHit = {
  relPath: string;
  filename: string;
  matchedIn: 'filename' | 'content' | 'both';
  snippet: string;
  frontmatter: Frontmatter;
  mtimeMs: number;
};

type NoteResponse = {
  relPath: string;
  raw: string;
  body: string;
  frontmatter: Frontmatter;
  mtimeMs: number;
  sizeBytes: number;
};

interface WikiShellProps {
  org: string;
}

export function WikiShell({ org }: WikiShellProps) {
  const [tree, setTree] = useState<TreeNode[] | null>(null);
  const [vaultRoot, setVaultRoot] = useState<string | null>(null);
  const [vaultError, setVaultError] = useState<string | null>(null);

  const [selected, setSelected] = useState<string | null>(null);
  const [note, setNote] = useState<NoteResponse | null>(null);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [noteLoading, setNoteLoading] = useState(false);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const searchAbort = useRef<AbortController | null>(null);

  const loadTree = useCallback(async () => {
    try {
      const res = await fetch(`/api/wiki/tree?org=${encodeURIComponent(org)}`);
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        setVaultError(err.error ?? `Tree load failed (${res.status})`);
        setTree([]);
        return;
      }
      const data = await res.json();
      setTree(data.root as TreeNode[]);
      setVaultRoot(data.vaultRoot ?? null);
      setVaultError(null);
    } catch (e) {
      setVaultError(String(e));
      setTree([]);
    }
  }, [org]);

  useEffect(() => {
    loadTree();
  }, [loadTree]);

  const loadNote = useCallback(
    async (relPath: string) => {
      setNoteLoading(true);
      setNote(null);
      setNoteError(null);
      try {
        const res = await fetch(
          `/api/wiki/note?org=${encodeURIComponent(org)}&path=${encodeURIComponent(relPath)}`,
        );
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          setNoteError(err.error ?? `Note load failed (${res.status})`);
          return;
        }
        setNote((await res.json()) as NoteResponse);
      } catch (e) {
        setNoteError(String(e));
      } finally {
        setNoteLoading(false);
      }
    },
    [org],
  );

  useEffect(() => {
    if (selected) loadNote(selected);
    else setNote(null);
  }, [selected, loadNote]);

  // Debounced search
  useEffect(() => {
    if (query.trim().length < 2) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    if (searchAbort.current) searchAbort.current.abort();
    const ctrl = new AbortController();
    searchAbort.current = ctrl;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/wiki/search?org=${encodeURIComponent(org)}&q=${encodeURIComponent(query)}`,
          { signal: ctrl.signal },
        );
        if (!res.ok) {
          setResults([]);
          return;
        }
        const data = await res.json();
        setResults(data.results as SearchHit[]);
      } catch (e: unknown) {
        if ((e as Error).name !== 'AbortError') setResults([]);
      } finally {
        setSearching(false);
      }
    }, 220);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [query, org]);

  const onWikilink = useCallback(
    async (slug: string) => {
      // Resolve via the search route (filename-first), pick the best filename match
      try {
        const res = await fetch(
          `/api/wiki/search?org=${encodeURIComponent(org)}&q=${encodeURIComponent(slug)}`,
        );
        if (!res.ok) return;
        const data = await res.json();
        const hits = (data.results as SearchHit[]) ?? [];
        const exact = hits.find((h) => {
          const base = h.filename.replace(/\.md$/, '');
          return base === slug || h.relPath.replace(/\.md$/, '') === slug;
        });
        if (exact) setSelected(exact.relPath);
        else if (hits[0]) setSelected(hits[0].relPath);
      } catch {
        /* swallow */
      }
    },
    [org],
  );

  const paneContent = useMemo(() => {
    if (query.trim().length >= 2) {
      return (
        <SearchResults
          results={results}
          searching={searching}
          selected={selected}
          onSelect={setSelected}
        />
      );
    }
    if (tree === null) {
      return (
        <div className="space-y-1 px-1">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="h-6 rounded bg-muted/30 animate-pulse" />
          ))}
        </div>
      );
    }
    return (
      <FolderTree nodes={tree} selected={selected} onSelectFile={setSelected} />
    );
  }, [query, results, searching, tree, selected]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Wiki</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {vaultRoot ? (
              <>
                Read-only view of{' '}
                <code className="text-xs font-mono">{vaultRoot}</code>
              </>
            ) : vaultError ? (
              <span className="text-destructive">{vaultError}</span>
            ) : (
              'Loading vault…'
            )}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(280px,360px)_1fr] gap-4 min-h-[60vh]">
        <div className="border rounded-xl bg-card overflow-hidden flex flex-col">
          <div className="p-3 border-b">
            <Input
              type="search"
              placeholder="Search vault…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-9"
              aria-label="Search vault"
            />
            <p className="text-[10px] text-muted-foreground mt-1.5">
              {query.trim().length >= 2
                ? `${searching ? 'Searching' : 'Results in'} all PARA dirs`
                : 'Vault tree. Click folders to expand, files to open. Type 2+ chars to search.'}
            </p>
          </div>
          <ScrollArea className="flex-1">
            <div className="p-2">{paneContent}</div>
          </ScrollArea>
        </div>

        <div className="border rounded-xl bg-card overflow-hidden flex flex-col">
          {!selected ? (
            <EmptyState />
          ) : noteLoading ? (
            <div className="p-6 text-sm text-muted-foreground">Loading note…</div>
          ) : noteError ? (
            <div className="p-6 text-sm text-destructive">{noteError}</div>
          ) : note ? (
            <NoteView
              note={note}
              onWikilink={onWikilink}
              onClose={() => setSelected(null)}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}



function SearchResults({
  results,
  searching,
  selected,
  onSelect,
}: {
  results: SearchHit[] | null;
  searching: boolean;
  selected: string | null;
  onSelect: (relPath: string) => void;
}) {
  if (results === null && searching) {
    return (
      <div className="text-sm text-muted-foreground p-4 text-center">
        Searching…
      </div>
    );
  }
  if (results === null || results.length === 0) {
    return (
      <div className="text-sm text-muted-foreground p-4 text-center">
        No matches.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {results.map((hit) => (
        <button
          key={hit.relPath}
          type="button"
          onClick={() => onSelect(hit.relPath)}
          className={`w-full text-left rounded-lg border px-3 py-2.5 transition-colors ${
            selected === hit.relPath
              ? 'bg-accent border-accent-foreground/20'
              : 'bg-background border-border hover:bg-accent/40'
          }`}
        >
          <div className="flex items-center justify-between gap-2 min-w-0">
            <span className="text-xs font-mono truncate min-w-0 flex-1">
              {hit.filename.replace(/\.md$/, '')}
            </span>
            <span className="text-[10px] text-muted-foreground shrink-0">
              {hit.matchedIn === 'both'
                ? 'name+content'
                : hit.matchedIn === 'filename'
                  ? 'name'
                  : 'content'}
            </span>
          </div>
          <p className="text-[10px] text-muted-foreground mt-0.5">{hit.relPath}</p>
          {hit.snippet && (
            <p className="text-xs mt-1.5 line-clamp-2 leading-snug">
              {hit.snippet}
            </p>
          )}
        </button>
      ))}
    </div>
  );
}

function NoteView({
  note,
  onWikilink,
  onClose,
}: {
  note: NoteResponse;
  onWikilink: (slug: string) => void;
  onClose: () => void;
}) {
  return (
    <ScrollArea className="flex-1">
      <div className="p-6 max-w-3xl mx-auto">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div className="min-w-0">
            <p className="text-[11px] font-mono text-muted-foreground truncate">
              {note.relPath}
            </p>
            <h2 className="text-lg font-semibold mt-1 break-words">
              {String(note.frontmatter.title ?? '') ||
                note.relPath.split('/').pop()?.replace(/\.md$/, '')}
            </h2>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="shrink-0"
            aria-label="Close note"
          >
            Close
          </Button>
        </div>

        <FrontmatterChips frontmatter={note.frontmatter} />

        <div className="mt-5 prose prose-invert max-w-none">
          <WikiRenderer text={note.body} onWikilink={onWikilink} />
        </div>
      </div>
    </ScrollArea>
  );
}

function FrontmatterChips({ frontmatter }: { frontmatter: Frontmatter }) {
  const chips: Array<{ label: string; value: string }> = [];
  if (frontmatter.type) chips.push({ label: 'type', value: String(frontmatter.type) });
  if (frontmatter.status) chips.push({ label: 'status', value: String(frontmatter.status) });
  if (frontmatter.agent) chips.push({ label: 'agent', value: String(frontmatter.agent) });
  if (frontmatter.created) chips.push({ label: 'created', value: String(frontmatter.created) });
  if (frontmatter.updated && frontmatter.updated !== frontmatter.created)
    chips.push({ label: 'updated', value: String(frontmatter.updated) });
  if (frontmatter.session) chips.push({ label: 'session', value: String(frontmatter.session) });

  if (chips.length === 0 && (!frontmatter.tags || frontmatter.tags.length === 0))
    return null;

  return (
    <div className="rounded-lg border bg-muted/30 p-3 text-xs space-y-2">
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {chips.map((c) => (
          <span key={c.label} className="flex items-center gap-1.5">
            <span className="text-muted-foreground">{c.label}:</span>
            <span className="font-mono">{c.value}</span>
          </span>
        ))}
      </div>
      {frontmatter.tags && frontmatter.tags.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-muted-foreground">tags:</span>
          {frontmatter.tags.map((t: string) => (
            <span
              key={t}
              className="text-[10px] text-muted-foreground bg-background px-1.5 py-0.5 rounded border"
            >
              {t}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex-1 grid place-items-center p-8">
      <div className="text-center max-w-sm">
        <p className="text-sm text-muted-foreground">
          Select a note from the left to view it.
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          Inbox shows newest-first. Type to search across the full vault.
        </p>
      </div>
    </div>
  );
}
