import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getCTXRoot } from '@/lib/config';

export const dynamic = 'force-dynamic';

const MAX_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
]);

/**
 * POST /api/comms/upload — Upload an image for the chat interface.
 *
 * Accepts multipart/form-data with a single "file" field.
 * Saves to {CTX_ROOT}/media/dashboard-uploads/{timestamp}-{sanitized-name}
 * Returns { path: "media/dashboard-uploads/...", url: "/api/media/media/dashboard-uploads/..." }
 *
 * Used by the chat bar image attach button AND the clipboard paste handler —
 * both feed into the same endpoint so the media layout is consistent.
 */
export async function POST(request: NextRequest) {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return Response.json({ error: 'Invalid form data' }, { status: 400 });
  }

  const file = formData.get('file');
  if (!file || !(file instanceof File)) {
    return Response.json({ error: 'No file provided' }, { status: 400 });
  }

  if (!ALLOWED_TYPES.has(file.type)) {
    return Response.json(
      { error: `Unsupported file type: ${file.type}. Allowed: JPEG, PNG, GIF, WebP, SVG` },
      { status: 400 },
    );
  }

  if (file.size > MAX_SIZE) {
    return Response.json({ error: 'File too large (max 10 MB)' }, { status: 400 });
  }

  const ctxRoot = getCTXRoot();
  const uploadDir = path.join(ctxRoot, 'media', 'dashboard-uploads');

  try {
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    // Sanitize filename: keep extension, replace unsafe chars. Clipboard paste
    // delivers an anonymous File with name "image.png" most of the time, so
    // the timestamp prefix is what makes entries unique.
    const ext = path.extname(file.name || 'upload.png').toLowerCase();
    const baseName = path
      .basename(file.name || 'upload', ext)
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 50);
    const timestamp = Date.now();
    const filename = `${timestamp}-${baseName}${ext}`;
    const filePath = path.join(uploadDir, filename);

    const buffer = Buffer.from(await file.arrayBuffer());
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, buffer);
    fs.renameSync(tmpPath, filePath);

    const relativePath = `media/dashboard-uploads/${filename}`;
    const mediaUrl = `/api/media/${relativePath}`;

    return Response.json({
      success: true,
      path: relativePath,
      url: mediaUrl,
      filename,
      size: file.size,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[api/comms/upload] Error:', message);
    return Response.json({ error: 'Upload failed' }, { status: 500 });
  }
}
