import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GHL_API_KEY = process.env.GHL_API_KEY || '';
const BOT_TOKEN = process.env.TIMBER_BOT_TOKEN || '';
const GROUP_CHAT_ID = process.env.TIMBER_GROUP_CHAT_ID || '';
const LOG_PATH = path.join(process.env.CTX_ROOT || 'C:/Users/jenni/.cortextos/default', 'logs/timber/ghl-call-recordings.jsonl');

async function transcribeAudioUrl(recordingUrl: string): Promise<string> {
  try {
    const audioRes = await fetch(recordingUrl, {
      headers: { 'Authorization': `Bearer ${GHL_API_KEY}` }
    });
    if (!audioRes.ok) {
      // Try without auth (Twilio URLs are pre-signed)
      const audioRes2 = await fetch(recordingUrl);
      if (!audioRes2.ok) throw new Error(`download failed: ${audioRes2.status}`);
      const buf = await audioRes2.arrayBuffer();
      return await callGemini(buf, recordingUrl);
    }
    const buf = await audioRes.arrayBuffer();
    return await callGemini(buf, recordingUrl);
  } catch (e) {
    return `[transcription error: ${String(e)}]`;
  }
}

async function callGemini(buf: ArrayBuffer, url: string): Promise<string> {
  const base64 = Buffer.from(buf).toString('base64');
  const mimeType = url.includes('.mp3') ? 'audio/mp3' : url.includes('.wav') ? 'audio/wav' : 'audio/mpeg';
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: 'This is a voicemail left for a property management company. Transcribe it word for word. If inaudible, write [inaudible]. Be concise.' },
            { inlineData: { mimeType, data: base64 } }
          ]
        }]
      })
    }
  );
  const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '[no transcription returned]';
}

async function notifyTimber(text: string): Promise<void> {
  if (!BOT_TOKEN || !GROUP_CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: GROUP_CHAT_ID, text, parse_mode: 'Markdown' })
  });
}

function extractRecordingUrl(body: Record<string, unknown>): string | null {
  if (typeof body.recordingUrl === 'string') return body.recordingUrl;
  if (Array.isArray(body.attachments) && body.attachments.length > 0) return body.attachments[0] as string;
  const meta = body.meta as Record<string, unknown> | undefined;
  if (meta?.call) {
    const call = meta.call as Record<string, unknown>;
    if (typeof call.recording === 'string') return call.recording;
    if (typeof call.recordingUrl === 'string') return call.recordingUrl;
  }
  return null;
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const recordingUrl = extractRecordingUrl(body);
  const caller = (body.contactName as string) || (body.phone as string) || (body.from as string) || 'Unknown';
  const conversationId = (body.conversationId as string) || '';
  const contactId = (body.contactId as string) || '';
  const eventType = (body.type as string) || 'CallEvent';

  // Log raw webhook
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), ...body }) + '\n');
  } catch { /* best effort */ }

  // Transcribe if recording URL present
  let transcription = '[no recording URL in webhook payload]';
  if (recordingUrl) {
    transcription = await transcribeAudioUrl(recordingUrl);
  }

  // Notify timber via Telegram group chat (fast-checker picks this up within 60s)
  const msg = `=== GHL CALL WEBHOOK ===\nEvent: ${eventType}\nCaller: ${caller}\nConversationId: ${conversationId}\nContactId: ${contactId}\nRecording URL: ${recordingUrl || 'none'}\nTranscription: ${transcription}`;
  await notifyTimber(msg);

  return NextResponse.json({ success: true, transcription });
}
