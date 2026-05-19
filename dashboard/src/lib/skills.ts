import { execFileSync } from 'child_process';

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

const FEATURED_GRAPHIFY: SkillRecord = {
  name: 'graphify',
  description: 'Launch a graphify workflow in Claude Code.',
  synthetic: true,
};

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

export function getSkillsList(): SkillRecord[] {
  const cacheKey = 'skills';
  const cached = getCached(skillCache, cacheKey);
  if (cached) return cached;

  try {
    const stdout = execFileSync(
      'cortextos',
      ['bus', 'list-skills', '--format', 'json'],
      { encoding: 'utf-8', timeout: 2_000 },
    );
    const parsed = JSON.parse(stdout) as RawSkillRecord[];
    const skills = parsed
      .map((skill) => ({
        name: skill.name,
        description: skill.description ?? '',
        path: skill.path,
        source: skill.source,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return setCached(skillCache, cacheKey, skills, SKILL_CACHE_TTL_MS);
  } catch {
    return [];
  }
}

export function getLauncherSkills(limit: number = 10): LauncherSkills {
  const all = getSkillsList();
  const visibleCount = all.length > limit
    ? Math.max(0, limit - 1)
    : Math.min(all.length, limit);
  const visible = all.slice(0, visibleCount);

  if (visibleCount > 0 && !visible.some((skill) => skill.name === 'graphify')) {
    visible[visibleCount - 1] = FEATURED_GRAPHIFY;
  }

  return {
    all,
    visible,
    overflow: Math.max(0, all.length - visibleCount),
  };
}
