import { git, jsonError, validateSha } from '../../_util';

export const dynamic = 'force-dynamic';

const SEP = '\x1f';

interface DiffFile {
  path: string;
  oldPath: string | null;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'other';
  additions: number;
  deletions: number;
  binary: boolean;
  patch: string;
}

function parseStatus(code: string): DiffFile['status'] {
  if (code.startsWith('A')) return 'added';
  if (code.startsWith('D')) return 'deleted';
  if (code.startsWith('M')) return 'modified';
  if (code.startsWith('R')) return 'renamed';
  if (code.startsWith('C')) return 'copied';
  return 'other';
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ sha: string }> },
) {
  const { sha: rawSha } = await ctx.params;
  const sha = validateSha(rawSha);
  if (!sha) return jsonError('Invalid SHA', 400);

  try {
    const headerFormat = ['%H', '%s', '%b', '%an', '%ae', '%aI'].join(SEP);
    const header = git(['show', '-s', `--pretty=format:${headerFormat}`, sha]);
    const [fullSha, subject, body, author, authorEmail, date] = header.split(SEP);

    // numstat: additions \t deletions \t path (or - - for binary)
    const numstatRaw = git(['show', '--numstat', '--format=', sha]);
    const numstat = new Map<string, { additions: number; deletions: number; binary: boolean }>();
    for (const line of numstatRaw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split('\t');
      if (parts.length < 3) continue;
      const [a, d, p] = parts;
      const binary = a === '-' && d === '-';
      numstat.set(p, {
        additions: binary ? 0 : parseInt(a, 10) || 0,
        deletions: binary ? 0 : parseInt(d, 10) || 0,
        binary,
      });
    }

    // name-status: code \t path [\t newpath for renames]
    const nameStatusRaw = git(['show', '--name-status', '--format=', sha]);
    const fileMetas: Array<{ path: string; oldPath: string | null; status: DiffFile['status'] }> =
      [];
    for (const line of nameStatusRaw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split('\t');
      const code = parts[0];
      const status = parseStatus(code);
      if (status === 'renamed' || status === 'copied') {
        fileMetas.push({ path: parts[2], oldPath: parts[1], status });
      } else {
        fileMetas.push({ path: parts[1], oldPath: null, status });
      }
    }

    // unified diff per file: emit one git show per file, scoped via -- <path>
    // to keep the response shape predictable. Caps each patch to 200KB.
    const PATCH_CAP = 200 * 1024;
    const files: DiffFile[] = [];
    for (const meta of fileMetas) {
      const stats = numstat.get(meta.path) ?? { additions: 0, deletions: 0, binary: false };
      let patch = '';
      if (!stats.binary) {
        try {
          const raw = git(
            ['show', '--format=', '--patch', sha, '--', meta.path],
            { maxBuffer: 32 * 1024 * 1024 },
          );
          patch = raw.length > PATCH_CAP ? raw.slice(0, PATCH_CAP) + '\n...(truncated)\n' : raw;
        } catch {
          patch = '';
        }
      }
      files.push({
        path: meta.path,
        oldPath: meta.oldPath,
        status: meta.status,
        additions: stats.additions,
        deletions: stats.deletions,
        binary: stats.binary,
        patch,
      });
    }

    return Response.json({
      sha: fullSha,
      subject,
      body: (body ?? '').trim(),
      author,
      authorEmail,
      date,
      files,
    });
  } catch (err) {
    console.error('[api/git/commits/[sha]] error', err);
    return jsonError('Failed to read commit', 500);
  }
}
