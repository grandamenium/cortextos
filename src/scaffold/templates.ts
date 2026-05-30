/**
 * Pure scaffolding helpers shared by the `init` and `add-agent` commands (and,
 * in time, the `add-org --pack` installer). These were extracted verbatim from
 * src/cli/add-agent.ts and src/cli/init.ts (F3) so the install-pack installer
 * can reuse them without going through the Commander actions. No behavior
 * change — the existing add-agent/init tests are the oracle.
 *
 * Note on __dirname: every consumer of these helpers historically lived two
 * levels under the repo root (src/cli/*), and this module is also two levels
 * under it (src/scaffold/*), so the `join(__dirname, '..', '..', 'templates')`
 * dev fallback resolves identically.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, lstatSync, unlinkSync, symlinkSync } from 'fs';
import { join, extname } from 'path';
import { homedir } from 'os';

/**
 * Walk an agent's plugins/cortextos-agent-skills/skills tree and create one
 * symlink per skill in ~/.codex/skills/<agent_name>__<skill_name>.
 *
 * The agent-name prefix prevents collisions when multiple codex agents share
 * the host's ~/.codex/skills directory (codex's default skill discovery
 * location). Existing symlinks pointing at the same target are replaced;
 * non-symlink entries with the same name are left alone (we don't clobber
 * unknown files the user may have placed there).
 *
 * Returns the number of symlinks successfully created or refreshed.
 */
export function installCodexSkillSymlinks(agentDir: string, agentName: string): number {
  const skillsRoot = join(agentDir, 'plugins', 'cortextos-agent-skills', 'skills');
  if (!existsSync(skillsRoot)) return 0;

  const codexSkillsDir = join(homedir(), '.codex', 'skills');
  mkdirSync(codexSkillsDir, { recursive: true });

  let linked = 0;
  const entries = readdirSync(skillsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillSrc = join(skillsRoot, entry.name);
    const linkPath = join(codexSkillsDir, `${agentName}__${entry.name}`);
    try {
      // Replace an existing symlink — but never an actual file/dir owned by the user.
      if (existsSync(linkPath) || lstatSync(linkPath, { throwIfNoEntry: false } as any)) {
        try {
          const st = lstatSync(linkPath);
          if (st.isSymbolicLink()) {
            unlinkSync(linkPath);
          } else {
            // Skip — something else is here, leave it.
            continue;
          }
        } catch { /* path likely doesn't exist; continue to symlink */ }
      }
      symlinkSync(skillSrc, linkPath, 'dir');
      linked++;
    } catch (err) {
      // Don't abort the whole scaffold for one bad symlink.
      console.error(`    Warning: failed to symlink ${linkPath}: ${(err as Error).message}`);
    }
  }
  return linked;
}

export function findTemplateDir(projectRoot: string, template: string): string | null {
  const frameworkRoot = process.env.CTX_FRAMEWORK_ROOT || projectRoot;
  const candidates = [
    join(projectRoot, 'templates', template),
    join(frameworkRoot, 'templates', template),
    join(projectRoot, 'node_modules', 'cortextos', 'templates', template),
    // Relative to this file for development
    join(__dirname, '..', '..', 'templates', template),
  ];

  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return null;
}

export function copyTemplateFiles(templateDir: string, agentDir: string, name: string, org: string): void {
  const files = readdirSync(templateDir);
  for (const file of files) {
    const srcPath = join(templateDir, file);
    const destPath = join(agentDir, file);
    try {
      const stat = require('fs').statSync(srcPath);
      if (stat.isFile()) {
        let content = readFileSync(srcPath, 'utf-8');
        // Replace template placeholders
        content = content.replace(/\{\{agent_name\}\}/g, name);
        content = content.replace(/\{\{org\}\}/g, org);
        content = content.replace(/\{\{current_timestamp\}\}/g, new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'));
        writeFileSync(destPath, content, 'utf-8');
      } else if (stat.isDirectory() && file !== 'node_modules') {
        mkdirSync(destPath, { recursive: true });
        copyTemplateFiles(srcPath, destPath, name, org);
      }
    } catch { /* skip files that can't be read */ }
  }
}

// Directories the deferred-token walker never descends into: VCS/build/dep
// trees that may hold large binary objects and never contain agent bootstrap
// templates.
const DEFERRED_TOKEN_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next']);

// Only these (text) file types are scanned for deferred tokens. The leaking
// placeholders live exclusively in markdown/config text; restricting by
// extension avoids reading binary assets into memory and removes any chance of
// corrupting a binary file that happens to contain a token-like byte sequence.
const DEFERRED_TOKEN_TEXT_EXTS = new Set([
  '.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.env',
  '.sh', '.ts', '.js', '.mjs', '.cjs', '.toml', '.ini', '.csv',
]);

/**
 * Replace org-level placeholders that copyTemplateFiles cannot resolve at copy
 * time (their values come from org context.json, which is read AFTER the copy).
 * Walks the agent dir recursively and substitutes {{key}} -> value in text
 * files only. Pre-F4, {{day_mode_start}}/{{day_mode_end}} leaked verbatim into
 * scaffolded agents (templates/<t>/SOUL.md, ONBOARDING.md, orchestrator skills).
 * Only writes a file when a token actually matched. Symlinks are skipped
 * (isFile() is false); see DEFERRED_TOKEN_SKIP_DIRS / _TEXT_EXTS for bounds.
 */
export function substituteDeferredTokens(dir: string, replacements: Record<string, string>): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (DEFERRED_TOKEN_SKIP_DIRS.has(entry.name)) continue;
      substituteDeferredTokens(full, replacements);
    } else if (entry.isFile()) {
      if (!DEFERRED_TOKEN_TEXT_EXTS.has(extname(entry.name).toLowerCase())) continue;
      try {
        let content = readFileSync(full, 'utf-8');
        let changed = false;
        for (const [key, value] of Object.entries(replacements)) {
          const token = `{{${key}}}`;
          if (content.includes(token)) {
            content = content.split(token).join(value);
            changed = true;
          }
        }
        if (changed) writeFileSync(full, content, 'utf-8');
      } catch { /* skip files that can't be read/written as utf-8 */ }
    }
  }
}

