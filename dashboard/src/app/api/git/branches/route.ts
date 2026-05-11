import { git, jsonError } from '../_util';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const branchesOut = git(['branch', '--format=%(refname:short)']);
    const branches = branchesOut
      .split('\n')
      .map((b) => b.trim())
      .filter(Boolean);
    const current = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    return Response.json({ branches, current });
  } catch (err) {
    console.error('[api/git/branches] error', err);
    return jsonError('Failed to list branches', 500);
  }
}
