'use client';

import { useState, useEffect } from 'react';
import { IconDeviceFloppy, IconTarget, IconAlertTriangle } from '@tabler/icons-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';

interface AgentGoals {
  focus: string;
  goals: string[];
  bottleneck: string;
  updated_at: string;
  updated_by: string;
}

interface GoalsTabProps {
  agentName: string;
  org: string;
}

type MessageState = { type: 'success' | 'error'; text: string } | null;

export function GoalsTab({ agentName, org }: GoalsTabProps) {
  const [goals, setGoals] = useState<AgentGoals>({
    focus: '',
    goals: [],
    bottleneck: '',
    updated_at: '',
    updated_by: '',
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<MessageState>(null);

  // Goal text area for editing — join array to newline-separated text
  const [goalsText, setGoalsText] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/agents/${encodeURIComponent(agentName)}/goals?org=${encodeURIComponent(org)}`, {
      signal: controller.signal,
    })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(d => {
        if (!controller.signal.aborted && d.goals) {
          const g = d.goals as AgentGoals;
          setGoals(g);
          const arr = Array.isArray(g.goals) ? g.goals : [];
          setGoalsText(arr.join('\n'));
        }
        if (!controller.signal.aborted) setLoading(false);
      })
      .catch(err => { if (err.name !== 'AbortError') setLoading(false); });
    return () => controller.abort();
  }, [agentName, org]);

  const save = async () => {
    setSaving(true);
    setMessage(null);
    const goalsArray = goalsText
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0);
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentName)}/goals?org=${encodeURIComponent(org)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          focus: goals.focus,
          goals: goalsArray,
          bottleneck: goals.bottleneck,
          updated_by: 'dashboard',
        }),
      });
      const d = await res.json();
      if (!res.ok) {
        setMessage({ type: 'error', text: d.error || 'Failed to save' });
      } else {
        if (d.goals) {
          const g = d.goals as AgentGoals;
          setGoals(g);
          const arr = Array.isArray(g.goals) ? g.goals : [];
          setGoalsText(arr.join('\n'));
        }
        setMessage({ type: 'success', text: 'Saved. GOALS.md will be regenerated.' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Network error' });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="p-6 text-muted-foreground">Loading goals...</div>;
  }

  const updatedLabel = goals.updated_at
    ? `Last updated ${new Date(goals.updated_at).toLocaleString()}${goals.updated_by ? ` by ${goals.updated_by}` : ''}`
    : 'Not yet set';

  return (
    <div className="space-y-4 p-1">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <IconTarget size={16} className="text-muted-foreground" />
            <CardTitle className="text-sm font-medium">Agent Goals</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-start gap-2 rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-xs text-warning">
            <IconAlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>
              These fields are stored in <code className="font-mono">goals.json</code>, the
              structured source. Saving updates it and regenerates{' '}
              <code className="font-mono">GOALS.md</code> from it (when the built CLI is
              available); the generated file is overwritten, so anything hand-authored
              directly in <code className="font-mono">GOALS.md</code> is replaced.
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            Set by the orchestrator during morning cascade. Editable here for overrides.
          </p>

          <div>
            <label className="text-xs text-muted-foreground">Daily Focus</label>
            <input
              type="text"
              value={goals.focus}
              onChange={e => setGoals(p => ({ ...p, focus: e.target.value }))}
              placeholder="What this agent is focused on today"
              className="mt-1 block w-full rounded-md border bg-background px-3 py-1.5 text-sm focus:border-primary focus:outline-none"
            />
          </div>

          <div>
            <label className="text-xs text-muted-foreground">
              Goals (one per line)
            </label>
            <textarea
              value={goalsText}
              onChange={e => setGoalsText(e.target.value)}
              placeholder={"Write a weekly report\nReview open tasks\nResearch competitor pricing"}
              rows={5}
              className="mt-1 block w-full rounded-md border bg-background px-3 py-1.5 text-sm focus:border-primary focus:outline-none resize-y"
            />
          </div>

          <div>
            <label className="text-xs text-muted-foreground">Bottleneck</label>
            <input
              type="text"
              value={goals.bottleneck}
              onChange={e => setGoals(p => ({ ...p, bottleneck: e.target.value }))}
              placeholder="What's blocking this agent right now? (or leave blank)"
              className="mt-1 block w-full rounded-md border bg-background px-3 py-1.5 text-sm focus:border-primary focus:outline-none"
            />
          </div>

          <p className="text-xs text-muted-foreground italic">{updatedLabel}</p>

          {message && (
            <div className={`rounded-md px-3 py-2 text-xs ${message.type === 'success' ? 'bg-green-500/10 text-green-500' : 'bg-red-500/10 text-red-500'}`}>
              {message.text}
            </div>
          )}

          <button
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            <IconDeviceFloppy size={14} />
            {saving ? 'Saving...' : 'Save Goals'}
          </button>
        </CardContent>
      </Card>
    </div>
  );
}
