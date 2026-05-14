'use client';

import { useState, useEffect, useRef } from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  IconSearch,
  IconDatabase,
  IconFileText,
  IconBook2,
  IconAlertCircle,
  IconLoader2,
  IconChevronDown,
} from '@tabler/icons-react';
import { KnowledgeBaseView } from './kb-view';

interface SearchResult {
  content: string;
  score: number;
  source_file: string;
  doc_type: string;
  filename: string;
  collection: string;
}

interface Collection {
  name: string;
  count: number;
}

interface BrowseFile {
  source: string;
  type: string;
  chunks: number;
  collection: string;
}

interface KnowledgeBaseClientProps {
  org: string;
  markdownContent: string;
  filePath: string;
}

function collectionLabel(name: string): string {
  if (name.startsWith('agent-')) return name.replace('agent-', '') + ' (private)';
  if (name.startsWith('shared-')) return name.replace('shared-', '') + ' (shared)';
  return name;
}

function shortPath(sourcePath: string): string {
  if (!sourcePath) return '';
  const parts = sourcePath.replace(/\\/g, '/').split('/');
  if (parts.length <= 2) return sourcePath;
  return parts.slice(-2).join('/');
}

export function KnowledgeBaseClient({ org, markdownContent, filePath }: KnowledgeBaseClientProps) {
  const [query, setQuery] = useState('');
  const [selectedCollection, setSelectedCollection] = useState('all');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [collections, setCollections] = useState<Collection[]>([]);
  const [collectionsLoading, setCollectionsLoading] = useState(true);
  const [totalDocs, setTotalDocs] = useState(0);
  const [browseFiles, setBrowseFiles] = useState<BrowseFile[]>([]);
  const [browseLoading, setBrowseLoading] = useState(true);
  const [openResult, setOpenResult] = useState<SearchResult | null>(null);
  const [openFile, setOpenFile] = useState<{
    loading: boolean;
    content?: string;
    truncated?: boolean;
    size?: number;
    error?: string;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!org) { setCollectionsLoading(false); setBrowseLoading(false); return; }
    fetch(`/api/kb/collections?org=${encodeURIComponent(org)}`)
      .then((r) => r.ok ? r.json() : { collections: [] })
      .then((data) => {
        const cols: Collection[] = data.collections || [];
        setCollections(cols);
        setTotalDocs(cols.reduce((sum, c) => sum + c.count, 0));
      })
      .catch(() => {})
      .finally(() => setCollectionsLoading(false));

    // Load the default "browse all" list so the Search tab has something to
    // show before the user types a query.
    fetch(`/api/kb/list?org=${encodeURIComponent(org)}&limit=300`)
      .then((r) => r.ok ? r.json() : { files: [] })
      .then((data) => {
        setBrowseFiles(Array.isArray(data.files) ? data.files : []);
      })
      .catch(() => {})
      .finally(() => setBrowseLoading(false));
  }, [org]);

  const handleSearch = async () => {
    if (!query.trim()) return;
    setSearching(true);
    setSearched(true);
    setSearchError('');
    try {
      const params = new URLSearchParams({ q: query, limit: '10', org });
      // If a specific collection is selected, pass it as collection param (bypasses scope logic)
      if (selectedCollection === 'all') {
        params.set('scope', 'all');
      } else {
        params.set('collection', selectedCollection);
        params.set('scope', 'all');
      }
      const res = await fetch(`/api/kb/search?${params}`);
      if (res.ok) {
        const data = await res.json();
        let r: SearchResult[] = data.results || [];
        // If filtered to a specific collection, client-side filter too (belt+suspenders)
        if (selectedCollection !== 'all') {
          r = r.filter((x) => x.collection === selectedCollection);
        }
        setResults(r);
      } else {
        const data = await res.json().catch(() => ({}));
        setSearchError(data.error || `Search failed (${res.status})`);
        setResults([]);
      }
    } catch {
      setSearchError('Network error — could not reach search API');
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  const openBrowseFile = (f: BrowseFile) => {
    const pseudo: SearchResult = {
      content: '',
      score: 0,
      source_file: f.source,
      doc_type: f.type,
      filename: f.source.split('/').pop() || f.source,
      collection: f.collection,
    };
    openResultDetail(pseudo);
  };

  const openResultDetail = async (result: SearchResult) => {
    setOpenResult(result);
    if (!result.source_file) {
      setOpenFile({ loading: false, error: 'No source file path on this result.' });
      return;
    }
    setOpenFile({ loading: true });
    try {
      const res = await fetch(`/api/kb/file?path=${encodeURIComponent(result.source_file)}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setOpenFile({ loading: false, error: data.error || `Failed (${res.status})` });
        return;
      }
      const data = await res.json();
      setOpenFile({
        loading: false,
        content: data.content,
        truncated: data.truncated,
        size: data.size,
      });
    } catch (err) {
      setOpenFile({ loading: false, error: err instanceof Error ? err.message : 'Network error' });
    }
  };

  const KBStatus = () => {
    if (collectionsLoading) {
      return (
        <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <IconLoader2 size={11} className="animate-spin" />
          Loading...
        </span>
      );
    }
    if (collections.length === 0) {
      return (
        <span className="flex items-center gap-1 text-[11px] text-amber-500">
          <IconAlertCircle size={11} />
          No collections
        </span>
      );
    }
    return (
      <span className="text-[11px] text-muted-foreground">
        {totalDocs} docs across {collections.length} collection{collections.length !== 1 ? 's' : ''}
      </span>
    );
  };

  return (
    <Tabs defaultValue="search">
      <TabsList variant="line">
        <TabsTrigger value="search">
          <IconSearch size={14} className="mr-1.5" />
          Search
        </TabsTrigger>
        <TabsTrigger value="browse">
          <IconBook2 size={14} className="mr-1.5" />
          Knowledge File
        </TabsTrigger>
        <TabsTrigger value="collections">
          <IconDatabase size={14} className="mr-1.5" />
          Collections
          {!collectionsLoading && collections.length > 0 && (
            <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium">
              {collections.length}
            </span>
          )}
        </TabsTrigger>
      </TabsList>

      {/* Search Tab */}
      <TabsContent value="search" className="space-y-3 mt-3">
        <div className="flex items-center justify-between">
          <KBStatus />
        </div>

        {/* Search row: input + collection filter + button */}
        <div className="flex gap-2">
          <div className="relative flex-1">
            <IconSearch size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              placeholder="Ask anything about your org..."
              className="w-full rounded-md border bg-background pl-9 pr-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-ring/30"
              autoFocus
            />
          </div>

          {/* Collection filter dropdown — only shown once collections are loaded */}
          {!collectionsLoading && collections.length > 0 && (
            <div className="relative">
              <select
                value={selectedCollection}
                onChange={(e) => {
                  setSelectedCollection(e.target.value);
                  // Re-search if already searched
                  if (searched && query.trim()) {
                    setTimeout(handleSearch, 0);
                  }
                }}
                className="h-full appearance-none rounded-md border bg-background pl-3 pr-8 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-ring/30 cursor-pointer min-w-[140px]"
              >
                <option value="all">All collections</option>
                {collections.map((col) => (
                  <option key={col.name} value={col.name}>
                    {collectionLabel(col.name)} ({col.count})
                  </option>
                ))}
              </select>
              <IconChevronDown
                size={13}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
              />
            </div>
          )}

          <button
            onClick={handleSearch}
            disabled={searching || !query.trim()}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-opacity whitespace-nowrap"
          >
            {searching ? (
              <span className="flex items-center gap-1.5">
                <IconLoader2 size={13} className="animate-spin" />
                Searching
              </span>
            ) : 'Search'}
          </button>
        </div>

        {/* Active filter badge */}
        {selectedCollection !== 'all' && (
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-muted-foreground">Filtering by:</span>
            <Badge variant="secondary" className="text-[10px] gap-1">
              {collectionLabel(selectedCollection)}
              <button
                onClick={() => { setSelectedCollection('all'); if (searched && query.trim()) setTimeout(handleSearch, 0); }}
                className="ml-0.5 hover:text-foreground"
              >
                ×
              </button>
            </Badge>
          </div>
        )}

        {/* Error state */}
        {searchError && (
          <Card className="border-destructive/30">
            <CardContent className="py-3 flex items-center gap-2 text-sm text-destructive">
              <IconAlertCircle size={15} />
              {searchError}
            </CardContent>
          </Card>
        )}

        {/* Results */}
        {searched && !searchError && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              {results.length === 0
                ? 'No results — try different keywords or a different collection'
                : `${results.length} result${results.length !== 1 ? 's' : ''}${selectedCollection !== 'all' ? ` in ${collectionLabel(selectedCollection)}` : ''}`}
            </p>
            {results.length === 0 && (
              <Card className="border-dashed">
                <CardContent className="py-8 text-center text-sm text-muted-foreground">
                  No matching content found.
                </CardContent>
              </Card>
            )}
            {results.map((result, i) => (
              <Card
                key={i}
                role="button"
                tabIndex={0}
                onClick={() => openResultDetail(result)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openResultDetail(result);
                  }
                }}
                className="cursor-pointer hover:bg-muted/30 transition-colors focus:outline-none focus:ring-1 focus:ring-ring/40"
              >
                <CardContent className="py-3 space-y-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant="secondary" className="text-[10px]">
                      {collectionLabel(result.collection)}
                    </Badge>
                    {result.doc_type && result.doc_type !== 'text' && (
                      <Badge variant="outline" className="text-[10px]">
                        {result.doc_type}
                      </Badge>
                    )}
                    <span className="text-[10px] text-muted-foreground ml-auto tabular-nums">
                      {(result.score * 100).toFixed(0)}% match
                    </span>
                  </div>
                  <p className="text-sm leading-relaxed line-clamp-4">{result.content}</p>
                  {(result.filename || result.source_file) && (
                    <p className="text-[11px] text-muted-foreground flex items-center gap-1">
                      <IconFileText size={11} />
                      {shortPath(result.filename || result.source_file)}
                    </p>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Default browse-all state — visible before any query has been run */}
        {!searched && !searchError && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              {browseLoading
                ? 'Loading documents…'
                : `Browse — ${browseFiles.length} document${browseFiles.length !== 1 ? 's' : ''} ingested${selectedCollection !== 'all' ? ` in ${collectionLabel(selectedCollection)}` : ''}`}
            </p>

            {browseLoading && (
              <div className="space-y-2">
                {[1, 2, 3, 4, 5].map((i) => (
                  <div key={i} className="h-12 rounded-md bg-muted/30 animate-pulse" />
                ))}
              </div>
            )}

            {!browseLoading && browseFiles.length === 0 && (
              <Card className="border-dashed">
                <CardContent className="py-8 text-center text-sm text-muted-foreground">
                  No documents ingested yet. Use{' '}
                  <code className="bg-muted px-1.5 py-0.5 rounded text-xs font-mono">
                    cortextos bus kb-ingest
                  </code>{' '}
                  to add files.
                </CardContent>
              </Card>
            )}

            {!browseLoading && browseFiles.length > 0 && (
              <div className="space-y-1.5">
                {(selectedCollection === 'all'
                  ? browseFiles
                  : browseFiles.filter((f) => f.collection === selectedCollection)
                ).map((f, i) => (
                  <Card
                    key={`${f.collection}:${f.source}:${i}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => openBrowseFile(f)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        openBrowseFile(f);
                      }
                    }}
                    className="cursor-pointer hover:bg-muted/30 transition-colors focus:outline-none focus:ring-1 focus:ring-ring/40"
                  >
                    <CardContent className="py-2.5 flex items-center gap-3">
                      <IconFileText size={14} className="text-muted-foreground shrink-0" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm truncate">{shortPath(f.source)}</p>
                        <p className="text-[10px] text-muted-foreground font-mono truncate">{f.source}</p>
                      </div>
                      <Badge variant="secondary" className="text-[10px] shrink-0">
                        {collectionLabel(f.collection)}
                      </Badge>
                      <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
                        {f.chunks} chunk{f.chunks !== 1 ? 's' : ''}
                      </span>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </div>
        )}
      </TabsContent>

      {/* Browse Tab */}
      <TabsContent value="browse" className="mt-3">
        <KnowledgeBaseView
          content={markdownContent}
          org={org}
          filePath={filePath}
        />
      </TabsContent>

      {/* Collections Tab */}
      <TabsContent value="collections" className="mt-3">
        {collectionsLoading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-12 rounded-lg bg-muted/30 animate-pulse" />
            ))}
          </div>
        ) : collections.length > 0 ? (
          <div className="space-y-2">
            {collections.map((col) => (
              <Card
                key={col.name}
                className="hover:bg-muted/20 transition-colors cursor-pointer"
                onClick={() => {
                  setSelectedCollection(col.name);
                  // Switch to search tab by dispatching a click on the tab trigger
                  document.querySelector<HTMLElement>('[data-slot="tabs-trigger"][value="search"]')?.click();
                  inputRef.current?.focus();
                }}
              >
                <CardContent className="py-3 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <IconDatabase size={15} className="text-muted-foreground" />
                    <div>
                      <p className="text-sm font-medium">{collectionLabel(col.name)}</p>
                      <p className="text-[11px] text-muted-foreground font-mono">{col.name}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">{col.count} docs</Badge>
                    <span className="text-[10px] text-muted-foreground">Search →</span>
                  </div>
                </CardContent>
              </Card>
            ))}
            <p className="text-xs text-muted-foreground text-right pt-1">
              {totalDocs} total documents
            </p>
          </div>
        ) : (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center justify-center py-10 text-center">
              <div className="rounded-full bg-muted p-3 mb-3">
                <IconDatabase size={22} className="text-muted-foreground/50" />
              </div>
              <h3 className="text-sm font-medium mb-1">No collections yet</h3>
              <p className="text-xs text-muted-foreground max-w-sm mb-3">
                Ingest content to create collections. Agents automatically ingest their memory files on each heartbeat.
              </p>
              <code className="text-[10px] font-mono bg-muted px-2 py-1 rounded">
                cortextos bus kb-ingest ./file.md --org {org}
              </code>
            </CardContent>
          </Card>
        )}
      </TabsContent>

      <Dialog open={!!openResult} onOpenChange={(open) => { if (!open) { setOpenResult(null); setOpenFile(null); } }}>
        <DialogContent className="w-[92vw] sm:max-w-[92vw] md:max-w-[80vw] lg:max-w-[1100px] max-h-[90vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="text-base">
              {openResult ? (openResult.filename || shortPath(openResult.source_file) || 'Source document') : ''}
            </DialogTitle>
            <DialogDescription className="text-[11px] font-mono break-all">
              {openResult?.source_file}
            </DialogDescription>
          </DialogHeader>

          {openResult && (
            <div className="flex items-center gap-2 flex-wrap pb-1">
              <Badge variant="secondary" className="text-[10px]">
                {collectionLabel(openResult.collection)}
              </Badge>
              {openResult.doc_type && openResult.doc_type !== 'text' && (
                <Badge variant="outline" className="text-[10px]">{openResult.doc_type}</Badge>
              )}
              <span className="text-[10px] text-muted-foreground ml-auto tabular-nums">
                {(openResult.score * 100).toFixed(0)}% match
              </span>
            </div>
          )}

          <div className="flex-1 min-h-0 overflow-y-auto pr-1 space-y-3">
            {openResult?.content && (
              <div>
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Matching chunk</p>
                <div className="rounded-md bg-muted/40 p-3 text-xs whitespace-pre-wrap max-h-56 overflow-y-auto">
                  {openResult.content}
                </div>
              </div>
            )}

            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                Full source
                {openFile?.size != null && (
                  <span className="ml-2 text-muted-foreground/60 normal-case tracking-normal">
                    ({Math.round(openFile.size / 1024)} KB{openFile.truncated ? ', truncated' : ''})
                  </span>
                )}
              </p>
              <div className="rounded-md border bg-background p-4 text-xs font-mono whitespace-pre-wrap">
                {openFile?.loading && (
                  <span className="flex items-center gap-2 text-muted-foreground">
                    <IconLoader2 size={13} className="animate-spin" />
                    Loading…
                  </span>
                )}
                {openFile?.error && (
                  <span className="text-destructive">{openFile.error}</span>
                )}
                {!openFile?.loading && !openFile?.error && openFile?.content}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </Tabs>
  );
}
