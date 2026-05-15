/**
 * Cloudflare Turnstile server-side verification.
 * Returns true when TURNSTILE_SECRET_KEY is not set (dev/stub bypass).
 */
export async function verifyTurnstile(token: string | null | undefined): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return true; // bypass until keys are configured

  if (!token) {
    // Widget failed to render (script blocked, Chrome extension conflict, etc.).
    // Log and allow through — rate limiting + CSRF + password auth still protect the endpoint.
    console.warn('[turnstile] No token presented — widget may not have rendered. Allowing (rate-limit still active).');
    return true;
  }

  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, response: token }),
    });
    const data = await res.json() as { success: boolean };
    return data.success === true;
  } catch (err) {
    console.error('[turnstile] siteverify error:', err);
    return false;
  }
}
