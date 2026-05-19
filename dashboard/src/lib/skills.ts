import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

interface RawSkillRecord {
  name: string;
  description?: string;
  path?: string;
  source?: string;
}

export interface SkillRecord {
  name: string;
  description: string;
  path?: string;
  source?: string;
  synthetic?: boolean;
}

export interface LauncherSkills {
  all: SkillRecord[];
  visible: SkillRecord[];
  overflow: number;
}

const SKILL_CACHE_TTL_MS = 5 * 60_000;

const skillCache = new Map<string, CacheEntry<SkillRecord[]>>();

export const LAUNCHER_FEATURED = [
  'graphify',
  'invoicing',
  'gws-meta-workflows',
  'browser',
  'cold-email',
  'content-strategy',
  'seo',
  'm2c1-worker',
] as const;

function getCached<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function setCached<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, ttlMs: number): T {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function extractFrontmatter(content: string): { body: string; raw: string | null } {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) {
    return { body: content, raw: null };
  }

  return {
    raw: match[1] ?? null,
    body: content.slice(match[0].length),
  };
}

function extractFrontmatterValue(frontmatter: string | null, key: 'name' | 'description'): string | null {
  if (!frontmatter) return null;
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  if (!match?.[1]) return null;
  return stripWrappingQuotes(match[1]);
}

function extractFirstHeading(body: string): string | null {
  const match = body.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() ?? null;
}

function extractFirstDescriptionLine(body: string): string {
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('```')) continue;
    return trimmed;
  }

  return '';
}

function readUserSkillsFromDisk(): SkillRecord[] {
  const skillsRoot = path.join(os.homedir(), '.claude', 'skills');
  if (!fs.existsSync(skillsRoot)) return [];

  try {
    const entries = fs
      .readdirSync(skillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'));

    const skills: SkillRecord[] = [];

    for (const entry of entries) {
      const skillPath = path.join(skillsRoot, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillPath)) continue;

      try {
        const content = fs.readFileSync(skillPath, 'utf-8');
        const { raw, body } = extractFrontmatter(content);
        const name = extractFrontmatterValue(raw, 'name') ?? extractFirstHeading(body) ?? entry.name;
        const description = extractFrontmatterValue(raw, 'description') ?? extractFirstDescriptionLine(body);

        skills.push({
          name,
          description,
          path: skillPath,
          source: 'user',
        });
      } catch (err) {
        console.error(`[skills] Failed reading user skill at ${skillPath}:`, err);
      }
    }

    return skills;
  } catch (err) {
    console.error('[skills] Failed reading ~/.claude/skills:', err);
    return [];
  }
}

function readBusSkills(): SkillRecord[] {
  try {
    const stdout = execFileSync(
      'cortextos',
      ['bus', 'list-skills', '--format', 'json'],
      { encoding: 'utf-8', timeout: 2_000 },
    );
    const parsed = JSON.parse(stdout) as RawSkillRecord[];

    return parsed.map((skill) => ({
      name: skill.name,
      description: skill.description ?? '',
      path: skill.path,
      source: skill.source,
    }));
  } catch (err) {
    console.error('[skills] Failed reading bus skills:', err);
    return [];
  }
}

export function getSkillsList(): SkillRecord[] {
  const cacheKey = 'skills';
  const cached = getCached(skillCache, cacheKey);
  if (cached) return cached;

  const userSkills = readUserSkillsFromDisk();
  const busSkills = readBusSkills();
  const merged = new Map<string, SkillRecord>();

  for (const skill of userSkills) {
    merged.set(skill.name, skill);
  }

  for (const skill of busSkills) {
    if (!merged.has(skill.name)) {
      merged.set(skill.name, skill);
    }
  }

  const skills = Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name));
  return setCached(skillCache, cacheKey, skills, SKILL_CACHE_TTL_MS);
}

export function getLauncherSkills(limit: number = 10): LauncherSkills {
  const all = getSkillsList();
  const allByName = new Map(all.map((skill) => [skill.name, skill]));
  const visible = LAUNCHER_FEATURED
    .map((name) => allByName.get(name))
    .filter((skill): skill is SkillRecord => Boolean(skill))
    .slice(0, limit);

  return {
    all,
    visible,
    overflow: Math.max(0, all.length - visible.length),
  };
}
