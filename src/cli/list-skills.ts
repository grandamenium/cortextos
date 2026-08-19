import { Command } from 'commander';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

interface SkillInfo {
  name: string;
  description: string;
  path: string;
  source: string;
}

/**
 * Parse YAML frontmatter from a SKILL.md file.
 * Extracts name and description fields.
 */
function parseFrontmatter(filePath: string): { name: string; description: string } | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    let inFrontmatter = false;
    let name = '';
    let description = '';

    for (const line of lines) {
      if (line.trim() === '---') {
        if (inFrontmatter) break;
        inFrontmatter = true;
        continue;
      }
      if (inFrontmatter) {
        const nameMatch = line.match(/^name:\s*["']?(.+?)["']?\s*$/);
        if (nameMatch) name = nameMatch[1];
        const descMatch = line.match(/^description:\s*["']?(.+?)["']?\s*$/);
        if (descMatch) description = descMatch[1];
      }
    }

    return name ? { name, description } : null;
  } catch {
    return null;
  }
}

/**
 * Scan a skills directory for SKILL.md files.
 */
function scanSkillsDir(dir: string, source: string): SkillInfo[] {
  if (!existsSync(dir)) return [];

  const skills: SkillInfo[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      // readdirSync's dirent type reflects the entry itself, not its target — a
      // symlink (what agent skill installs are) always reports isDirectory() as
      // false. Follow it with statSync to see what it actually points at.
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.isSymbolicLink()) {
        try {
          if (!statSync(join(dir, entry.name)).isDirectory()) continue;
        } catch {
          continue; // broken symlink
        }
      }
      const skillFile = join(dir, entry.name, 'SKILL.md');
      if (!existsSync(skillFile)) continue;

      const parsed = parseFrontmatter(skillFile);
      if (parsed) {
        skills.push({
          name: parsed.name,
          description: parsed.description,
          path: skillFile,
          source,
        });
      }
    }
  } catch {
    // Directory not readable
  }
  return skills;
}

export const listSkillsCommand = new Command('list-skills')
  .option('--format <format>', 'Output format (json|text)', 'text')
  .option('--agent-dir <dir>', 'Agent directory to scan')
  .description('List available skills for the current agent')
  .action(async (options: { format: string; agentDir?: string }) => {
    const agentDir = options.agentDir || process.cwd();
    const skillMap = new Map<string, SkillInfo>();

    // Find framework template dir
    const templateRoot = findTemplateRoot();

    // Scan in priority order (framework → template → agent)
    // Framework-level skills
    if (templateRoot) {
      const frameworkSkills = join(templateRoot, '..', 'skills');
      for (const skill of scanSkillsDir(frameworkSkills, 'framework')) {
        skillMap.set(skill.name, skill);
      }
    }

    // Template-level skills (detect role from config.json)
    if (templateRoot) {
      try {
        const configPath = join(agentDir, 'config.json');
        if (existsSync(configPath)) {
          const config = JSON.parse(readFileSync(configPath, 'utf-8'));
          const role = config.template || '';
          if (role) {
            const roleSkillsDir = join(templateRoot, role, 'skills');
            for (const skill of scanSkillsDir(roleSkillsDir, `template:${role}`)) {
              skillMap.set(skill.name, skill);
            }
          }
        }
      } catch {
        // Ignore config read errors
      }
    }

    // Agent-level skills (highest priority, override others)
    const agentSkills = join(agentDir, '.claude', 'skills');
    for (const skill of scanSkillsDir(agentSkills, 'agent')) {
      skillMap.set(skill.name, skill);
    }

    const skills = Array.from(skillMap.values()).sort((a, b) => a.name.localeCompare(b.name));

    if (options.format === 'json') {
      console.log(JSON.stringify(skills, null, 2));
    } else {
      if (skills.length === 0) {
        console.log('No skills found.');
        return;
      }
      console.log('Available skills:\n');
      for (const skill of skills) {
        console.log(`  ${skill.name} (${skill.source})`);
        console.log(`    ${skill.description}`);
        console.log('');
      }
      console.log(`Total: ${skills.length} skills`);
    }
  });

function findTemplateRoot(): string | null {
  const candidates = [
    join(process.cwd(), 'templates'),
    join(__dirname, '..', '..', 'templates'),
  ];
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return null;
}
