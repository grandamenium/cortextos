'use client';

import { useEffect, useState } from 'react';
import { IconPlayerPause, IconPlayerPlay, IconPlus, IconRefresh, IconTrash } from '@tabler/icons-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';

type Job = { id: string; name?: string; prompt?: string; schedule_display?: string; schedule?: unknown; state?: string; enabled?: boolean; next_run_at?: string; last_run_at?: string; last_run_success?: boolean };

export function JobsClient() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [busCrons, setBusCrons] = useState<unknown[]>([]);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ name: '', schedule: 'daily', prompt: '', repeat: '', agent: '' });
  const [expanded, setExpanded] = useState('');
  const [output, setOutput] = useState('');

  async function load() {
    const response = await fetch('/api/hermes/jobs?include_disabled=true');
    const data = await response.json();
    setJobs(Array.isArray(data.hermesJobs) ? data.hermesJobs : []);
    setBusCrons(Array.isArray(data.busCrons) ? data.busCrons : []);
  }
  useEffect(() => {
    const id = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(id);
  }, []);

  async function create() {
    await fetch('/api/hermes/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...draft, repeat: draft.repeat ? Number(draft.repeat) : undefined, target_agent: draft.agent || undefined }),
    });
    setOpen(false);
    setDraft({ name: '', schedule: 'daily', prompt: '', repeat: '', agent: '' });
    await load();
  }

  async function action(job: Job, next: string) {
    await fetch(`/api/hermes/jobs/${encodeURIComponent(job.id)}?action=${next}`, { method: 'POST' });
    await load();
  }

  async function remove(job: Job) {
    await fetch(`/api/hermes/jobs/${encodeURIComponent(job.id)}`, { method: 'DELETE' });
    await load();
  }

  async function showOutput(job: Job) {
    setExpanded(expanded === job.id ? '' : job.id);
    const response = await fetch(`/api/hermes/jobs/${encodeURIComponent(job.id)}/output?limit=1`);
    const data = await response.json();
    const outputs = Array.isArray(data) ? data : Array.isArray(data.outputs) ? data.outputs : [];
    setOutput(outputs[0]?.content ?? outputs[0]?.text ?? 'No output recorded.');
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Jobs</h1>
          <p className="text-sm text-muted-foreground">Workspace crons from cortextOS bus plus Hermes jobs.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={load}><IconRefresh size={16} /> Refresh</Button>
          <Button onClick={() => setOpen(true)}><IconPlus size={16} /> Create job</Button>
        </div>
      </div>

      {busCrons.length > 0 && <Card><CardHeader><CardTitle className="text-base">cortextOS bus crons</CardTitle></CardHeader><CardContent><pre className="max-h-52 overflow-auto text-xs">{JSON.stringify(busCrons, null, 2)}</pre></CardContent></Card>}

      <div className="grid gap-3">
        {jobs.map((job) => {
          const paused = job.state === 'paused' || job.enabled === false;
          return (
            <Card key={job.id}>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center justify-between gap-3 text-base">
                  <span>{job.name || job.id}</span>
                  <Badge variant={paused ? 'secondary' : 'default'}>{paused ? 'Paused' : job.state || 'Active'}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm text-muted-foreground">{job.prompt}</p>
                <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                  <span>{job.schedule_display || JSON.stringify(job.schedule ?? 'custom')}</span>
                  <span>Next: {job.next_run_at || 'not scheduled'}</span>
                  <span>Last: {job.last_run_at || 'never'}</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => action(job, 'run')}><IconPlayerPlay size={14} /> Run now</Button>
                  <Button size="sm" variant="outline" onClick={() => action(job, paused ? 'resume' : 'pause')}>{paused ? <IconPlayerPlay size={14} /> : <IconPlayerPause size={14} />} {paused ? 'Resume' : 'Pause'}</Button>
                  <Button size="sm" variant="outline" onClick={() => showOutput(job)}>Output</Button>
                  <Button size="sm" variant="outline" onClick={() => remove(job)}><IconTrash size={14} /> Delete</Button>
                </div>
                {expanded === job.id && <pre className="max-h-72 overflow-auto rounded-md border bg-muted p-3 text-xs">{output}</pre>}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Create Job</DialogTitle></DialogHeader>
          <div className="grid gap-3">
            <Field label="Name" value={draft.name} onChange={(name) => setDraft((current) => ({ ...current, name }))} />
            <Field label="Schedule" value={draft.schedule} onChange={(schedule) => setDraft((current) => ({ ...current, schedule }))} />
            <Field label="Agent target" value={draft.agent} onChange={(agent) => setDraft((current) => ({ ...current, agent }))} />
            <Field label="Repeat count" value={draft.repeat} onChange={(repeat) => setDraft((current) => ({ ...current, repeat }))} />
            <div className="grid gap-2"><Label>Prompt</Label><Textarea value={draft.prompt} onChange={(event) => setDraft((current) => ({ ...current, prompt: event.target.value }))} /></div>
            <Button onClick={create}>Create</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <div className="grid gap-2"><Label>{label}</Label><Input value={value} onChange={(event) => onChange(event.target.value)} /></div>;
}
