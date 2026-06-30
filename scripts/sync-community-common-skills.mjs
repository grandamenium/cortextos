#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ROOT = process.cwd();
const CATALOG_PATH = join(ROOT, 'community', 'catalog.json');
const COMMUNITY_SKILLS = join(ROOT, 'community', 'skills');
const COMMON_SKILLS = [
  'agent-management',
  'approvals',
  'bus-reference',
  'comms',
  'cron-management',
  'event-logging',
  'guardrails-reference',
  'heartbeat',
  'human-tasks',
  'knowledge-base',
  'memory',
  'onboarding',
  'system-diagnostics',
  'tasks',
];

function readCatalogTemplateAgents() {
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf-8'));
  if (!Array.isArray(catalog.items)) {
    throw new Error('community/catalog.json must contain an items array');
  }

  return catalog.items
    .filter((item) => (
      item &&
      item.type === 'agent' &&
      item.review_status === 'community' &&
      typeof item.install_path === 'string' &&
      item.install_path.startsWith('community/agents/')
    ))
    .map((item) => item.install_path);
}

const templatePaths = readCatalogTemplateAgents();
if (templatePaths.length === 0) {
  throw new Error('No community template agents found in community/catalog.json');
}

for (const skill of COMMON_SKILLS) {
  const source = join(COMMUNITY_SKILLS, skill, 'SKILL.md');
  if (!existsSync(source)) {
    throw new Error(`Missing canonical common skill: community/skills/${skill}/SKILL.md`);
  }

  for (const templatePath of templatePaths) {
    const target = join(ROOT, templatePath, '.claude', 'skills', skill, 'SKILL.md');
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
}

console.log(`Synced ${COMMON_SKILLS.length} common skills into ${templatePaths.length} community templates.`);
