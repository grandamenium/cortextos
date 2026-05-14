/**
 * Transactional email helpers via Resend REST API.
 * Returns { ok: false, reason } gracefully when RESEND_API_KEY is not set.
 */

const FROM = process.env.RESEND_FROM_EMAIL ?? 'noreply@clicktoacquire.com';

interface SendResult {
  ok: boolean;
  id?: string;
  reason?: string;
}

async function sendEmail(to: string, subject: string, html: string): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { ok: false, reason: 'Resend not configured' };
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM, to, subject, html }),
  });

  if (!res.ok) {
    const err = (await res.json().catch(() => ({ message: res.statusText }))) as {
      message?: string;
    };
    return { ok: false, reason: err.message ?? 'Resend API error' };
  }

  const data = (await res.json()) as { id: string };
  return { ok: true, id: data.id };
}

export async function clientWelcome({
  to,
  clientName,
  clientId,
}: {
  to: string;
  clientName: string;
  clientId: string;
}): Promise<SendResult> {
  const dashboardUrl = process.env.NEXTAUTH_URL ?? 'https://dashboard.clicktoacquire.com';
  const portalUrl = `${dashboardUrl}/portal/${clientId}`;
  return sendEmail(
    to,
    `Welcome to Click-to-Acquire — ${clientName}`,
    `
    <p>Hi ${clientName},</p>
    <p>Your account is live. You can access your client portal here:</p>
    <p><a href="${portalUrl}">${portalUrl}</a></p>
    <p>— The Click-to-Acquire team</p>
  `.trim(),
  );
}

export async function weeklyDigest({
  to,
  clientName,
  periodLabel,
  highlights,
}: {
  to: string;
  clientName: string;
  periodLabel: string;
  highlights: string[];
}): Promise<SendResult> {
  const items = highlights.map((h) => `<li>${h}</li>`).join('');
  return sendEmail(
    to,
    `${clientName} — Weekly Digest (${periodLabel})`,
    `
    <p>Hi ${clientName},</p>
    <p>Here's your weekly performance summary for <strong>${periodLabel}</strong>:</p>
    <ul>${items}</ul>
    <p>— Click-to-Acquire</p>
  `.trim(),
  );
}

export async function gateReadyForReview({
  to,
  clientName,
  gateName,
  reviewUrl,
}: {
  to: string;
  clientName: string;
  gateName: string;
  reviewUrl: string;
}): Promise<SendResult> {
  return sendEmail(
    to,
    `Action needed: ${gateName} ready for your review`,
    `
    <p>Hi ${clientName},</p>
    <p>A recommendation is ready for your review: <strong>${gateName}</strong>.</p>
    <p><a href="${reviewUrl}">Review now</a></p>
    <p>— Click-to-Acquire</p>
  `.trim(),
  );
}
