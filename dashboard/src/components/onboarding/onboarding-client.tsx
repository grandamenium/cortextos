'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const steps = ['Welcome', 'Detect provider', 'Connect provider', 'Create or import org', 'Add agent', 'Telegram bot', 'Done'];

export function OnboardingClient() {
  const [step, setStep] = useState(0);
  const [state, setState] = useState<{ providersDetected?: boolean; orgs?: string[]; paths?: Record<string, string> }>({});
  const [telegram, setTelegram] = useState('');
  useEffect(() => {
    fetch('/api/onboarding').then((res) => res.json()).then(setState).catch(() => undefined);
  }, []);

  async function complete() {
    await fetch('/api/onboarding', { method: 'POST' });
    setStep(6);
  }

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-3xl items-center">
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>cortextOS Onboarding</span>
            <span className="text-sm text-muted-foreground">{step + 1} / {steps.length}</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex flex-wrap gap-2">
            {steps.map((label, index) => <span key={label} className={`rounded-full border px-2 py-1 text-xs ${index === step ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}>{label}</span>)}
          </div>
          {step === 0 && <Panel title="Welcome" body="Set up the daily-use cortextOS dashboard for Hermes-backed agents." />}
          {step === 1 && <Panel title="Detect provider" body={state.providersDetected ? `Found providers in ${state.paths?.hermesConfig}.` : `No providers found in ${state.paths?.hermesConfig ?? '~/.hermes/config.yaml'}.`} />}
          {step === 2 && <Panel title="Connect provider" body="Use the provider wizard for API keys. Nous Portal OAuth/device-code can be wired when the portal endpoint is available." action={<Link href="/settings/providers"><Button variant="outline">Open provider wizard</Button></Link>} />}
          {step === 3 && <Panel title="Create or import org" body={(state.orgs?.length ?? 0) > 0 ? `Existing orgs detected: ${state.orgs?.join(', ')}` : 'No orgs detected yet under cortextos/orgs.'} />}
          {step === 4 && <Panel title="Add agent" body="Run cortextos add-agent in your terminal, then return here. The dashboard will pick up CLI-created agents." action={<Link href="/agents"><Button variant="outline">Open agents</Button></Link>} />}
          {step === 5 && (
            <div className="grid gap-3">
              <Panel title="Telegram bot" body="Paste a bot token to keep it handy while testing setup." />
              <div className="grid gap-2"><Label>Bot token</Label><Input type="password" value={telegram} onChange={(event) => setTelegram(event.target.value)} placeholder="123456:ABC..." /></div>
            </div>
          )}
          {step === 6 && <Panel title="Done" body={`Onboarding marker written to ${state.paths?.onboarded ?? '~/.cortextos/default/.onboarded'}.`} action={<Link href="/"><Button>Go to dashboard</Button></Link>} />}
          <div className="flex justify-between">
            <Button variant="outline" disabled={step === 0} onClick={() => setStep((current) => current - 1)}>Back</Button>
            {step < 5 && <Button onClick={() => setStep((current) => current + 1)}>Next</Button>}
            {step === 5 && <Button onClick={complete}>Complete</Button>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Panel({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return <div className="space-y-3"><h2 className="text-xl font-semibold">{title}</h2><p className="text-sm text-muted-foreground">{body}</p>{action}</div>;
}
