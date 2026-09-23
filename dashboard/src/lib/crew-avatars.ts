// Crew avatar storage helpers — shared by /api/crew and /api/avatars/[agent].
//
// Custom character art lives OUTSIDE the repo at <ctxRoot>/avatars/<agent>.<ext>
// so uploads survive dashboard rebuilds and never touch the git tree. One file
// per agent; uploading a new image replaces any previous extension variant.

import fs from 'fs';
import path from 'path';

export const AVATAR_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif'] as const;

export const AVATAR_CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

export function avatarDir(ctxRoot: string): string {
  return path.join(ctxRoot, 'avatars');
}

/** Absolute path of the agent's avatar image, or null if none uploaded. */
export function findAvatarFile(ctxRoot: string, agent: string): string | null {
  const dir = avatarDir(ctxRoot);
  for (const ext of AVATAR_EXTENSIONS) {
    const p = path.join(dir, `${agent}.${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Sniff the real image type from magic bytes. Returns the canonical
 * extension or null when the buffer is not one of the allowed formats.
 * The client-supplied filename/MIME is never trusted.
 */
export function sniffImageType(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 4).toString('ascii') === 'GIF8') return 'gif';
  if (
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

/** Delete every extension variant of the agent's avatar. */
export function removeAvatar(ctxRoot: string, agent: string): void {
  const dir = avatarDir(ctxRoot);
  for (const ext of AVATAR_EXTENSIONS) {
    try {
      fs.unlinkSync(path.join(dir, `${agent}.${ext}`));
    } catch {
      /* variant absent */
    }
  }
}
