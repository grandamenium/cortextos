import { existsSync, readdirSync } from 'fs';
import { join } from 'path';

export interface SourceAgentCandidate {
  name: string;
  dir: string;
  org: string;
}

/**
 * Discover the source-side agent directories the daemon considers at boot.
 * Shared and hidden directories are infrastructure, not runnable agents.
 */
export function discoverSourceAgentCandidates(frameworkRoot: string): SourceAgentCandidate[] {
  const candidates: SourceAgentCandidate[] = [];
  const orgsBase = join(frameworkRoot, 'orgs');
  if (!existsSync(orgsBase)) return candidates;

  let orgNames: string[];
  try {
    orgNames = readdirSync(orgsBase, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
  } catch {
    return candidates;
  }

  for (const org of orgNames) {
    const agentsBase = join(orgsBase, org, 'agents');
    if (!existsSync(agentsBase)) continue;
    try {
      for (const entry of readdirSync(agentsBase, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
        candidates.push({ name: entry.name, dir: join(agentsBase, entry.name), org });
      }
    } catch {
      // One unreadable organization must not hide agents in the others.
    }
  }

  return candidates;
}
