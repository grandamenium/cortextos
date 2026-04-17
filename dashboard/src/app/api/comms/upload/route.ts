import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getCTXRoot } from '@/lib/config';

export const dynamic = 'force-dynamic';

const MAX_SIZE = 10 * 1024 * 1024; // 10 MB

// Whitelist by MIME type AND by extension. SVG is intentionally excluded:
// SVGs can carry inline <script> and embedded event handlers, which turns
// any "view the image" link into an XSS vector when served from the same
// origin as the dashboard.
const ALLOWED_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

// Canonical extension per MIME type. The server IGNORES the user-supplied
// filename's extension and chooses the extension from the validated MIME
// type, so an attacker cannot upload `evil.html` with `image/png` content-type.
const EXT_FOR_TYPE: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

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
      { error: `Unsupported file type: ${file.type}. Allowed: JPEG, PNG, GIF, WebP` },
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

    // Sanitize filename. We keep only the basename of the client-supplied
    // name, strip any extension/path separators, and then append a
    // server-chosen extension derived from the validated MIME type.
    // This prevents attackers from smuggling `evil.html.png` or
    // `../../etc/passwd` through the upload endpoint.
    const rawName = file.name || 'upload';
    const rawBase = path.basename(rawName);
    const baseNoExt = rawBase.replace(/\.[^.]*$/, '');
    const baseName = baseNoExt
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 50) || 'upload';
    const ext = EXT_FOR_TYPE[file.type];
    if (!ext) {
      // Defense-in-depth: ALLOWED_TYPES already gated this, but if someone
      // widens the set without updating EXT_FOR_TYPE we refuse rather than
      // fall through to an empty extension.
      return Response.json({ error: 'Unsupported file type' }, { status: 400 });
    }
    const timestamp = Date.now();
    const filename = `${timestamp}-${baseName}${ext}`;
    const filePath = path.join(uploadDir, filename);

    // Defense-in-depth: ensure the resolved path is still inside uploadDir.
    // The sanitizer above should already guarantee this, but we verify.
    const resolvedUploadDir = path.resolve(uploadDir);
    const resolvedFilePath = path.resolve(filePath);
    if (!resolvedFilePath.startsWith(resolvedUploadDir + path.sep)) {
      return Response.json({ error: 'Invalid filename' }, { status: 400 });
    }

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
