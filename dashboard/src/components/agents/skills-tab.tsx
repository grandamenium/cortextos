'use client';

import { useState, useEffect } from 'react';
import { IconPuzzle, IconPalette, IconTag } from '@tabler/icons-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';

interface SkillInfo {
  name: string;
  type: 'builtin' | 'active';
  description: string;
}

interface SkillsData {
  skills: SkillInfo[];
  role: string | null;
  hasDesignSystem: boolean;
}

interface SkillsTabProps {
  agentName: string;
}

export function SkillsTab({ agentName }: SkillsTabProps) {
  const [data, setData] = useState<SkillsData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/agents/${encodeURIComponent(agentName)}/skills`, { signal: controller.signal })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(d => {
        if (!controller.signal.aborted) setData(d);
        if (!controller.signal.aborted) setLoading(false);
      })
      .catch(err => { if (err.name !== 'AbortError') setLoading(false); });
    return () => controller.abort();
  }, [agentName]);

  if (loading) {
    return <div className="p-6 text-muted-foreground">Loading skills...</div>;
  }

  if (!data) {
    return <div className="p-6 text-muted-foreground">Failed to load skills.</div>;
  }

  const activeSkills = data.skills.filter(s => s.type === 'active');
  const builtinSkills = data.skills.filter(s => s.type === 'builtin');

  return (
    <div className="space-y-4 p-1">
      {/* Badges row */}
      {(data.role || data.hasDesignSystem) && (
        <div className="flex flex-wrap gap-2">
          {data.role && (
            <span className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-1 text-xs font-medium text-primary">
              <IconTag size={12} />
              {data.role}
            </span>
          )}
          {data.hasDesignSystem && (
            <span className="inline-flex items-center gap-1 rounded-md bg-purple-500/10 px-2 py-1 text-xs font-medium text-purple-500">
              <IconPalette size={12} />
              Design System
            </span>
          )}
        </div>
      )}

      {/* Active Skills */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <IconPuzzle size={16} className="text-muted-foreground" />
            <CardTitle className="text-sm font-medium">Active Skills</CardTitle>
            <span className="text-xs text-muted-foreground">({activeSkills.length})</span>
          </div>
        </CardHeader>
        <CardContent>
          {activeSkills.length === 0 ? (
            <p className="text-sm text-muted-foreground">No active skills installed.</p>
          ) : (
            <div className="space-y-2">
              {activeSkills.map(skill => (
                <div key={skill.name} className="flex items-start gap-2">
                  <span className="text-sm font-medium min-w-0 shrink-0">{skill.name}</span>
                  {skill.description && (
                    <span className="text-sm text-muted-foreground truncate">{skill.description}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Built-in Skills */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <IconPuzzle size={16} className="text-muted-foreground" />
            <CardTitle className="text-sm font-medium">Built-in Skills</CardTitle>
            <span className="text-xs text-muted-foreground">({builtinSkills.length})</span>
          </div>
        </CardHeader>
        <CardContent>
          {builtinSkills.length === 0 ? (
            <p className="text-sm text-muted-foreground">No built-in skills found.</p>
          ) : (
            <div className="space-y-2">
              {builtinSkills.map(skill => (
                <div key={skill.name} className="flex items-start gap-2">
                  <span className="text-sm font-medium min-w-0 shrink-0">{skill.name}</span>
                  {skill.description && (
                    <span className="text-sm text-muted-foreground truncate">{skill.description}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
