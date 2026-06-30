'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDownIcon } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';

interface SkillInfo {
  slug: string;
  name: string;
  description: string;
  installed: boolean;
  installedFor: string[];
}

interface SkillCardProps {
  skill: SkillInfo;
  agents: Array<{ name: string; org: string }>;
  onRefresh: () => void;
}

export function SkillCard({ skill, agents, onRefresh }: SkillCardProps) {
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [mounted, setMounted] = useState(false);
  const [panelRect, setPanelRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const selectableAgents = agents.filter(
    (a) => !skill.installedFor.includes(`${a.org}/${a.name}`),
  );
  const allSelected =
    selectableAgents.length > 0 &&
    selectableAgents.every((a) => selected.has(`${a.org}/${a.name}`));

  useEffect(() => {
    setMounted(true);
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    function updateRect() {
      const el = triggerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setPanelRect({ top: r.bottom + 4, left: r.left, width: r.width });
    }
    updateRect();
    window.addEventListener('resize', updateRect);
    window.addEventListener('scroll', updateRect, true);
    return () => {
      window.removeEventListener('resize', updateRect);
      window.removeEventListener('scroll', updateRect, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (panelRef.current?.contains(t)) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  function toggleOne(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) => {
      if (
        selectableAgents.length > 0 &&
        selectableAgents.every((a) => prev.has(`${a.org}/${a.name}`))
      ) {
        return new Set();
      }
      return new Set(selectableAgents.map((a) => `${a.org}/${a.name}`));
    });
  }

  async function installOne(org: string, agent: string): Promise<string | null> {
    const res = await fetch('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: skill.slug, org, agent }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return data.error ?? 'Install failed';
    }
    return null;
  }

  async function handleInstall() {
    if (selected.size === 0) {
      setError('Select at least one agent');
      return;
    }
    setLoading(true);
    setError('');

    const targets = Array.from(selected).map((k) => {
      const [org, agent] = k.split('/');
      return { org, agent };
    });
    const results = await Promise.all(
      targets.map((t) => installOne(t.org, t.agent)),
    );
    const failures = results.filter((r): r is string => r !== null);
    if (failures.length > 0) {
      setError(`${failures.length} failed: ${failures[0]}`);
    }

    setSelected(new Set());
    setLoading(false);
    onRefresh();
  }

  async function handleUninstall(orgAgent: string) {
    const [org, agent] = orgAgent.split('/');
    setLoading(true);
    setError('');
    const res = await fetch('/api/skills', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: skill.slug, org, agent }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? 'Uninstall failed');
    }
    setLoading(false);
    onRefresh();
  }

  const triggerLabel =
    selected.size === 0
      ? 'Select agents...'
      : selected.size === 1
        ? Array.from(selected)[0]
        : `${selected.size} agents selected`;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <CardTitle>{skill.name}</CardTitle>
          {skill.installed ? (
            <Badge variant="secondary">Installed</Badge>
          ) : (
            <Badge variant="outline">Available</Badge>
          )}
        </div>
        <CardDescription>{skill.description}</CardDescription>
      </CardHeader>

      {skill.installedFor.length > 0 && (
        <CardContent>
          <div className="flex flex-wrap gap-1.5">
            {skill.installedFor.map((orgAgent) => (
              <span
                key={orgAgent}
                className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs"
              >
                {orgAgent}
                <button
                  type="button"
                  onClick={() => handleUninstall(orgAgent)}
                  disabled={loading}
                  className="ml-0.5 text-muted-foreground hover:text-destructive"
                  aria-label={`Uninstall from ${orgAgent}`}
                >
                  x
                </button>
              </span>
            ))}
          </div>
        </CardContent>
      )}

      <CardFooter>
        <div className="flex w-full flex-col gap-2">
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <button
                ref={triggerRef}
                type="button"
                onClick={() => setOpen((o) => !o)}
                aria-expanded={open}
                aria-haspopup="listbox"
                className="flex h-8 w-full items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-2 pl-2.5 text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30 dark:hover:bg-input/50"
              >
                <span className={cn('truncate text-left', selected.size === 0 && 'text-muted-foreground')}>
                  {triggerLabel}
                </span>
                <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
              </button>
              {open && mounted && panelRect && createPortal(
                <div
                  ref={panelRef}
                  role="listbox"
                  style={{
                    position: 'fixed',
                    top: panelRect.top,
                    left: panelRect.left,
                    width: panelRect.width,
                  }}
                  className="z-[100] max-h-64 overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
                >
                  <label
                    className={cn(
                      'flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-accent hover:text-accent-foreground',
                      selectableAgents.length === 0 && 'cursor-not-allowed opacity-50',
                    )}
                  >
                    <Checkbox
                      checked={allSelected}
                      disabled={selectableAgents.length === 0}
                      onCheckedChange={() => toggleAll()}
                    />
                    <span className="font-medium">Select all</span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {selectableAgents.length} available
                    </span>
                  </label>
                  <div className="pointer-events-none my-1 h-px bg-border" />
                  {agents.map((a) => {
                    const key = `${a.org}/${a.name}`;
                    const alreadyInstalled = skill.installedFor.includes(key);
                    return (
                      <label
                        key={key}
                        className={cn(
                          'flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-accent hover:text-accent-foreground',
                          alreadyInstalled && 'cursor-not-allowed opacity-50 hover:bg-transparent hover:text-inherit',
                        )}
                      >
                        <Checkbox
                          checked={selected.has(key)}
                          disabled={alreadyInstalled}
                          onCheckedChange={() => toggleOne(key)}
                        />
                        <span className="truncate">{key}</span>
                        {alreadyInstalled && (
                          <span className="ml-auto text-xs text-muted-foreground">installed</span>
                        )}
                      </label>
                    );
                  })}
                </div>,
                document.body,
              )}
            </div>
            <Button
              size="sm"
              onClick={handleInstall}
              disabled={loading || selected.size === 0}
            >
              Install
            </Button>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      </CardFooter>
    </Card>
  );
}
