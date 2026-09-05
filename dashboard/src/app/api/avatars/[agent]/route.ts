import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getCTXRoot, getAllAgents } from '@/lib/config';
import {
  AVATAR_CONTENT_TYPES,
  avatarDir,
  findAvatarFile,
  removeAvatar,
  sniffImageType,
} from '@/lib/crew-avatars';

export const dynamic = 'force-dynamic';

// 5MB is generous for a chat avatar; ChatGPT image exports are ~1-3MB PNGs.
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

function validateAgent(agent: string): string | null {
  if (!agent || !/^[a-z0-9_-]+$/.test(agent)) return 'Invalid agent name';
  // Registry check mirrors /api/messages/send — no file writes for names
  // that merely look valid.
  if (!getAllAgents().some((a) => a.name === agent)) return 'Agent not found';
  return null;
}

/**
 * GET /api/avatars/[agent] — serve the agent's uploaded character art.
 * 404 when none exists (the UI falls back to its generated critter).
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ agent: string }> },
) {
  const { agent } = await params;
  const err = validateAgent(agent);
  if (err) return Response.json({ error: err }, { status: err === 'Agent not found' ? 404 : 400 });

  const file = findAvatarFile(getCTXRoot(), agent);
  if (!file) return Response.json({ error: 'No avatar' }, { status: 404 });

  try {
    const buf = fs.readFileSync(file);
    const ext = path.extname(file).slice(1).toLowerCase();
    return new Response(new Uint8Array(buf), {
      headers: {
        'Content-Type': AVATAR_CONTENT_TYPES[ext] ?? 'application/octet-stream',
        // Clients cache-bust with ?v=<mtime from /api/crew>, so a long
        // max-age is safe and keeps roster renders cheap.
        'Cache-Control': 'private, max-age=86400, immutable',
      },
    });
  } catch {
    return Response.json({ error: 'No avatar' }, { status: 404 });
  }
}

/**
 * POST /api/avatars/[agent] — upload character art (multipart, field "file").
 * The image type is sniffed from magic bytes; the client filename and MIME
 * are ignored. Replaces any existing art for the agent.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ agent: string }> },
) {
  const { agent } = await params;
  const err = validateAgent(agent);
  if (err) return Response.json({ error: err }, { status: err === 'Agent not found' ? 404 : 400 });

  let file: File | null = null;
  try {
    const form = await request.formData();
    const entry = form.get('file');
    if (entry instanceof File) file = entry;
  } catch {
    return Response.json({ error: 'Expected multipart form data' }, { status: 400 });
  }
  if (!file) return Response.json({ error: 'file field is required' }, { status: 400 });
  if (file.size > MAX_AVATAR_BYTES) {
    return Response.json({ error: 'Image too large (max 5MB)' }, { status: 413 });
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const ext = sniffImageType(buf);
  if (!ext) {
    return Response.json(
      { error: 'Unsupported image format (use PNG, JPEG, WebP, or GIF)' },
      { status: 415 },
    );
  }

  const ctxRoot = getCTXRoot();
  const dir = avatarDir(ctxRoot);
  const finalPath = path.join(dir, `${agent}.${ext}`);
  const tmpPath = path.join(dir, `.tmp.${agent}.${ext}`);

  try {
    fs.mkdirSync(dir, { recursive: true });
    // Clear other extension variants first so findAvatarFile is unambiguous.
    removeAvatar(ctxRoot, agent);
    fs.writeFileSync(tmpPath, buf);
    fs.renameSync(tmpPath, finalPath);
    const version = Math.round(fs.statSync(finalPath).mtimeMs);
    return Response.json({ success: true, version });
  } catch (e) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    const message = e instanceof Error ? e.message : String(e);
    console.error('[api/avatars] upload failed:', message);
    return Response.json({ error: 'Failed to save avatar' }, { status: 500 });
  }
}

/**
 * DELETE /api/avatars/[agent] — remove uploaded art, reverting the UI to
 * the generated critter.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ agent: string }> },
) {
  const { agent } = await params;
  const err = validateAgent(agent);
  if (err) return Response.json({ error: err }, { status: err === 'Agent not found' ? 404 : 400 });

  removeAvatar(getCTXRoot(), agent);
  return Response.json({ success: true });
}
