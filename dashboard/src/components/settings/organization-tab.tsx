'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { fetchOrgMetadata } from '@/lib/actions/settings';
import { renderMarkdown } from '@/lib/render-markdown';

interface OrgData {
  context: {
    name: string;
    description: string;
    industry: string;
    icp: string;
    value_prop: string;
  };
  brandVoice: string;
}

interface OrgConfig {
  timezone?: string;
  day_mode_start?: string;
  day_mode_end?: string;
  communication_style?: string;
  default_approval_categories?: string[];
  require_deliverables?: boolean;
}

interface OrgGoals {
  north_star: string;
  daily_focus: string;
  bottleneck: string;
  updated_at: string;
}

const APPROVAL_CATEGORIES = ['external-comms', 'financial', 'deployment', 'data-deletion'] as const;

export function OrganizationTab() {
  const [data, setData] = useState<OrgData | null>(null);
  const [loading, setLoading] = useState(true);
  const [org, setOrg] = useState<string>('');

  // Operational config state
  const [opConfig, setOpConfig] = useState<OrgConfig>({});

  // Goals state
  const [goals, setGoals] = useState<OrgGoals>({ north_star: '', daily_focus: '', bottleneck: '', updated_at: '' });
  const [goalsSaving, setGoalsSaving] = useState(false);
  const [goalsMessage, setGoalsMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [opLoading, setOpLoading] = useState(false);
  const [opSaving, setOpSaving] = useState(false);
  const [opMessage, setOpMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    const result = await fetchOrgMetadata();
    setData(result);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Discover org slug from agents list
  useEffect(() => {
    fetch('/api/agents')
      .then(r => r.json())
      .then((d: Array<{ org?: string }>) => {
        const firstOrg = d.find(a => a.org)?.org;
        if (firstOrg) setOrg(firstOrg);
      })
      .catch(() => {});
  }, []);

  // Load operational config once org is known
  useEffect(() => {
    if (!org) return;
    setOpLoading(true);
    fetch(`/api/org/config?org=${encodeURIComponent(org)}`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(d => {
        if (d.config) {
          setOpConfig({
            timezone: d.config.timezone || '',
            day_mode_start: d.config.day_mode_start || '',
            day_mode_end: d.config.day_mode_end || '',
            communication_style: d.config.communication_style || '',
            default_approval_categories: d.config.default_approval_categories || [],
            require_deliverables: !!d.config.require_deliverables,
          });
        }
        setOpLoading(false);
      })
      .catch(() => setOpLoading(false));
  }, [org]);

  // Load org goals once org is known
  useEffect(() => {
    if (!org) return;
    fetch(`/api/goals?org=${encodeURIComponent(org)}`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(d => {
        setGoals({
          north_star: d.north_star || '',
          daily_focus: d.daily_focus || '',
          bottleneck: d.bottleneck || '',
          updated_at: d.updated_at || '',
        });
      })
      .catch(() => {});
  }, [org]);

  const saveOpConfig = async () => {
    if (!org) return;
    const timeRegex = /^\d{2}:\d{2}$/;
    if (opConfig.day_mode_start && !timeRegex.test(opConfig.day_mode_start)) {
      setOpMessage({ type: 'error', text: 'Day mode start must be HH:MM format' });
      return;
    }
    if (opConfig.day_mode_end && !timeRegex.test(opConfig.day_mode_end)) {
      setOpMessage({ type: 'error', text: 'Day mode end must be HH:MM format' });
      return;
    }
    setOpSaving(true);
    setOpMessage(null);
    try {
      const res = await fetch(`/api/org/config?org=${encodeURIComponent(org)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opConfig),
      });
      const d = await res.json();
      if (!res.ok) {
        setOpMessage({ type: 'error', text: d.error || 'Failed to save' });
      } else {
        setOpMessage({ type: 'success', text: 'Saved. Agents notified to reload config.' });
      }
    } catch {
      setOpMessage({ type: 'error', text: 'Network error' });
    } finally {
      setOpSaving(false);
    }
  };

  const saveGoals = async () => {
    if (!org) return;
    setGoalsSaving(true);
    setGoalsMessage(null);
    try {
      const res = await fetch(`/api/goals?org=${encodeURIComponent(org)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          north_star: goals.north_star,
          daily_focus: goals.daily_focus,
          bottleneck: goals.bottleneck,
        }),
      });
      const d = await res.json();
      if (!res.ok) {
        setGoalsMessage({ type: 'error', text: d.error || 'Failed to save' });
      } else {
        setGoals(p => ({ ...p, updated_at: d.updated_at || '' }));
        setGoalsMessage({ type: 'success', text: 'Goals saved.' });
      }
    } catch {
      setGoalsMessage({ type: 'error', text: 'Network error' });
    } finally {
      setGoalsSaving(false);
    }
  };

  const toggleApprovalCategory = (cat: string) => {
    setOpConfig(prev => {
      const cats = prev.default_approval_categories || [];
      const next = cats.includes(cat) ? cats.filter(c => c !== cat) : [...cats, cat];
      return { ...prev, default_approval_categories: next };
    });
  };

  if (loading) {
    return <div className="h-48 rounded-xl bg-muted/30 animate-pulse" />;
  }

  if (!data || (!data.context.name && !data.brandVoice)) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <p className="text-sm text-muted-foreground">
            Organization not configured. Run{' '}
            <code className="bg-muted px-1.5 py-0.5 rounded text-xs">/cortextos-setup</code>{' '}
            to set up your Organization.
          </p>
        </CardContent>
      </Card>
    );
  }

  const fields = [
    { label: 'Name', value: data.context.name },
    { label: 'Description', value: data.context.description },
    { label: 'Industry', value: data.context.industry },
    { label: 'Audience / ICP', value: data.context.icp },
    { label: 'Value Proposition', value: data.context.value_prop },
  ];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Organization Profile</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {fields.map(({ label, value }) => (
            <div key={label}>
              <Label className="text-xs text-muted-foreground">{label}</Label>
              <p className="text-sm mt-0.5">{value || <span className="text-muted-foreground italic">Not set</span>}</p>
            </div>
          ))}
        </CardContent>
      </Card>

      {data.brandVoice && (
        <Card>
          <CardHeader>
            <CardTitle>Brand Voice</CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground">
            {renderMarkdown(data.brandVoice)}
          </CardContent>
        </Card>
      )}

      {org && (
        <Card>
          <CardHeader>
            <CardTitle>Goals</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label className="text-xs text-muted-foreground">North Star</Label>
              <textarea
                value={goals.north_star}
                onChange={e => setGoals(p => ({ ...p, north_star: e.target.value }))}
                placeholder="The long-term strategic direction that rarely changes"
                rows={2}
                className="mt-1 block w-full rounded-md border bg-background px-3 py-1.5 text-sm focus:border-primary focus:outline-none resize-y"
              />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Daily Focus</Label>
              <input
                type="text"
                value={goals.daily_focus}
                onChange={e => setGoals(p => ({ ...p, daily_focus: e.target.value }))}
                placeholder="What the whole org is focused on today"
                className="mt-1 block w-full rounded-md border bg-background px-3 py-1.5 text-sm focus:border-primary focus:outline-none"
              />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Current Bottleneck</Label>
              <input
                type="text"
                value={goals.bottleneck}
                onChange={e => setGoals(p => ({ ...p, bottleneck: e.target.value }))}
                placeholder="The ONE thing blocking progress right now"
                className="mt-1 block w-full rounded-md border bg-background px-3 py-1.5 text-sm focus:border-primary focus:outline-none"
              />
            </div>
            {goals.updated_at && (
              <p className="text-xs text-muted-foreground italic">
                Last updated {new Date(goals.updated_at).toLocaleString()}
              </p>
            )}
            {goalsMessage && (
              <div className={`rounded-md px-3 py-2 text-xs ${goalsMessage.type === 'success' ? 'bg-green-500/10 text-green-500' : 'bg-red-500/10 text-red-500'}`}>
                {goalsMessage.text}
              </div>
            )}
            <button
              onClick={saveGoals}
              disabled={goalsSaving}
              className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {goalsSaving ? 'Saving...' : 'Save Goals'}
            </button>
          </CardContent>
        </Card>
      )}

      {org && (
        <Card>
          <CardHeader>
            <CardTitle>Operational Config</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {opLoading ? (
              <div className="h-24 rounded bg-muted/30 animate-pulse" />
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs text-muted-foreground">Timezone</Label>
                    <input
                      type="text"
                      value={opConfig.timezone || ''}
                      onChange={e => setOpConfig(p => ({ ...p, timezone: e.target.value }))}
                      placeholder="America/New_York"
                      className="mt-1 block w-full rounded-md border bg-background px-3 py-1.5 text-sm focus:border-primary focus:outline-none"
                    />
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">Communication Style</Label>
                    <input
                      type="text"
                      value={opConfig.communication_style || ''}
                      onChange={e => setOpConfig(p => ({ ...p, communication_style: e.target.value }))}
                      placeholder="casual, brief, emoji-friendly"
                      className="mt-1 block w-full rounded-md border bg-background px-3 py-1.5 text-sm focus:border-primary focus:outline-none"
                    />
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">Day Mode Start</Label>
                    <input
                      type="text"
                      value={opConfig.day_mode_start || ''}
                      onChange={e => setOpConfig(p => ({ ...p, day_mode_start: e.target.value }))}
                      placeholder="08:00"
                      className="mt-1 block w-full rounded-md border bg-background px-3 py-1.5 text-sm focus:border-primary focus:outline-none"
                    />
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">Day Mode End</Label>
                    <input
                      type="text"
                      value={opConfig.day_mode_end || ''}
                      onChange={e => setOpConfig(p => ({ ...p, day_mode_end: e.target.value }))}
                      placeholder="00:00"
                      className="mt-1 block w-full rounded-md border bg-background px-3 py-1.5 text-sm focus:border-primary focus:outline-none"
                    />
                  </div>
                </div>

                <div>
                  <Label className="text-xs text-muted-foreground">Default Approval Categories</Label>
                  <div className="mt-2 flex flex-wrap gap-3">
                    {APPROVAL_CATEGORIES.map(cat => (
                      <label key={cat} className="flex items-center gap-1.5 text-sm cursor-pointer">
                        <input
                          type="checkbox"
                          checked={(opConfig.default_approval_categories || []).includes(cat)}
                          onChange={() => toggleApprovalCategory(cat)}
                          className="rounded"
                        />
                        {cat}
                      </label>
                    ))}
                  </div>
                </div>

                <div>
                  <Label className="text-xs text-muted-foreground">Task Deliverables</Label>
                  <label className="flex items-center gap-2 mt-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={!!opConfig.require_deliverables}
                      onChange={e => setOpConfig(p => ({ ...p, require_deliverables: e.target.checked }))}
                      className="rounded"
                    />
                    <span className="text-sm">Require file deliverables on task completion</span>
                  </label>
                  <p className="text-xs text-muted-foreground mt-1">
                    When enabled, agents must attach at least one file via save-output before completing a task.
                    The deliverables section appears on task detail cards in the dashboard.
                  </p>
                </div>

                {opMessage && (
                  <div className={`rounded-md px-3 py-2 text-xs ${opMessage.type === 'success' ? 'bg-green-500/10 text-green-500' : 'bg-red-500/10 text-red-500'}`}>
                    {opMessage.text}
                  </div>
                )}

                <button
                  onClick={saveOpConfig}
                  disabled={opSaving}
                  className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  {opSaving ? 'Saving...' : 'Save Operational Config'}
                </button>
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
