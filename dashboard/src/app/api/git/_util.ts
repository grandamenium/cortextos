import { execFileSync } from 'child_process';
import { getFrameworkRoot } from '@/lib/config';

export const BRANCH_RE = /^[a-zA-Z0-9_./-]+$/;
export const SHA_RE = /^[a-f0-9]{7,40}$/;
export const UPSTREAM_REF = 'upstream/main';

export function git(args: string[], opts: { maxBuffer?: number } = {}): string {
  return execFileSync('git', args, {
    cwd: getFrameworkRoot(),
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
  });
}

export function validateBranch(branch: string | null | undefined): string | null {
  if (!branch) return null;
  if (!BRANCH_RE.test(branch)) return null;
  return branch;
}

export function validateSha(sha: string | null | undefined): string | null {
  if (!sha) return null;
  if (!SHA_RE.test(sha)) return null;
  return sha;
}

export function jsonError(message: string, status: number) {
  return Response.json({ error: message }, { status });
}
