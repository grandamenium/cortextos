'use client';

import { useEffect, useState } from 'react';
import { IconKey, IconPlus, IconShieldCheck } from '@tabler/icons-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

type Provider = { name: string; type: string; apiKey?: string; configured: boolean; baseUrl?: string };
const TYPES = ['anthropic', 'openai', 'openrouter', 'google', 'local'];

export function ProvidersClient() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState({ name: '', type: 'anthropic', apiKey: '' });
  const [testResult, setTestResult] = useState('');

  async function load() {
    const response = await fetch('/api/settings/providers');
    const data = await response.json();
    setProviders(Array.isArray(data.providers) ? data.providers : []);
  }
  useEffect(() => {
    const id = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(id);
  }, []);

  async function test() {
    const response = await fetch('/api/settings/providers', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(draft),
    });
    const data = await response.json();
    setTestResult(data.message ?? (data.ok ? 'Provider test passed.' : 'Provider test failed.'));
  }

  async function save() {
    await fetch('/api/settings/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(draft),
    });
    setOpen(false);
    setStep(0);
    setDraft({ name: '', type: 'anthropic', apiKey: '' });
    setTestResult('');
    await load();
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Providers</h1>
          <p className="text-sm text-muted-foreground">Configured from `~/.hermes/config.yaml` providers.</p>
        </div>
        <Button onClick={() => setOpen(true)}><IconPlus size={16} /> Add provider</Button>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {providers.map((provider) => (
          <Card key={provider.name}>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center justify-between text-base">
                <span className="flex items-center gap-2"><IconKey size={18} /> {provider.name}</span>
                <Badge variant={provider.configured ? 'default' : 'secondary'}>{provider.configured ? 'Configured' : 'Missing key'}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              <p>Type: <span className="text-foreground">{provider.type}</span></p>
              <p>API key: <span className="font-mono">{provider.apiKey || 'not set'}</span></p>
              {provider.baseUrl && <p>Base URL: {provider.baseUrl}</p>}
            </CardContent>
          </Card>
        ))}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add Provider</DialogTitle></DialogHeader>
          {step === 0 && <WizardStep label="Provider name" value={draft.name} onChange={(name) => setDraft((current) => ({ ...current, name }))} />}
          {step === 1 && (
            <div className="grid gap-2">
              <Label>Provider type</Label>
              <Select value={draft.type} onValueChange={(type) => setDraft((current) => ({ ...current, type: type ?? current.type }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{TYPES.map((type) => <SelectItem key={type} value={type}>{type}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          )}
          {step === 2 && <WizardStep label="API key" value={draft.apiKey} type="password" onChange={(apiKey) => setDraft((current) => ({ ...current, apiKey }))} />}
          {step === 3 && (
            <div className="space-y-3">
              <Button variant="outline" onClick={test}><IconShieldCheck size={16} /> Test credentials</Button>
              {testResult && <p className="rounded-md border p-3 text-sm">{testResult}</p>}
            </div>
          )}
          <div className="flex justify-between gap-2 pt-3">
            <Button variant="outline" disabled={step === 0} onClick={() => setStep((current) => current - 1)}>Back</Button>
            {step < 3 ? <Button onClick={() => setStep((current) => current + 1)}>Next</Button> : <Button onClick={save}>Save</Button>}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function WizardStep({ label, value, type = 'text', onChange }: { label: string; value: string; type?: string; onChange: (value: string) => void }) {
  return (
    <div className="grid gap-2">
      <Label>{label}</Label>
      <Input type={type} value={value} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}
