'use client';

import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { renderMarkdown } from '@/lib/render-markdown';

type Skill = {
  name: string;
  description: string;
  category: string;
  sourcePath: string;
  origin: 'hermes-local' | 'cortextos-agent' | 'community';
  content: string;
};

export function Skills({ agentName }: { agentName: string }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('All');
  const [categories, setCategories] = useState<string[]>(['All']);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [selected, setSelected] = useState<Skill | null>(null);

  useEffect(() => {
    const params = new URLSearchParams({ q: query, category });
    fetch(`/api/agents/${encodeURIComponent(agentName)}/inspector/skills?${params}`)
      .then((response) => response.json())
      .then((payload: { skills: Skill[]; categories: string[] }) => {
        setSkills(payload.skills || []);
        setCategories(payload.categories || ['All']);
        setSelected((current) => current ?? payload.skills?.[0] ?? null);
      })
      .catch(() => setSkills([]));
  }, [agentName, query, category]);

  const visible = useMemo(() => skills, [skills]);

  return (
    <div className="grid min-h-[620px] grid-cols-[360px_1fr] overflow-hidden rounded-lg border bg-card">
      <aside className="grid grid-rows-[auto_1fr] border-r">
        <div className="space-y-2 border-b p-3">
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search skills" />
          <select value={category} onChange={(event) => setCategory(event.target.value)} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
            {categories.map((item) => <option key={item}>{item}</option>)}
          </select>
        </div>
        <div className="overflow-y-auto p-2">
          {visible.map((skill) => (
            <button key={skill.sourcePath} onClick={() => setSelected(skill)} className="mb-2 w-full rounded-md border p-3 text-left hover:bg-muted">
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-sm font-medium">{skill.name}</p>
                <Badge variant="secondary">{skill.origin}</Badge>
              </div>
              <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{skill.description || skill.sourcePath}</p>
            </button>
          ))}
        </div>
      </aside>
      <section className="overflow-y-auto p-5">
        {selected ? (
          <div>
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-semibold">{selected.name}</h2>
              <Badge>{selected.category}</Badge>
              <Badge variant="outline">{selected.origin}</Badge>
            </div>
            <p className="mb-4 break-all font-mono text-xs text-muted-foreground">{selected.sourcePath}</p>
            <div className="prose prose-sm max-w-none dark:prose-invert">{renderMarkdown(selected.content)}</div>
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">No skill selected.</div>
        )}
      </section>
    </div>
  );
}
