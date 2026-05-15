'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
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
import { SplashScreen } from '@/components/layout/splash-screen';

const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? '';
const TURNSTILE_CB = '__onTurnstileLoad';

declare global {
  interface Window {
    [TURNSTILE_CB]?: () => void;
    turnstile?: {
      render: (el: HTMLElement, opts: Record<string, unknown>) => string;
      reset: (widgetId: string) => void;
      getResponse: (widgetId: string) => string | undefined;
    };
  }
}

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showSplash, setShowSplash] = useState(false);

  // Step 2: TOTP
  const [totpStep, setTotpStep] = useState(false);
  const [totpCode, setTotpCode] = useState('');
  const usernameRef = useRef('');
  const passwordRef = useRef('');

  // Turnstile
  const turnstileContainerRef = useRef<HTMLDivElement>(null);
  const turnstileWidgetId = useRef<string | null>(null);
  const turnstileReady = useRef(false);
  const [turnstileLoaded, setTurnstileLoaded] = useState(!TURNSTILE_SITE_KEY);

  useEffect(() => {
    if (!TURNSTILE_SITE_KEY) return;

    // Skip if Turnstile is already loaded (StrictMode double-invoke, HMR, etc.)
    if (window.turnstile && turnstileContainerRef.current && !turnstileWidgetId.current) {
      renderWidget();
      return;
    }

    function renderWidget() {
      if (!turnstileContainerRef.current || !window.turnstile || turnstileWidgetId.current) return;
      turnstileWidgetId.current = window.turnstile.render(turnstileContainerRef.current, {
        sitekey: TURNSTILE_SITE_KEY,
        callback: () => { turnstileReady.current = true; },
        'expired-callback': () => { turnstileReady.current = false; },
        'error-callback': () => {
          turnstileReady.current = false;
          console.error('[turnstile] Widget render error — challenge may be blocked');
        },
        theme: 'auto',
      });
      setTurnstileLoaded(true);
    }

    // Use ?onload= callback so CF calls us when the global is truly set —
    // avoids race where onload fires before window.turnstile is attached.
    window[TURNSTILE_CB] = renderWidget;

    // Dedupe: skip inject if script already in DOM from prior mount
    const existingScript = document.querySelector(
      'script[src*="challenges.cloudflare.com/turnstile"]',
    );
    if (existingScript) {
      // Script already injected — just wire callback; global may already be ready
      if (window.turnstile) renderWidget();
      return;
    }

    const script = document.createElement('script');
    script.src = `https://challenges.cloudflare.com/turnstile/v0/api.js?onload=${TURNSTILE_CB}&render=explicit`;
    script.async = true;
    script.defer = true;
    script.onerror = () => {
      console.error('[turnstile] Script failed to load from challenges.cloudflare.com');
      setTurnstileLoaded(true); // Unblock button so auth still works (server will bypass if token absent)
    };
    document.head.appendChild(script);

    // Fallback retry: if window.turnstile still absent after 5s, re-inject once
    const retryTimer = setTimeout(() => {
      if (!window.turnstile) {
        console.warn('[turnstile] window.turnstile not set after 5s — retrying script inject');
        script.remove();
        const retry = document.createElement('script');
        retry.src = script.src;
        retry.async = true;
        retry.defer = true;
        retry.onerror = () => {
          console.error('[turnstile] Retry script also failed — widget unavailable');
          setTurnstileLoaded(true);
        };
        document.head.appendChild(retry);
      }
    }, 5000);

    // Cleanup: clear timer + callback, but don't remove script to avoid mid-load kill
    return () => {
      clearTimeout(retryTimer);
      delete window[TURNSTILE_CB];
    };
  }, []);

  // Redirect to setup if no users exist
  useEffect(() => {
    fetch('/api/setup')
      .then((res) => res.json())
      .then((data) => { if (data.needsSetup) router.push('/setup'); })
      .catch(() => {});
  }, [router]);

  const csrfTokenRef = useRef<string>('');
  const [csrfReady, setCsrfReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/auth/csrf', { credentials: 'same-origin' });
        const data = await res.json();
        if (cancelled) return;
        const token = data?.csrfToken;
        if (!token) { console.error('[login] /api/auth/csrf returned no token', data); return; }
        csrfTokenRef.current = token;
        setCsrfReady(true);
      } catch (err) { console.error('[login] csrf fetch failed:', err); }
    })();
    return () => { cancelled = true; };
  }, []);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    setLoading(true);

    const form = e.currentTarget;

    if (!totpStep) {
      // Step 1: Collect credentials, check if TOTP is needed
      const username = (form.querySelector('input[name="username"]') as HTMLInputElement)?.value ?? '';
      const password = (form.querySelector('input[name="password"]') as HTMLInputElement)?.value ?? '';

      // Check TOTP requirement before auth.js POST
      try {
        const checkRes = await fetch(`/api/auth/totp-required?username=${encodeURIComponent(username)}`, {
          credentials: 'include',
        });
        const { required } = await checkRes.json().catch(() => ({ required: false }));

        if (required) {
          usernameRef.current = username;
          passwordRef.current = password;
          setLoading(false);
          setTotpStep(true);
          return;
        }
      } catch {
        // Non-fatal: proceed without TOTP check
      }

      await submitToAuthJs(username, password, '', form.action);
    } else {
      // Step 2: TOTP code collected — submit everything to auth.js
      await submitToAuthJs(usernameRef.current, passwordRef.current, totpCode, '/api/auth/callback/credentials');
    }
  }

  async function submitToAuthJs(username: string, password: string, totp: string, action: string) {
    const turnstileToken = TURNSTILE_SITE_KEY && turnstileWidgetId.current
      ? (window.turnstile?.getResponse(turnstileWidgetId.current) ?? '')
      : '';

    // Re-fetch CSRF token at submit time so body token matches the current
    // cookie. React StrictMode double-invokes the mount-time CSRF useEffect
    // in dev; if the two in-flight /api/auth/csrf responses resolve out of
    // order, the browser's authjs.csrf-token cookie can end up pinned to a
    // different token than csrfTokenRef.current — which the server rejects
    // as MissingCSRF. An atomic fetch-then-submit here forces cookie and
    // body into sync regardless of earlier mount-time races.
    let submitToken = csrfTokenRef.current;
    try {
      const freshCsrf = await fetch('/api/auth/csrf', { credentials: 'same-origin', cache: 'no-store' });
      const freshData = await freshCsrf.json();
      if (freshData?.csrfToken) submitToken = freshData.csrfToken;
    } catch {
      // Fall back to the mount-time token if the refetch fails.
    }

    const body = new URLSearchParams();
    body.set('csrfToken', csrfTokenRef.current || '');
    body.set('username', username);
    body.set('password', password);
    if (totp) body.set('totp_code', totp);
    if (turnstileToken) body.set('turnstileToken', turnstileToken);

    try {
      const res = await fetch(action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        credentials: 'include',
        redirect: 'follow',
      });

      if (res.redirected) {
        const target = new URL(res.url);
        if (target.pathname.startsWith('/login')) {
          const code = target.searchParams.get('error') || 'Unknown';
          const msg = code === 'CallbackRouteError'
            ? totpStep
              ? 'Invalid authenticator code. Try again.'
              : 'Too many attempts. Please wait a few minutes and try again.'
            : `Sign-in failed: ${code}`;
          setError(msg);
          setLoading(false);
          // Reset Turnstile on failure
          if (turnstileWidgetId.current && window.turnstile) {
            window.turnstile.reset(turnstileWidgetId.current);
            turnstileReady.current = false;
          }
          return;
        }
        const callbackParam = new URL(window.location.href).searchParams.get('callbackUrl');
        const safeTarget = callbackParam && callbackParam.startsWith('/') && !callbackParam.startsWith('//')
          ? callbackParam : '/';
        setShowSplash(true);
        window.location.href = safeTarget;
        return;
      }
      if (res.ok) {
        setShowSplash(true);
        window.location.href = '/';
        return;
      }
      setError(`Sign-in failed with status ${res.status}`);
      setLoading(false);
    } catch (err) {
      console.error('[login] submit error:', err);
      setError('Network error. Please try again.');
      setLoading(false);
    }
  }

  const handleSplashComplete = useCallback(() => {}, []);
  const canSubmit = csrfReady && turnstileLoaded && (!TURNSTILE_SITE_KEY || turnstileReady.current || totpStep);

  return (
    <>
      {showSplash && <SplashScreen onComplete={handleSplashComplete} />}
      <div className={`flex min-h-screen items-center justify-center bg-gradient-to-br from-background via-muted to-background ${showSplash ? 'invisible' : ''}`}>
        <div className="w-full max-w-sm space-y-6 px-4">
          <div className="text-center space-y-2">
            <div className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-primary-foreground text-lg font-bold">
              cO
            </div>
            <h1 className="text-xl font-semibold tracking-tight">cortextOS</h1>
            <p className="text-sm text-muted-foreground">Persistent AI Agent Orchestration</p>
          </div>

          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="text-base">
                {totpStep ? 'Two-factor authentication' : 'Sign in'}
              </CardTitle>
              <CardDescription className="text-xs">
                {totpStep
                  ? 'Enter the 6-digit code from your authenticator app.'
                  : 'Enter your credentials to access the dashboard'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form
                onSubmit={handleSubmit}
                method="POST"
                action="/api/auth/callback/credentials"
                className="space-y-4"
                suppressHydrationWarning
              >
                <input type="hidden" name="csrfToken" defaultValue="" suppressHydrationWarning />

                {!totpStep ? (
                  <>
                    <div className="space-y-1.5">
                      <Label htmlFor="username" className="text-xs">Username</Label>
                      <Input
                        id="username"
                        name="username"
                        type="text"
                        required
                        autoFocus
                        placeholder="admin"
                        suppressHydrationWarning
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="password" className="text-xs">Password</Label>
                      <Input
                        id="password"
                        name="password"
                        type="password"
                        required
                        placeholder="Enter password"
                        suppressHydrationWarning
                      />
                    </div>
                    {TURNSTILE_SITE_KEY && (
                      <div ref={turnstileContainerRef} className="flex justify-center" />
                    )}
                  </>
                ) : (
                  <div className="space-y-1.5">
                    <Label htmlFor="totp-login" className="text-xs">Authenticator code</Label>
                    <Input
                      id="totp-login"
                      type="text"
                      inputMode="numeric"
                      maxLength={6}
                      autoFocus
                      autoComplete="one-time-code"
                      placeholder="000000"
                      value={totpCode}
                      onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
                      disabled={loading}
                    />
                    <button
                      type="button"
                      className="text-xs text-muted-foreground hover:underline"
                      onClick={() => { setTotpStep(false); setTotpCode(''); setError(''); }}
                    >
                      ← Back to sign in
                    </button>
                  </div>
                )}

                {error && <p className="text-xs text-destructive">{error}</p>}

                <Button
                  type="submit"
                  className="w-full"
                  disabled={loading || !csrfReady || (totpStep && totpCode.length < 6)}
                >
                  {loading
                    ? 'Signing in...'
                    : !csrfReady
                    ? 'Loading…'
                    : totpStep
                    ? 'Verify'
                    : 'Sign In'}
                </Button>

                {!totpStep && (
                  <div className="text-center">
                    <a href="/forgot-password" className="text-xs text-muted-foreground hover:underline">
                      Forgot password?
                    </a>
                  </div>
                )}
              </form>
            </CardContent>
          </Card>

          <p className="text-center text-[11px] text-muted-foreground/60">cortextOS v2</p>
        </div>
      </div>
    </>
  );
}
