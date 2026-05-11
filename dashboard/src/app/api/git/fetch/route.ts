import { git, jsonError } from '../_util';

export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    git(['fetch', 'upstream', '--prune']);
    return Response.json({ ok: true, fetchedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[api/git/fetch] error', err);
    return jsonError('git fetch upstream failed', 500);
  }
}
