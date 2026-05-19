'use client';

import { useMemo, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { AgentListItem } from '@/lib/agents';
import type { SkillRecord } from '@/lib/skills';
import type { RecentDispatch } from '@/lib/dispatch';

interface ClaudeCodeLauncherProps {
  agents: AgentListItem[];
  skills: SkillRecord[];
  allSkills: SkillRecord[];
  overflow: number;
  recentDispatches: RecentDispatch[];
}

function toLauncherTestId(name: string): string {
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return sanitized || 'agent';
}

export function ClaudeCodeLauncher({
  agents,
  skills,
  allSkills,
  overflow,
  recentDispatches,
}: ClaudeCodeLauncherProps) {
  const [selectedAgent, setSelectedAgent] = useState(agents[0]?.name ?? '');
  const [text, setText] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [skillsDialogOpen, setSkillsDialogOpen] = useState(false);
  const [skillQuery, setSkillQuery] = useState('');

  const orderedDispatches = useMemo(
    () => recentDispatches.slice(0, 3),
    [recentDispatches],
  );

  const filteredSkills = useMemo(() => {
    const query = skillQuery.trim().toLowerCase();
    if (!query) return allSkills;

    return allSkills.filter((skill) =>
      skill.name.toLowerCase().includes(query) ||
      skill.description.toLowerCase().includes(query),
    );
  }, [allSkills, skillQuery]);

  function applySkill(name: string) {
    setText((current) => {
      if (current.startsWith(`/${name}`)) return current;
      return `/${name} ${current}`.trimEnd();
    });
  }

  async function handleSend() {
    if (!selectedAgent || !text.trim()) return;

    setSending(true);
    setStatus(null);

    try {
      const response = await fetch('/api/home/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: selectedAgent, text }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        setStatus(payload.error ?? 'Dispatch failed');
        return;
      }

      setStatus(`Sent to @${selectedAgent}`);
      setText('');
    } catch {
      setStatus('Dispatch failed');
    } finally {
      setSending(false);
    }
  }

  return (
    <Card className="border-none bg-white py-0 shadow-sm ring-1 ring-slate-200">
      <CardContent className="space-y-4 px-5 py-5">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">Claude Code launcher</h2>
          <p className="mt-1 text-sm text-slate-600">
            Prefill a skill, point it at the right agent, and dispatch without leaving home.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {agents.map((agent) => {
            const active = selectedAgent === agent.name;
            return (
              <button
                key={agent.name}
                type="button"
                data-testid={`launcher-agent-${toLauncherTestId(agent.name)}`}
                onClick={() => setSelectedAgent(agent.name)}
                className={`rounded-full border px-3 py-1.5 text-sm transition ${
                  active
                    ? 'border-slate-900 bg-slate-900 text-white'
                    : 'border-slate-200 bg-slate-50 text-slate-700 hover:border-slate-300 hover:bg-slate-100'
                }`}
              >
                @{agent.name}
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap gap-2">
          {skills.map((skill) => (
            <button
              key={skill.name}
              type="button"
              data-testid={`launcher-skill-${skill.name}`}
              onClick={() => applySkill(skill.name)}
              className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-medium text-amber-900 transition hover:border-amber-300 hover:bg-amber-100"
            >
              /{skill.name}
            </button>
          ))}
          {overflow > 0 && (
            <button
              type="button"
              onClick={() => setSkillsDialogOpen(true)}
              className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-600"
              data-testid="launcher-skill-more"
            >
              + {overflow} more
            </button>
          )}
        </div>

        <div className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-3">
          <textarea
            data-testid="launcher-input"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={`Send a slash command to @${selectedAgent || 'agent'}…`}
            className="min-h-28 w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm text-slate-900 outline-none ring-0 placeholder:text-slate-400 focus:border-slate-400"
          />
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm text-slate-500">
              {status ? <span>{status}</span> : <span>Send to @{selectedAgent || 'agent'}</span>}
            </div>
            <Button type="button" onClick={handleSend} disabled={sending || !selectedAgent || !text.trim()}>
              {sending ? 'Sending…' : 'Send'}
            </Button>
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Recent runs</p>
          <div className="space-y-2">
            {orderedDispatches.length > 0 ? orderedDispatches.map((dispatch) => (
              <div
                key={dispatch.id}
                className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm"
              >
                <div>
                  <p className="font-medium text-slate-900">{dispatch.title}</p>
                  <p className="text-xs text-slate-500">@{dispatch.agent}</p>
                </div>
                <span className="rounded-full bg-emerald-100 px-2 py-1 text-[11px] font-semibold uppercase text-emerald-800">
                  {dispatch.status}
                </span>
              </div>
            )) : (
              <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-500">
                No recent dispatches yet.
              </div>
            )}
          </div>
        </div>

        <Dialog open={skillsDialogOpen} onOpenChange={setSkillsDialogOpen}>
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>All skills</DialogTitle>
              <DialogDescription>
                Search installed skills and inject the command directly into the Claude Code launcher.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <input
                type="search"
                value={skillQuery}
                onChange={(event) => setSkillQuery(event.target.value)}
                placeholder="Search skills"
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-slate-400"
              />

              <div className="max-h-80 overflow-y-auto rounded-xl border border-slate-200 bg-slate-50 p-3">
                <div className="flex flex-wrap gap-2">
                  {filteredSkills.length > 0 ? filteredSkills.map((skill) => (
                    <button
                      key={skill.name}
                      type="button"
                      onClick={() => {
                        applySkill(skill.name);
                        setSkillsDialogOpen(false);
                        setSkillQuery('');
                      }}
                      className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-medium text-amber-900 transition hover:border-amber-300 hover:bg-amber-100"
                    >
                      /{skill.name}
                    </button>
                  )) : (
                    <div className="text-sm text-slate-500">
                      No skills match your search.
                    </div>
                  )}
                </div>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
