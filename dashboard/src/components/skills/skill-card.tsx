'use client';

import { useState } from 'react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { IconExternalLink } from '@tabler/icons-react';
interface SkillInfo {
  slug: string;
  name: string;
  description: string;
  version?: string | null;
  source?: string | null;
  lastUpdated?: string | null;
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
  const [selectedAgent, setSelectedAgent] = useState<string>('');
  const [error, setError] = useState('');

  async function handleInstall() {
    if (!selectedAgent) {
      setError('Select an agent first');
      return;
    }
    const [org, agent] = selectedAgent.split('/');
    setLoading(true);
    setError('');
    const res = await fetch('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: skill.slug, org, agent }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? 'Install failed');
    }
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

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              <CardTitle className="truncate">{skill.name}</CardTitle>
              {skill.version && (
                <span className="text-[10px] font-mono text-muted-foreground">
                  v{skill.version}
                </span>
              )}
            </div>
            {skill.source && (
              <a
                href={skill.source}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground mt-0.5 truncate max-w-full"
              >
                <IconExternalLink size={10} aria-hidden="true" />
                <span className="truncate">{skill.source.replace(/^https?:\/\//, '')}</span>
              </a>
            )}
            {skill.lastUpdated && !skill.source && (
              <p className="text-[11px] text-muted-foreground mt-0.5">
                updated {skill.lastUpdated}
              </p>
            )}
          </div>
          {skill.installed ? (
            <Badge variant="secondary" className="shrink-0">Installed</Badge>
          ) : (
            <Badge variant="outline" className="shrink-0">Available</Badge>
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
            <Select value={selectedAgent} onValueChange={(v) => setSelectedAgent(v ?? '')}>
              <SelectTrigger className="flex-1">
                <SelectValue placeholder="Select agent..." />
              </SelectTrigger>
              <SelectContent>
                {agents.map((a) => {
                  const key = `${a.org}/${a.name}`;
                  const alreadyInstalled = skill.installedFor.includes(key);
                  return (
                    <SelectItem key={key} value={key} disabled={alreadyInstalled}>
                      {key}{alreadyInstalled ? ' (installed)' : ''}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              onClick={handleInstall}
              disabled={loading || !selectedAgent}
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
