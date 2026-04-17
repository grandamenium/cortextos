'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { fetchAllowedRoots, addAllowedRoot, removeAllowedRoot } from '@/lib/actions/settings';

interface AllowedRootEntry {
  path: string;
  exists: boolean;
}

interface AllowedRootsView {
  ctx_root: string;
  additional_roots: AllowedRootEntry[];
}

/**
 * Allowed Roots tab — controls which directories the dashboard media API
 * is permitted to serve files from. CTX_ROOT is always implicitly allowed.
 * Users add additional directories so agents can reference files from
 * project trees outside the default runtime directory.
 */
export function AllowedRootsTab() {
  const [view, setView] = useState<AllowedRootsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [newPath, setNewPath] = useState('');
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    const data = await fetchAllowedRoots();
    setView(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleAdd() {
    setAdding(true);
    setError('');
    const result = await addAllowedRoot(newPath);
    if (result.success) {
      setNewPath('');
      await load();
    } else {
      setError(result.error ?? 'Failed to add allowed root');
    }
    setAdding(false);
  }

  async function handleDelete(path: string) {
    setError('');
    const result = await removeAllowedRoot(path);
    if (result.success) {
      await load();
    } else {
      setError(result.error ?? 'Failed to remove allowed root');
    }
  }

  if (loading || !view) {
    return <div className="h-48 rounded-xl bg-muted/30 animate-pulse" />;
  }

  const isEmpty = view.additional_roots.length === 0;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Allowed Roots</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Path</TableHead>
                <TableHead className="w-32">Status</TableHead>
                <TableHead className="w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell className="font-mono text-xs">{view.ctx_root}</TableCell>
                <TableCell>
                  <span className="text-xs text-muted-foreground">system default</span>
                </TableCell>
                <TableCell />
              </TableRow>
              {view.additional_roots.map((entry) => (
                <TableRow key={entry.path}>
                  <TableCell className="font-mono text-xs">{entry.path}</TableCell>
                  <TableCell>
                    {entry.exists ? (
                      <span className="text-xs text-green-600">exists</span>
                    ) : (
                      <span className="text-xs text-amber-600">missing</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="destructive"
                      size="xs"
                      onClick={() => handleDelete(entry.path)}
                    >
                      Delete
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {isEmpty && (
            <p className="mt-3 text-xs text-muted-foreground">
              No additional allowed roots configured. By default, the dashboard can only serve files from{' '}
              <span className="font-mono">{view.ctx_root}</span>. Add additional directories below to allow
              agents to attach files from project trees as references.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Add Allowed Root</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-3 max-w-lg">
            <div className="grid gap-1.5">
              <Label htmlFor="new-allowed-root">Absolute path</Label>
              <Input
                id="new-allowed-root"
                value={newPath}
                onChange={(e) => setNewPath(e.target.value)}
                placeholder="/home/user/projects/my-project"
                className="font-mono text-xs"
              />
              <p className="text-[11px] text-muted-foreground">
                Must be an absolute path to an existing directory. System directories
                (drive roots, /etc, /usr, C:/Windows, etc.) are blocked for security.
              </p>
            </div>
            <Button onClick={handleAdd} disabled={adding} className="w-fit">
              {adding ? 'Adding...' : 'Add Root'}
            </Button>
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
