import { NextRequest } from 'next/server';
import https from 'https';
import path from 'path';
import os from 'os';

export const dynamic = 'force-dynamic';

const GEMINI_MODEL = 'gemini-2.0-flash';

function geminiRequest(prompt: string, apiKey: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 512 },
    });
    const req = https.request(
      {
        hostname: 'generativelanguage.googleapis.com',
        path: `/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) resolve(text.trim());
            else reject(new Error('No text in Gemini response: ' + data.slice(0, 200)));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Load email rules for context
function loadRules(): Array<{ trigger: { type: string; value: string }; action: string }> {
  try {
    const { readFileSync } = require('fs') as typeof import('fs');
    const ctxRoot = process.env.CTX_ROOT ?? path.join(os.homedir(), '.cortextos', 'default');
    const p = path.join(ctxRoot, 'state', 'data', 'email-rules.json');
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return [];
  }
}

export async function POST(request: NextRequest) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return Response.json({ error: 'AI drafting not configured (GEMINI_API_KEY missing)' }, { status: 503 });
  }

  let body: Record<string, unknown>;
  try { body = await request.json(); } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { from, subject, snippet, account, instruction } = body as {
    from?: string;
    subject?: string;
    snippet?: string;
    account?: string;
    instruction?: string;
  };

  if (!from || !subject) {
    return Response.json({ error: 'from and subject are required' }, { status: 400 });
  }

  // Find any matching rules for context
  const rules = loadRules();
  const senderEmail = (from.match(/<([^>]+)>/) || [])[1] || from;
  const matchingRules = rules.filter(
    (r) =>
      (r.trigger.type === 'sender' && from.toLowerCase().includes(r.trigger.value.toLowerCase())) ||
      (r.trigger.type === 'subject' && subject.toLowerCase().includes(r.trigger.value.toLowerCase()))
  );
  const rulesContext = matchingRules.length
    ? `\nApplicable rules for this sender:\n${matchingRules.map((r) => `- ${r.action}`).join('\n')}`
    : '';

  const prompt = `You are drafting an email reply on behalf of Jennifer Breitbach, CEO of Total Investment Solutions / Atlas OS.
Jennifer's communication style: professional but warm, direct, action-oriented, brief.

Email details:
- Account: ${account || 'Business'}
- From: ${from}
- Subject: ${subject}
- Email preview: ${snippet || '(no preview available)'}
${rulesContext}
${instruction ? `\nJennifer's instruction: ${instruction}` : ''}

Write a draft reply that Jennifer can review and send. Be concise (2-4 sentences unless the email clearly requires more). Do not include a subject line. Start with a greeting. End with Jennifer's name. Output only the email body text, nothing else.`;

  try {
    const draft = await geminiRequest(prompt, apiKey);
    return Response.json({ draft });
  } catch (err) {
    console.error('[draft-reply] Gemini error:', err);
    return Response.json({ error: 'Failed to generate draft' }, { status: 500 });
  }
}
