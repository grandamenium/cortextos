import fs from 'fs';
import path from 'path';
import { getFrameworkRoot } from '@/lib/config';

export const dynamic = 'force-dynamic';

function parseSkillMd(content: string): { name: string; description: string } {
  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  let name = '';
  let description = '';
  if (frontmatterMatch) {
    const fm = frontmatterMatch[1];
    const nm = fm.match(/^name:\s*(.+)$/m);
    const dm = fm.match(/^description:\s*(.+)$/m);
    if (nm) name = nm[1].trim().replace(/^["']|["']$/g, '');
    if (dm) description = dm[1].trim().replace(/^["']|["']$/g, '');
  }
  if (!name) {
    const h = content.match(/^#\s+(.+)$/m);
    if (h) name = h[1].trim();
  }
  return { name: name || 'Unnamed Skill', description: description || '' };
}

function getInstalledAgents(frameworkRoot: string, slug: string): string[] {
  const installed: string[] = [];
  const orgsDir = path.join(frameworkRoot, 'orgs');
  if (!fs.existsSync(orgsDir)) return installed;

  for (const orgEntry of fs.readdirSync(orgsDir, { withFileTypes: true })) {
    if (!orgEntry.isDirectory()) continue;
    const agentsDir = path.join(orgsDir, orgEntry.name, 'agents');
    if (!fs.existsSync(agentsDir)) continue;
    for (const agentEntry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!agentEntry.isDirectory()) continue;
      const skillPath = path.join(agentsDir, agentEntry.name, '.claude', 'skills', slug);
      if (fs.existsSync(skillPath)) {
        installed.push(`${orgEntry.name}/${agentEntry.name}`);
      }
    }
  }
  return installed;
}

// Collect unique skill slugs from all agent .claude/skills/ directories
function getAgentSkillSlugs(frameworkRoot: string): Map<string, string> {
  const slugToPath = new Map<string, string>();
  const orgsDir = path.join(frameworkRoot, 'orgs');
  if (!fs.existsSync(orgsDir)) return slugToPath;

  for (const orgEntry of fs.readdirSync(orgsDir, { withFileTypes: true })) {
    if (!orgEntry.isDirectory()) continue;
    const agentsDir = path.join(orgsDir, orgEntry.name, 'agents');
    if (!fs.existsSync(agentsDir)) continue;
    for (const agentEntry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!agentEntry.isDirectory()) continue;
      const skillsDir = path.join(agentsDir, agentEntry.name, '.claude', 'skills');
      if (!fs.existsSync(skillsDir)) continue;
      for (const skillEntry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
        if (!skillEntry.isDirectory() || skillEntry.name.startsWith('.')) continue;
        const slug = skillEntry.name;
        if (!slugToPath.has(slug)) {
          slugToPath.set(slug, path.join(skillsDir, slug));
        }
      }
    }
  }
  return slugToPath;
}

export async function GET() {
  try {
    const frameworkRoot = getFrameworkRoot();

    // Build catalog: start with framework skills/ directory, then union with
    // skills discovered in agent .claude/skills/ dirs (the live install source).
    const slugToDir = new Map<string, string>();

    const frameworkCatalog = path.join(frameworkRoot, 'skills');
    if (fs.existsSync(frameworkCatalog)) {
      for (const entry of fs.readdirSync(frameworkCatalog, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        slugToDir.set(entry.name, path.join(frameworkCatalog, entry.name));
      }
    }

    // Agent .claude/skills/ dirs are the live source — add any slugs not in framework catalog
    for (const [slug, dir] of getAgentSkillSlugs(frameworkRoot)) {
      if (!slugToDir.has(slug)) {
        slugToDir.set(slug, dir);
      }
    }

    const skills = [];
    for (const [slug, dir] of slugToDir) {
      const skillMd = path.join(dir, 'SKILL.md');
      const readme = path.join(dir, 'README.md');

      let content = '';
      if (fs.existsSync(skillMd)) content = fs.readFileSync(skillMd, 'utf-8');
      else if (fs.existsSync(readme)) content = fs.readFileSync(readme, 'utf-8');

      const { name, description } = parseSkillMd(content);
      const installedFor = getInstalledAgents(frameworkRoot, slug);

      skills.push({
        slug,
        name: name || slug,
        description,
        installed: installedFor.length > 0,
        installedFor,
      });
    }

    return Response.json(skills.sort((a, b) => a.name.localeCompare(b.name)));
  } catch (err) {
    console.error('[api/skills] error:', err);
    return Response.json([]);
  }
}

// POST /api/skills - Install a skill to an agent
export async function POST(request: Request) {
  try {
    const { slug, org, agent } = await request.json();
    if (!slug || !org || !agent) {
      return Response.json({ error: 'slug, org, and agent required' }, { status: 400 });
    }

    const frameworkRoot = getFrameworkRoot();
    const catalogDir = path.join(frameworkRoot, 'skills', slug);
    if (!fs.existsSync(catalogDir)) {
      return Response.json({ error: `Skill not found: ${slug}` }, { status: 404 });
    }

    const skillsDir = path.join(frameworkRoot, 'orgs', org, 'agents', agent, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    const linkPath = path.join(skillsDir, slug);

    try { if (fs.lstatSync(linkPath).isSymbolicLink()) fs.unlinkSync(linkPath); } catch { /* doesn't exist */ }
    fs.symlinkSync(catalogDir, linkPath, 'dir');

    return Response.json({ success: true });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}

// DELETE /api/skills - Uninstall a skill from an agent
export async function DELETE(request: Request) {
  try {
    const { slug, org, agent } = await request.json();
    if (!slug || !org || !agent) {
      return Response.json({ error: 'slug, org, and agent required' }, { status: 400 });
    }

    const frameworkRoot = getFrameworkRoot();
    const linkPath = path.join(frameworkRoot, 'orgs', org, 'agents', agent, 'skills', slug);

    try {
      const stat = fs.lstatSync(linkPath);
      if (stat.isSymbolicLink()) fs.unlinkSync(linkPath);
      else if (stat.isDirectory()) fs.rmSync(linkPath, { recursive: true });
    } catch {
      return Response.json({ error: `Skill not installed: ${slug}` }, { status: 404 });
    }

    return Response.json({ success: true });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