export function createMinimalAgent(agentDir: string, name: string, org: string, template: string): void {
  const role = template === 'orchestrator' ? 'Orchestrator'
    : template === 'analyst' ? 'Analyst'
    : 'Agent';

  writeFileSync(join(agentDir, 'IDENTITY.md'), `# ${name}\n\nYou are ${name}, a ${role} for ${org}.\n`);
  writeFileSync(join(agentDir, 'SOUL.md'), `# Soul\n\nYou are helpful, precise, and proactive.\n`);
  writeFileSync(join(agentDir, 'GOALS.md'), `# Goals\n\n- Awaiting goal configuration\n`);
  writeFileSync(join(agentDir, 'HEARTBEAT.md'), `# Heartbeat Checklist\n\n- [ ] Check inbox\n- [ ] Update heartbeat\n`);
  writeFileSync(join(agentDir, 'MEMORY.md'), `# Long-Term Memory\n\nNothing recorded yet.\n`);
  writeFileSync(join(agentDir, 'USER.md'), `# User Profile\n\nNot configured yet.\n`);
  writeFileSync(join(agentDir, 'SYSTEM.md'), `# System Context\n\nOrganization: ${org}\n`);
  writeFileSync(join(agentDir, 'TOOLS.md'), `# Available Tools\n\nUse \`cortextos bus <command>\` for bus operations.\n`);
  // CLAUDE.md is a thin wrapper that imports AGENTS.md (works with Claude Code's @ import syntax)
  writeFileSync(join(agentDir, 'CLAUDE.md'), '@AGENTS.md\n');
  writeFileSync(join(agentDir, 'AGENTS.md'), createAgentsMd(name, org, template));
}

export function createAgentsMd(name: string, org: string, template: string): string {
  return `# cortextOS ${template.charAt(0).toUpperCase() + template.slice(1)}

## BOOTSTRAP PROTOCOL - READ EVERY FILE BEFORE DOING ANYTHING

Read these files at the start of EVERY session:
1. IDENTITY.md
2. SOUL.md
3. GOALS.md
4. HEARTBEAT.md
5. MEMORY.md
6. memory/$(date -u +%Y-%m-%d).md (today's session state)
7. TOOLS.md
8. SYSTEM.md
9. config.json
10. USER.md

## Bus Commands

Send messages: \`cortextos bus send-message <agent> <priority> "<text>"\`
Check inbox: \`cortextos bus check-inbox\`
ACK messages: \`cortextos bus ack-inbox <id>\`
Create tasks: \`cortextos bus create-task "<title>" --assignee <agent> --priority <p>\`
Update tasks: \`cortextos bus update-task <id> <status>\`
Complete tasks: \`cortextos bus complete-task <id> --result "<text>"\`
Log events: \`cortextos bus log-event <category> <event> <severity>\`
Update heartbeat: \`cortextos bus update-heartbeat "<status>"\`
Send Telegram: \`cortextos bus send-telegram <chat_id> "<text>"\`
React to Telegram message (single emoji ack): \`cortextos bus react-telegram <chat_id> <message_id> 👍\`
`;
}

export function findOrgTemplateDir(projectRoot: string): string | null {
  const candidates = [
    join(projectRoot, 'templates', 'org'),
    join(projectRoot, 'node_modules', 'cortextos', 'templates', 'org'),
    join(__dirname, '..', '..', 'templates', 'org'),
  ];
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return null;
}

export function copyOrgTemplateFiles(templateDir: string, orgDir: string, orgName: string): void {
  try {
    const files = readdirSync(templateDir);
    for (const file of files) {
      const srcPath = join(templateDir, file);
      const destPath = join(orgDir, file);
      if (existsSync(destPath)) continue; // Don't overwrite existing
      try {
        const stat = require('fs').statSync(srcPath);
        if (stat.isFile()) {
          let content = readFileSync(srcPath, 'utf-8');
          content = content.replace(/\{\{org_name\}\}/g, orgName);
          writeFileSync(destPath, content, 'utf-8');
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
}
