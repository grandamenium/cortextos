'use client';

import { useState, useEffect } from 'react';
import { IconAlertTriangle, IconCircleCheck, IconDeviceFloppy, IconTarget } from '@tabler/icons-react';
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
type GoalsFreshness =
  | { status: 'fresh'; label: string; description: string }
  | { status: 'stale'; label: string; description: string }
  | { status: 'critical'; label: string; description: string }
  | { status: 'missing'; label: string; description: string };

const STALE_GOALS_HOURS = 24;
const CRITICAL_GOALS_HOURS = 72;

function formatAge(hours: number) {
  if (hours < 1) return 'less than 1h';
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function getGoalsFreshness(updatedAt: string, updatedBy?: string): GoalsFreshness {
  if (!updatedAt) {
    return {
      status: 'missing',
      label: 'No goals timestamp',
      description: 'GOALS.md has no last-updated marker, so current policy drift cannot be ruled out.',
    };
  }

  const updatedTime = new Date(updatedAt).getTime();
  if (Number.isNaN(updatedTime)) {
    return {
      status: 'missing',
      label: 'Invalid goals timestamp',
      description: 'GOALS.md has an unreadable last-updated marker. Refresh it before using it as operating policy.',
    };
  }

  const ageHours = Math.max(0, Math.floor((Date.now() - updatedTime) / 36e5));
  const ageLabel = formatAge(ageHours);
  const owner = updatedBy ? ` by ${updatedBy}` : '';

  if (ageHours >= CRITICAL_GOALS_HOURS) {
    return {
      status: 'critical',
      label: `${ageLabel} stale`,
      description: `GOALS.md was last updated ${ageLabel} ago${owner}. Confirm it still matches current policy before acting on it.`,
    };
  }

  if (ageHours >= STALE_GOALS_HOURS) {
    return {
      status: 'stale',
      label: `${ageLabel} stale`,
      description: `GOALS.md was last updated ${ageLabel} ago${owner}. It may have drifted from the latest operating policy.`,
    };
  }

  return {
    status: 'fresh',
    label: 'Fresh',
    description: `GOALS.md was refreshed ${ageLabel} ago${owner}.`,
  };
}

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
  const freshness = getGoalsFreshness(goals.updated_at, goals.updated_by);
  const showFreshnessWarning = freshness.status !== 'fresh';

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
          <p className="text-xs text-muted-foreground">
            Set by the orchestrator during morning cascade. Editable here for overrides.
            Changes regenerate GOALS.md automatically.
          </p>

          {showFreshnessWarning && (
            <div className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${
              freshness.status === 'critical'
                ? 'border-destructive/40 bg-destructive/10 text-destructive'
                : 'border-warning/50 bg-warning/10 text-warning'
            }`}>
              <IconAlertTriangle size={16} className="mt-0.5 shrink-0" />
              <div className="space-y-0.5">
                <p className="font-medium">{freshness.label}</p>
                <p className="text-xs opacity-90">{freshness.description}</p>
              </div>
            </div>
          )}

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

          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-muted-foreground italic">{updatedLabel}</p>
            <span className={`inline-flex w-fit items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
              freshness.status === 'fresh'
                ? 'border-green-500/30 bg-green-500/10 text-green-600'
                : freshness.status === 'critical'
                  ? 'border-destructive/30 bg-destructive/10 text-destructive'
                  : 'border-warning/40 bg-warning/10 text-warning'
            }`}>
              {freshness.status === 'fresh' ? <IconCircleCheck size={12} /> : <IconAlertTriangle size={12} />}
              {freshness.label}
            </span>
          </div>

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
