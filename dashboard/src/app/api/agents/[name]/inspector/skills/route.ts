import fs from 'fs/promises';
import path from 'path';
import { NextRequest } from 'next/server';
import { getAgentRuntime, getCommunitySkillsDir, getHermesHome } from '@/lib/agent-runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Origin = 'hermes-local' | 'cortextos-agent' | 'community';

type Skill = {
  name: string;
  description: string;
  category: string;
  sourcePath: string;
  origin: Origin;
  content: string;
};

function frontmatter(raw: string): Record<string, string> {
  if (!raw.startsWith('---')) return {};
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return {};
  const fm = raw.slice(3, end);
  const out: Record<string, string> = {};
  for (const line of fm.split('\n')) {
    const match = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (match) out[match[1]] = match[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

async function walk(dir: string, origin: Origin): Promise<Skill[]> {
  const found: Skill[] = [];
  async function visit(current: string, category: string): Promise<void> {
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(full, category || entry.name);
      } else if (entry.name === 'SKILL.md') {
        const content = await fs.readFile(full, 'utf-8').catch(() => '');
        const fm = frontmatter(content);
        found.push({
          name: fm.name || path.basename(path.dirname(full)),
          description: fm.description || '',
          category: fm.category || category || 'Uncategorized',
          sourcePath: full,
          origin,
          content,
        });
      }
    }
  }
  await visit(dir, '');
  return found;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const agent = await getAgentRuntime(name);
  const query = request.nextUrl.searchParams.get('q')?.toLowerCase() ?? '';
  const category = request.nextUrl.searchParams.get('category') ?? 'All';

  let skills: Skill[] = [];
  if (agent.runtime === 'hermes') {
    skills = await walk(path.join(getHermesHome(), 'skills'), 'hermes-local');
  } else {
    const [agentSkills, community] = await Promise.all([
      walk(path.join(agent.home, '.claude', 'skills'), 'cortextos-agent'),
      walk(getCommunitySkillsDir(), 'community'),
    ]);
    skills = [...agentSkills, ...community];
  }

  const categories = ['All', ...Array.from(new Set(skills.map((skill) => skill.category).filter(Boolean))).sort()];
  const filtered = skills.filter((skill) => {
    const haystack = `${skill.name} ${skill.description} ${skill.sourcePath}`.toLowerCase();
    return (!query || haystack.includes(query)) && (category === 'All' || skill.category === category);
  });

  return Response.json({ skills: filtered, categories, total: filtered.length, runtime: agent.runtime });
}
