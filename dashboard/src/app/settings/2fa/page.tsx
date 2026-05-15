'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';

type PageState = 'loading' | 'disabled' | 'setup' | 'recovery' | 'enabled';

export default function TwoFactorPage() {
  const [state, setState] = useState<PageState>('loading');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [disablePassword, setDisablePassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch('/api/auth/totp/status', { credentials: 'include' })
      .then((r) => r.json())
      .then((d) => setState(d.enabled ? 'enabled' : 'disabled'))
      .catch(() => setState('disabled'));
  }, []);

  async function startSetup() {
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/totp/setup', { credentials: 'include' });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Setup failed'); return; }
      setQrDataUrl(data.qrDataUrl);
      setSecret(data.secret);
      setState('setup');
    } catch { setError('Network error'); }
    finally { setLoading(false); }
  }

  async function confirmSetup() {
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/totp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Invalid code'); return; }
      setRecoveryCodes(data.recoveryCodes ?? []);
      setState('recovery');
    } catch { setError('Network error'); }
    finally { setLoading(false); }
  }

  async function disableTotp() {
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/totp/disable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ password: disablePassword }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Failed to disable 2FA'); return; }
      setDisablePassword('');
      setState('disabled');
    } catch { setError('Network error'); }
    finally { setLoading(false); }
  }

  if (state === 'loading') return <div className="p-8 text-muted-foreground">Loading…</div>;

  return (
    <div className="max-w-lg mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Two-Factor Authentication</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Secure your account with an authenticator app (1Password, Authy, Google Authenticator).
        </p>
      </div>

      {state === 'disabled' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">2FA is not enabled</CardTitle>
            <CardDescription>Enable 2FA for an extra layer of security.</CardDescription>
          </CardHeader>
          <CardContent>
            {error && <p className="text-sm text-destructive mb-3">{error}</p>}
            <Button onClick={startSetup} disabled={loading}>Enable 2FA</Button>
          </CardContent>
        </Card>
      )}

      {state === 'setup' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Scan QR code</CardTitle>
            <CardDescription>
              Scan this with your authenticator app, then enter the 6-digit code to confirm.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {qrDataUrl && (
              <div className="flex justify-center">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={qrDataUrl} alt="TOTP QR code" className="w-48 h-48" />
              </div>
            )}
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">Can&apos;t scan? Enter manually</summary>
              <code className="block mt-2 break-all bg-muted p-2 rounded text-xs">{secret}</code>
            </details>
            <div className="space-y-1">
              <Label htmlFor="totp-code">Verification code</Label>
              <Input
                id="totp-code"
                type="text"
                inputMode="numeric"
                maxLength={6}
                placeholder="000000"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                disabled={loading}
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button onClick={confirmSetup} disabled={loading || code.length < 6}>
              {loading ? 'Verifying…' : 'Confirm and enable'}
            </Button>
          </CardContent>
        </Card>
      )}

      {state === 'recovery' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Save your recovery codes</CardTitle>
            <CardDescription>
              Store these somewhere safe. Each code can only be used once.
              You won&apos;t be able to see them again.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-2">
              {recoveryCodes.map((c) => (
                <code key={c} className="bg-muted px-3 py-1 rounded text-sm font-mono text-center">
                  {c}
                </code>
              ))}
            </div>
            <Button onClick={() => setState('enabled')}>I&apos;ve saved these codes</Button>
          </CardContent>
        </Card>
      )}

      {state === 'enabled' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">2FA is enabled</CardTitle>
            <CardDescription>
              Your account requires an authenticator code at sign-in.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              To disable 2FA, confirm your current password.
            </p>
            <div className="space-y-1">
              <Label htmlFor="disable-pw">Current password</Label>
              <Input
                id="disable-pw"
                type="password"
                value={disablePassword}
                onChange={(e) => setDisablePassword(e.target.value)}
                disabled={loading}
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button
              variant="destructive"
              onClick={disableTotp}
              disabled={loading || !disablePassword}
            >
              {loading ? 'Disabling…' : 'Disable 2FA'}
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
