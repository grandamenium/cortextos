import { git, jsonError, validateBranch, UPSTREAM_REF } from '../_util';

export const dynamic = 'force-dynamic';

const SEP = '\x1f';
const REC = '\x1e';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const branch = validateBranch(url.searchParams.get('branch'));
  if (!branch) return jsonError('Invalid or missing branch', 400);

  try {
    // \x1e prefix on each record so split() yields one chunk per commit.
    // If we appended \x1e instead, each chunk would contain the *previous*
    // commit's shortstat + the *current* commit's header — misaligned.
    const format = ['%H', '%h', '%s', '%an', '%ae', '%aI'].join(SEP);
    const raw = git([
      'log',
      `--pretty=format:${REC}${format}`,
      '--shortstat',
      `${UPSTREAM_REF}..${branch}`,
    ]);

    const commits = raw
      .split(REC)
      .map((chunk) => chunk.trim())
      .filter(Boolean)
      .map((chunk) => {
        const nl = chunk.indexOf('\n');
        const header = nl === -1 ? chunk : chunk.slice(0, nl);
        const stat = nl === -1 ? '' : chunk.slice(nl + 1).trim();
        const [sha, shortSha, subject, author, authorEmail, date] = header.split(SEP);

        let filesChanged = 0;
        let insertions = 0;
        let deletions = 0;
        const filesMatch = stat.match(/(\d+) files? changed/);
        const insMatch = stat.match(/(\d+) insertions?\(\+\)/);
        const delMatch = stat.match(/(\d+) deletions?\(-\)/);
        if (filesMatch) filesChanged = parseInt(filesMatch[1], 10);
        if (insMatch) insertions = parseInt(insMatch[1], 10);
        if (delMatch) deletions = parseInt(delMatch[1], 10);

        return {
          sha,
          shortSha,
          subject,
          author,
          authorEmail,
          date,
          filesChanged,
          insertions,
          deletions,
        };
      });

    return Response.json(commits);
  } catch (err) {
    console.error('[api/git/commits] error', err);
    return jsonError('Failed to list commits', 500);
  }
}
