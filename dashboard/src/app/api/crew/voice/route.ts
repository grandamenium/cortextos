import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getCTXRoot, getAllAgents } from '@/lib/config';
import { transcribeAudio } from '@/lib/transcribe';

export const dynamic = 'force-dynamic';

// Voice notes are short; 15MB covers several minutes in any codec.
const MAX_VOICE_BYTES = 15 * 1024 * 1024;

/**
 * Sniff the audio container from magic bytes — MediaRecorder blobs carry
 * no trustworthy filename. Chrome records webm/opus, iOS Safari mp4/m4a.
 */
function sniffAudioExt(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'webm';
  if (buf.subarray(4, 8).toString('ascii') === 'ftyp') return 'm4a';
  if (buf.subarray(0, 4).toString('ascii') === 'OggS') return 'ogg';
  if (
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WAVE'
  ) {
    return 'wav';
  }
  return null;
}

/**
 * POST /api/crew/voice — voice message to an agent.
 *
 * Multipart fields: agent, file (audio blob). The audio is saved to
 * <ctxRoot>/media/<agent>/, transcribed locally with whisper.cpp, and the
 * TRANSCRIPT is delivered as an ordinary bus inbox message (marked
 * media_type: 'voice' so the chat renders a mic icon). Agents need zero
 * new machinery — a voice note reads exactly like a typed message.
 *
 * When transcription is unavailable the audio path is delivered instead,
 * mirroring /api/messages/upload, and `transcript` is null in the response
 * so the UI can say so.
 */
export async function POST(request: NextRequest) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: 'Expected multipart form data' }, { status: 400 });
  }

  const agent = form.get('agent');
  const file = form.get('file');

  if (typeof agent !== 'string' || !/^[a-z0-9_-]+$/.test(agent)) {
    return Response.json({ error: 'Invalid agent name' }, { status: 400 });
  }
  if (!getAllAgents().some((a) => a.name === agent)) {
    return Response.json({ error: 'Agent not found' }, { status: 404 });
  }
  if (!(file instanceof File)) {
    return Response.json({ error: 'file field is required' }, { status: 400 });
  }
  if (file.size > MAX_VOICE_BYTES) {
    return Response.json({ error: 'Recording too large (max 15MB)' }, { status: 413 });
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const ext = sniffAudioExt(buf);
  if (!ext) {
    return Response.json({ error: 'Unrecognized audio format' }, { status: 415 });
  }

  const ctxRoot = getCTXRoot();
  const mediaDir = path.join(ctxRoot, 'media', agent);
  const audioName = `voice_${Date.now()}.${ext}`;
  const audioPath = path.join(mediaDir, audioName);

  try {
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.writeFileSync(audioPath, buf);
  } catch (e) {
    console.error('[api/crew/voice] save failed:', e instanceof Error ? e.message : String(e));
    return Response.json({ error: 'Failed to save recording' }, { status: 500 });
  }

  const transcript = await transcribeAudio(audioPath);
  const text = transcript ?? `[voice message: ${audioPath}] (transcription unavailable — audio saved at that path)`;

  // Deliver as a normal chat-bar message (same schema/flow as
  // /api/messages/send) so it lands in the admin--agent channel.
  const epochMs = Date.now();
  const rand = Math.random().toString(36).slice(2, 7);
  const from = (process.env.ADMIN_USERNAME ?? 'user').toLowerCase();
  const messageId = `${epochMs}-${from}-${rand}`;
  const filename = `2-${epochMs}-from-${from}-${rand}.json`;

  const inboxDir = path.join(ctxRoot, 'inbox', agent);
  const tmpPath = path.join(inboxDir, `.tmp.${filename}`);
  const finalPath = path.join(inboxDir, filename);

  try {
    fs.mkdirSync(inboxDir, { recursive: true });
    const message = {
      id: messageId,
      from,
      to: agent,
      priority: 'normal',
      timestamp: new Date().toISOString(),
      text,
      reply_to: null,
      media_type: 'voice',
      local_file: audioPath,
    };
    fs.writeFileSync(tmpPath, JSON.stringify(message) + '\n');
    fs.renameSync(tmpPath, finalPath);

    // Instant pickup, same as the text path.
    const pidFile = path.join(ctxRoot, 'state', agent, '.fast-checker.pid');
    if (fs.existsSync(pidFile)) {
      try {
        const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
        if (pid > 0) process.kill(pid, 'SIGUSR1');
      } catch {
        /* fast-checker may not be running */
      }
    }

    const logDir = path.join(ctxRoot, 'logs', agent);
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(
      path.join(logDir, 'inbound-messages.jsonl'),
      JSON.stringify({
        id: messageId,
        timestamp: new Date().toISOString(),
        agent,
        direction: 'inbound',
        type: 'voice',
        text,
        local_file: audioPath,
        from_name: from,
        source: 'dashboard',
      }) + '\n',
    );

    return Response.json({
      success: true,
      messageId,
      transcript,
      mediaUrl: `/api/media/${path.relative(ctxRoot, audioPath)}`,
    });
  } catch (e) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    console.error('[api/crew/voice] deliver failed:', e instanceof Error ? e.message : String(e));
    return Response.json({ error: 'Failed to deliver voice message' }, { status: 500 });
  }
}
