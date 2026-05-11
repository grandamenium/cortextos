import fs from 'fs';
import path from 'path';
import { getFrameworkRoot } from '@/lib/config';
import { git, jsonError, validateBranch, UPSTREAM_REF } from '../_util';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const branch = validateBranch(url.searchParams.get('branch'));
  if (!branch) return jsonError('Invalid or missing branch', 400);

  try {
    const aheadCount = parseInt(
      git(['rev-list', '--count', `${UPSTREAM_REF}..${branch}`]).trim(),
      10,
    );
    const behindCount = parseInt(
      git(['rev-list', '--count', `${branch}..${UPSTREAM_REF}`]).trim(),
      10,
    );

    let lastFetchedAt: string | null = null;
    const fetchHead = path.join(getFrameworkRoot(), '.git', 'FETCH_HEAD');
    if (fs.existsSync(fetchHead)) {
      lastFetchedAt = fs.statSync(fetchHead).mtime.toISOString();
    }

    let upstreamRemoteUrl: string | null = null;
    try {
      upstreamRemoteUrl = git(['remote', 'get-url', 'upstream']).trim();
    } catch {
      upstreamRemoteUrl = null;
    }

    return Response.json({
      branch,
      upstream: UPSTREAM_REF,
      upstreamRemoteUrl,
      ahead: Number.isFinite(aheadCount) ? aheadCount : 0,
      behind: Number.isFinite(behindCount) ? behindCount : 0,
      lastFetchedAt,
    });
  } catch (err) {
    console.error('[api/git/status] error', err);
    return jsonError('Failed to read status (is upstream/main fetched?)', 500);
  }
}
