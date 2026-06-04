import { NextRequest } from 'next/server';
import fs from 'fs/promises';
import { createHash } from 'crypto';
import { getAgentDetail, getAgentPaths } from '@/lib/data/agents';
import {
  parseIdentityMd,
  serializeIdentityMd,
  parseSoulMd,
  serializeSoulMd,
} from '@/lib/markdown-parser';
import type { IdentityFields, SoulFields } from '@/lib/types';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// GET /api/agents/[name] - Get full agent detail
// ---------------------------------------------------------------------------

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const decoded = decodeURIComponent(name);

  try {
    const detail = await getAgentDetail(decoded);
    return Response.json(detail);
  } catch (err) {
    console.error(`[api/agents/${decoded}] GET error:`, err);
    return Response.json({ error: 'Agent not found' }, { status: 404 });
  }
}

// ---------------------------------------------------------------------------
// PATCH /api/agents/[name] - Update identity and/or soul markdown
// ---------------------------------------------------------------------------

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const decoded = decodeURIComponent(name);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const org = (body.org as string) || undefined;
  const paths = getAgentPaths(decoded, org);

  const results: { identity?: boolean; soul?: boolean; memory?: boolean } = {};
  let newMemoryHash: string | undefined;

  // Optimistic concurrency pre-flight (#515): a MEMORY.md update must carry the
  // hash of the version the client loaded, and we reject BEFORE writing any
  // field so a conflict can't partially persist identity or soul.
  //
  // This is an optimistic check, not a lock: a small TOCTOU window remains
  // between this read and the write below. It closes the reported
  // single-operator silent-overwrite; true concurrent-writer safety would need
  // a per-agent lock, which is out of scope for this fix.
  if (typeof body.memoryRaw === 'string') {
    if (typeof body.memoryHash !== 'string') {
      return Response.json(
        { error: 'memoryHash is required when updating MEMORY.md (optimistic concurrency, #515).' },
        { status: 400 },
      );
    }
    let current = '';
    try {
      current = await fs.readFile(paths.memoryMd, 'utf-8');
    } catch (err) {
      // Only a genuinely missing file means "empty baseline". A permission/IO
      // error must NOT be silently treated as empty — that would let the save
      // proceed on a false assumption (codex review).
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[api/agents/${decoded}] PATCH memory read error:`, err);
        return Response.json({ error: 'Failed to read MEMORY.md' }, { status: 500 });
      }
    }
    const currentHash = createHash('sha256').update(current, 'utf-8').digest('hex');
    if (currentHash !== body.memoryHash) {
      return Response.json(
        {
          error:
            'MEMORY.md changed on disk since it was loaded. Reload to see the latest, then re-apply your edits.',
          currentHash,
        },
        { status: 409 },
      );
    }
  }

  // Update IDENTITY.md
  if (body.identity) {
    const identityFields = body.identity as IdentityFields;
    try {
      let rawIdentity = '';
      try {
        rawIdentity = await fs.readFile(paths.identityMd, 'utf-8');
      } catch {
        // File doesn't exist yet, start fresh
      }

      const { parsed } = parseIdentityMd(rawIdentity);
      const newContent = serializeIdentityMd(identityFields, parsed);
      await fs.writeFile(paths.identityMd, newContent, 'utf-8');
      results.identity = true;
    } catch (err) {
      console.error(`[api/agents/${decoded}] PATCH identity error:`, err);
      return Response.json(
        { error: 'Failed to update identity', detail: String(err), path: paths.identityMd },
        { status: 500 },
      );
    }
  }

  // Update SOUL.md
  if (body.soul) {
    const soulFields = body.soul as SoulFields;
    try {
      let rawSoul = '';
      try {
        rawSoul = await fs.readFile(paths.soulMd, 'utf-8');
      } catch {
        // File doesn't exist yet
      }

      const { parsed } = parseSoulMd(rawSoul);
      const newContent = serializeSoulMd(soulFields, parsed);
      await fs.writeFile(paths.soulMd, newContent, 'utf-8');
      results.soul = true;
    } catch (err) {
      console.error(`[api/agents/${decoded}] PATCH soul error:`, err);
      return Response.json(
        { error: 'Failed to update soul' },
        { status: 500 },
      );
    }
  }

  // Update MEMORY.md (stale-write conflict already rejected in the pre-flight above)
  if (typeof body.memoryRaw === 'string') {
    try {
      await fs.writeFile(paths.memoryMd, body.memoryRaw as string, 'utf-8');
      // Return the post-write hash so the client can update its in-memory
      // baseline and the next save in the same tab doesn't false-409 (#515).
      newMemoryHash = createHash('sha256')
        .update(body.memoryRaw as string, 'utf-8')
        .digest('hex');
      results.memory = true;
    } catch (err) {
      console.error(`[api/agents/${decoded}] PATCH memory error:`, err);
      return Response.json(
        { error: 'Failed to update memory' },
        { status: 500 },
      );
    }
  }

  return Response.json({
    success: true,
    updated: results,
    ...(newMemoryHash ? { memoryHash: newMemoryHash } : {}),
  });
}
