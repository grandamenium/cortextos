import { NextRequest } from 'next/server';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import { getFrameworkRoot, getAllAgents, getAgentDir } from '@/lib/config';

export const dynamic = 'force-dynamic';

interface SkillInfo {
  name: string;
  type: 'builtin' | 'active';
  description: string;
}

function resolveAgentConfig(frameworkRoot: string, name: string): { configPath: string; org: string } | null {
  const allAgents = getAllAgents();
  const entry = allAgents.find(a => a.name.toLowerCase() === name.toLowerCase());
  if (entry) {
    const agentDir = getAgentDir(entry.name, entry.org || undefined);
    const p = join(agentDir, 'config.json');
    if (existsSync(p)) return { configPath: p, org: entry.org };
  }

  // Fallback: search all orgs directories
  const orgsDir = join(frameworkRoot, 'orgs');
  if (!existsSync(orgsDir)) return null;
  for (const org of readdirSync(orgsDir)) {
    const p = join(orgsDir, org, 'agents', name, 'config.json');
    if (existsSync(p)) return { configPath: p, org };
  }
  return null;
}

function extractFirstDescription(filePath: string): string {
  try {
    let content = readFileSync(filePath, 'utf-8');

    // Strip YAML frontmatter (--- ... ---)
    if (content.startsWith('---')) {
      const endIdx = content.indexOf('---', 3);
      if (endIdx !== -1) {
        // Check if there's a description in the frontmatter
        const frontmatter = content.slice(3, endIdx);
        const descMatch = frontmatter.match(/description:\s*["']?(.+?)["']?\s*$/m);
        if (descMatch) {
          const desc = descMatch[1].trim();
          return desc.length > 120 ? desc.slice(0, 117) + '...' : desc;
        }
        content = content.slice(endIdx + 3);
      }
    }

    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('#')) continue;
      if (trimmed === '---') continue;
      // Skip markdown metadata lines
      if (trimmed.startsWith('name:') || trimmed.startsWith('triggers:')) continue;
      // Return first non-empty, non-heading, non-frontmatter line, truncated
      return trimmed.length > 120 ? trimmed.slice(0, 117) + '...' : trimmed;
    }
  } catch {
    // ignore read errors
  }
  return '';
}

function scanBuiltinSkills(agentDir: string): SkillInfo[] {
  // Agent-level skills live in the agent's .claude/skills/ directory
  const skillsDir = join(agentDir, '.claude', 'skills');
  if (!existsSync(skillsDir)) return [];

  const skills: SkillInfo[] = [];
  try {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillMd = join(skillsDir, entry.name, 'SKILL.md');
      if (!existsSync(skillMd)) continue;
      skills.push({
        name: entry.name,
        type: 'builtin',
        description: extractFirstDescription(skillMd),
      });
    }
  } catch {
    // ignore scan errors
  }
  return skills;
}

function scanActiveSkills(frameworkRoot: string, org: string, agentName: string): SkillInfo[] {
  // Active skills live in the agent's directory under skills/active/
  const agentDir = getAgentDir(agentName, org || undefined);
  const activeDir = join(agentDir, 'skills', 'active');
  if (!existsSync(activeDir)) return [];

  const skills: SkillInfo[] = [];
  try {
    for (const entry of readdirSync(activeDir)) {
      if (!entry.endsWith('.md')) continue;
      const filePath = join(activeDir, entry);
      try {
        if (!statSync(filePath).isFile()) continue;
      } catch {
        continue;
      }
      skills.push({
        name: basename(entry, '.md'),
        type: 'active',
        description: extractFirstDescription(filePath),
      });
    }
  } catch {
    // ignore scan errors
  }
  return skills;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  if (!/^[a-z0-9_-]+$/.test(name)) {
    return Response.json({ error: 'Invalid agent name' }, { status: 400 });
  }

  const frameworkRoot = getFrameworkRoot();
  const resolved = resolveAgentConfig(frameworkRoot, name);
  if (!resolved) {
    return Response.json({ error: 'Agent not found' }, { status: 404 });
  }

  const agentDir = getAgentDir(name, resolved.org || undefined);

  let role: string | undefined;
  try {
    const config = JSON.parse(readFileSync(resolved.configPath, 'utf-8'));
    role = config.role;
  } catch {
    // ignore parse errors
  }

  const builtinSkills = scanBuiltinSkills(agentDir);
  const activeSkills = scanActiveSkills(frameworkRoot, resolved.org, name);

  // Check for DESIGN.md in the agent directory
  const hasDesignSystem = existsSync(join(agentDir, 'DESIGN.md'));

  return Response.json({
    skills: [...activeSkills, ...builtinSkills],
    role: role || null,
    hasDesignSystem,
  });
}
