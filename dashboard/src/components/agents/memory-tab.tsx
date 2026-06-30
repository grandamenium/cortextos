'use client';

import { useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion';
import {
  IconDeviceFloppy,
  IconAlertTriangle,
  IconFileText,
} from '@tabler/icons-react';
import type { MemoryFile } from '@/lib/types';

interface MemoryTabProps {
  agentName: string;
  org: string;
  memoryRaw: string;
  memoryHash: string;
  memoryFiles: MemoryFile[];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function MemoryTab({
  agentName,
  org,
  memoryRaw: initialMemoryRaw,
  memoryHash,
  memoryFiles,
}: MemoryTabProps) {
  const [memoryRaw, setMemoryRaw] = useState(initialMemoryRaw);
  // The hash of the version currently on disk, as last seen by this tab. Seeded
  // from the server-issued load hash and refreshed after each successful save so
  // consecutive saves don't false-409 (#515).
  const [currentHash, setCurrentHash] = useState(memoryHash);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [expandedFiles, setExpandedFiles] = useState<Record<string, string>>(
    {},
  );
  const [loadingFile, setLoadingFile] = useState<string | null>(null);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setConflict(false);
    setSaved(false);

    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentName)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memoryRaw, memoryHash: currentHash, org }),
      });

      // 409 = MEMORY.md changed on disk since this tab loaded (#515). Keep the
      // operator's edits in the textarea and prompt a reload rather than
      // clobbering the newer on-disk content.
      if (res.status === 409) {
        setConflict(true);
        return;
      }

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? 'Failed to save');
      }

      // Advance our on-disk baseline to what we just wrote so the next save in
      // this tab compares against the right version (#515).
      const data = await res.json().catch(() => ({}));
      if (typeof data.memoryHash === 'string') {
        setCurrentHash(data.memoryHash);
      }
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const loadFileContent = useCallback(
    async (file: MemoryFile) => {
      if (expandedFiles[file.date]) return; // Already loaded
      setLoadingFile(file.date);

      try {
        const res = await fetch(
          `/api/agents/${encodeURIComponent(agentName)}/memory?path=${encodeURIComponent(file.path)}`,
        );
        const content = await res.text();
        setExpandedFiles((prev) => ({ ...prev, [file.date]: content }));
      } catch {
        setExpandedFiles((prev) => ({
          ...prev,
          [file.date]: 'Failed to load file content.',
        }));
      } finally {
        setLoadingFile(null);
      }
    },
    [agentName, expandedFiles],
  );

  return (
    <div className="space-y-6">
      {/* Save feedback */}
      {saved && (
        <div className="flex items-center gap-2 rounded-lg border border-warning/50 bg-warning/10 px-4 py-3 text-sm text-warning">
          <IconAlertTriangle size={16} />
          <span>Memory saved. Agent will pick up changes on next cycle.</span>
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <IconAlertTriangle size={16} />
          <span>{error}</span>
        </div>
      )}
      {conflict && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <IconAlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>
            MEMORY.md changed on disk since you opened this tab, so the save was
            blocked to avoid overwriting it. Your edits are still here — copy
            them somewhere safe, then reload the page to pull the latest version
            and re-apply them. (Reloading now would discard this draft, so it is
            not done automatically.)
          </span>
        </div>
      )}

      {/* MEMORY.md editor */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
            MEMORY.md
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            value={memoryRaw}
            onChange={(e) => {
              setMemoryRaw(e.target.value);
              setSaved(false);
            }}
            rows={10}
            className="font-mono text-xs"
            placeholder="No memory file found."
          />
          <div className="flex justify-end">
            <Button size="sm" onClick={handleSave} disabled={saving}>
              <IconDeviceFloppy size={14} data-icon="inline-start" />
              {saving ? 'Saving...' : 'Save Memory'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Daily memory files */}
      {memoryFiles.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
              Daily Memory Files
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Accordion>
              {memoryFiles.map((file) => (
                <AccordionItem key={file.date} value={file.date}>
                  <AccordionTrigger
                    onClick={() => loadFileContent(file)}
                  >
                    <div className="flex items-center gap-2">
                      <IconFileText size={14} className="text-muted-foreground" />
                      <span>{file.date}</span>
                      <span className="text-xs text-muted-foreground">
                        ({formatBytes(file.size)})
                      </span>
                      {loadingFile === file.date && (
                        <span className="text-xs text-muted-foreground">
                          Loading...
                        </span>
                      )}
                    </div>
                  </AccordionTrigger>
                  <AccordionContent>
                    <pre className="whitespace-pre-wrap rounded bg-muted/50 p-3 font-mono text-xs">
                      {expandedFiles[file.date] ?? 'Loading...'}
                    </pre>
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
