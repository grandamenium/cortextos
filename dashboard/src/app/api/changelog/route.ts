import { execSync } from 'child_process';
import { getFrameworkRoot } from '@/lib/config';

export const dynamic = 'force-dynamic';

interface CommitEntry {
  sha: string;
  message: string;
  type: 'fix' | 'feat' | 'chore' | 'docs' | 'other';
}

function classifyCommit(message: string): CommitEntry['type'] {
  const m = message.match(/^(\w+)(?:\(.*?\))?[!:]/);
  if (!m) return 'other';
  const prefix = m[1].toLowerCase();
  if (prefix === 'fix') return 'fix';
  if (prefix === 'feat') return 'feat';
  if (prefix === 'docs') return 'docs';
  if (['chore', 'test', 'ci', 'build', 'refactor'].includes(prefix)) return 'chore';
  return 'other';
}

function parseCommits(output: string): CommitEntry[] {
  return output
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const spaceIdx = line.indexOf(' ');
      const sha = spaceIdx > 0 ? line.slice(0, spaceIdx) : line;
      const message = spaceIdx > 0 ? line.slice(spaceIdx + 1) : '';
      return { sha, message, type: classifyCommit(message) };
    });
}

// All git commands below are hardcoded strings with no user input,
// so execSync with shell is safe from injection.
export async function GET() {
  const frameworkRoot = getFrameworkRoot();
  const execOpts = { cwd: frameworkRoot, encoding: 'utf-8' as const, timeout: 15000 };

  try {
    // Silent fetch — don't fail if offline
    try {
      execSync('git fetch upstream main 2>/dev/null', execOpts);
    } catch {
      // Offline or no upstream remote — continue with stale data
    }

    let pending: CommitEntry[] = [];
    try {
      const pendingRaw = execSync('git log --oneline HEAD..upstream/main', execOpts).trim();
      pending = parseCommits(pendingRaw);
    } catch {
      // upstream/main may not exist
    }

    let applied: CommitEntry[] = [];
    try {
      const appliedRaw = execSync(
        'git log --oneline --since="30 days ago" upstream/main',
        execOpts,
      ).trim();
      applied = parseCommits(appliedRaw);
    } catch {
      // upstream/main may not exist
    }

    let currentSha = '';
    try {
      currentSha = execSync('git rev-parse --short HEAD', execOpts).trim();
    } catch {
      // ignore
    }

    return Response.json({
      pending,
      pendingCount: pending.length,
      applied,
      lastChecked: new Date().toISOString(),
      currentSha,
    });
  } catch (err) {
    return Response.json({
      error: String(err),
      pending: [],
      pendingCount: 0,
      applied: [],
      lastChecked: new Date().toISOString(),
      currentSha: '',
    });
  }
}
