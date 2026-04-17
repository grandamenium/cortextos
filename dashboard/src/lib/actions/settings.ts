'use server';

import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { revalidatePath } from 'next/cache';
import { CTX_ROOT, getOrgs, getAgentsForOrg, getAgentDir, getOrgContextPath, getOrgBrandVoicePath, getAllowedRootsConfigPath } from '@/lib/config';
import { db } from '@/lib/db';
import type { ActionResult, User } from '@/lib/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TelegramConfig {
  agent: string;
  org: string;
  botToken: string; // masked
  chatId: string;
}

export interface SystemConfig {
  heartbeatStalenessThreshold: number; // seconds
  maxCrashesPerDay: number;
  sessionRefreshInterval: number; // seconds
}

const CONFIG_DIR = path.join(CTX_ROOT, 'config');
const SYSTEM_CONFIG_PATH = path.join(CONFIG_DIR, 'dashboard-settings.json');

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

function maskToken(token: string): string {
  if (token.length <= 8) return '****';
  return token.slice(0, 4) + '****' + token.slice(-4);
}

export async function fetchTelegramConfigs(): Promise<TelegramConfig[]> {
  try {
    const configs: TelegramConfig[] = [];
    const orgs = getOrgs();

    for (const org of orgs) {
      const agents = getAgentsForOrg(org);
      for (const agent of agents) {
        const agentDir = getAgentDir(agent, org);
        const envPath = path.join(agentDir, '.env');

        if (!fs.existsSync(envPath)) continue;

        const content = fs.readFileSync(envPath, 'utf-8');
        let botToken = '';
        let chatId = '';

        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.startsWith('#')) continue;

          const match = trimmed.match(/^(\w+)=(.*)$/);
          if (!match) continue;

          const [, key, value] = match;
          const cleanValue = value.replace(/^["']|["']$/g, '');

          if (key === 'TELEGRAM_BOT_TOKEN' || key === 'TG_BOT_TOKEN' || key === 'BOT_TOKEN') {
            botToken = cleanValue;
          } else if (key === 'TELEGRAM_CHAT_ID' || key === 'TG_CHAT_ID' || key === 'CHAT_ID') {
            chatId = cleanValue;
          }
        }

        if (botToken || chatId) {
          configs.push({
            agent,
            org,
            botToken: botToken ? maskToken(botToken) : '-',
            chatId: chatId || '-',
          });
        }
      }
    }

    return configs;
  } catch {
    return [];
  }
}

export async function getFullToken(
  agent: string,
  org: string,
): Promise<{ botToken: string; chatId: string } | null> {
  try {
    const agentDir = getAgentDir(agent, org);
    const envPath = path.join(agentDir, '.env');

    if (!fs.existsSync(envPath)) return null;

    const content = fs.readFileSync(envPath, 'utf-8');
    let botToken = '';
    let chatId = '';

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#')) continue;

      const match = trimmed.match(/^(\w+)=(.*)$/);
      if (!match) continue;

      const [, key, value] = match;
      const cleanValue = value.replace(/^["']|["']$/g, '');

      if (key === 'TELEGRAM_BOT_TOKEN' || key === 'TG_BOT_TOKEN' || key === 'BOT_TOKEN') {
        botToken = cleanValue;
      } else if (key === 'TELEGRAM_CHAT_ID' || key === 'TG_CHAT_ID' || key === 'CHAT_ID') {
        chatId = cleanValue;
      }
    }

    return { botToken, chatId };
  } catch {
    return null;
  }
}

export async function saveTelegramConfig(
  agent: string,
  org: string,
  botToken: string,
  chatId: string,
): Promise<ActionResult> {
  try {
    const agentDir = getAgentDir(agent, org);
    const envPath = path.join(agentDir, '.env');

    if (!fs.existsSync(envPath)) {
      return { success: false, error: '.env file not found for this agent' };
    }

    const content = fs.readFileSync(envPath, 'utf-8');
    const lines = content.split('\n');
    const newLines: string[] = [];
    let foundBotToken = false;
    let foundChatId = false;

    for (const line of lines) {
      const trimmed = line.trim();
      const match = trimmed.match(/^(\w+)=(.*)$/);

      if (match) {
        const [, key] = match;
        if (key === 'TELEGRAM_BOT_TOKEN' || key === 'TG_BOT_TOKEN' || key === 'BOT_TOKEN') {
          newLines.push(`${key}=${botToken}`);
          foundBotToken = true;
          continue;
        }
        if (key === 'TELEGRAM_CHAT_ID' || key === 'TG_CHAT_ID' || key === 'CHAT_ID') {
          newLines.push(`${key}=${chatId}`);
          foundChatId = true;
          continue;
        }
      }

      newLines.push(line);
    }

    // If keys weren't found, append them
    if (!foundBotToken) {
      newLines.push(`BOT_TOKEN=${botToken}`);
    }
    if (!foundChatId) {
      newLines.push(`CHAT_ID=${chatId}`);
    }

    fs.writeFileSync(envPath, newLines.join('\n'), 'utf-8');

    revalidatePath('/settings');
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// System Config
// ---------------------------------------------------------------------------

const DEFAULT_SYSTEM_CONFIG: SystemConfig = {
  heartbeatStalenessThreshold: 120,
  maxCrashesPerDay: 5,
  sessionRefreshInterval: 300,
};

export async function fetchSystemConfig(): Promise<SystemConfig> {
  try {
    if (fs.existsSync(SYSTEM_CONFIG_PATH)) {
      const raw = fs.readFileSync(SYSTEM_CONFIG_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_SYSTEM_CONFIG, ...parsed };
    }
  } catch {
    // Fall through to default
  }
  return { ...DEFAULT_SYSTEM_CONFIG };
}

export async function saveSystemConfig(config: SystemConfig): Promise<ActionResult> {
  try {
    const validated: SystemConfig = {
      heartbeatStalenessThreshold: Math.max(10, Math.min(3600, Math.round(config.heartbeatStalenessThreshold))),
      maxCrashesPerDay: Math.max(1, Math.min(100, Math.round(config.maxCrashesPerDay))),
      sessionRefreshInterval: Math.max(30, Math.min(3600, Math.round(config.sessionRefreshInterval))),
    };

    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(SYSTEM_CONFIG_PATH, JSON.stringify(validated, null, 2), 'utf-8');

    revalidatePath('/settings');
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export async function fetchUsers(): Promise<Array<{ id: number; username: string; created_at: string }>> {
  try {
    const rows = db.prepare('SELECT id, username, created_at FROM users ORDER BY id').all() as User[];
    return rows.map((r) => ({ id: r.id, username: r.username, created_at: r.created_at }));
  } catch {
    return [];
  }
}

export async function addUser(username: string, password: string): Promise<ActionResult> {
  try {
    const trimmed = username.trim();
    if (!trimmed) return { success: false, error: 'Username is required' };
    if (trimmed.length < 3) return { success: false, error: 'Username must be at least 3 characters' };
    if (trimmed.length > 50) return { success: false, error: 'Username must be under 50 characters' };
    if (!password || password.length < 6) return { success: false, error: 'Password must be at least 6 characters' };

    // Check for duplicate
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(trimmed) as User | undefined;
    if (existing) return { success: false, error: 'Username already exists' };

    const hash = await bcrypt.hash(password, 12);
    db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(trimmed, hash);

    revalidatePath('/settings');
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

export async function deleteUser(userId: number): Promise<ActionResult> {
  try {
    // Prevent deleting the last user
    const count = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
    if (count.count <= 1) {
      return { success: false, error: 'Cannot delete the last user' };
    }

    const result = db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    if (result.changes === 0) {
      return { success: false, error: 'User not found' };
    }

    revalidatePath('/settings');
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// Organization metadata
// ---------------------------------------------------------------------------

export async function fetchOrgMetadata() {
  const orgs = getOrgs();
  // Find the first org that has a context.json (skip empty/unconfigured orgs)
  const org = orgs.find(o => fs.existsSync(getOrgContextPath(o))) ?? orgs[0] ?? '';
  if (!org) {
    return { context: { name: '', description: '', industry: '', icp: '', value_prop: '' }, brandVoice: '' };
  }

  let context = { name: '', description: '', industry: '', icp: '', value_prop: '' };
  let brandVoice = '';

  try {
    const contextPath = getOrgContextPath(org);
    if (fs.existsSync(contextPath)) {
      const raw = JSON.parse(fs.readFileSync(contextPath, 'utf-8'));
      context = {
        name: raw.name ?? '',
        description: raw.description ?? '',
        industry: raw.industry ?? '',
        icp: raw.icp ?? '',
        value_prop: raw.value_prop ?? '',
      };
    }
  } catch {
    // graceful fallback
  }

  try {
    const bvPath = getOrgBrandVoicePath(org);
    if (fs.existsSync(bvPath)) {
      brandVoice = fs.readFileSync(bvPath, 'utf-8');
    }
  } catch {
    // graceful fallback
  }

  return { context, brandVoice };
}

// ---------------------------------------------------------------------------
// Allowed Roots — controls which directories the /api/media route can serve
// ---------------------------------------------------------------------------

interface AllowedRootsView {
  ctx_root: string;
  additional_roots: AllowedRootEntry[];
}

interface AllowedRootEntry {
  path: string;
  exists: boolean;
}

const SYSTEM_BLOCKLIST: string[] = [
  '/',
  'C:/',
  'D:/',
  'E:/',
  '/usr',
  '/etc',
  '/var',
  '/sys',
  '/proc',
  '/boot',
  '/dev',
  '/root',
  '/System',
  'C:/Windows',
  'C:/Program Files',
  'C:/Program Files (x86)',
];

function normalizeFsPath(p: string): string {
  let n = p.replace(/\\/g, '/');
  if (n.length > 1 && n.endsWith('/') && !/^[A-Za-z]:\/$/.test(n)) {
    n = n.slice(0, -1);
  }
  return n;
}

export async function fetchAllowedRoots(): Promise<AllowedRootsView> {
  const ctxRoot = normalizeFsPath(CTX_ROOT);
  const configPath = getAllowedRootsConfigPath();

  let additional: string[] = [];
  if (fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (Array.isArray(parsed.additional_roots)) {
        additional = parsed.additional_roots
          .filter((r: unknown): r is string => typeof r === 'string')
          .map((r: string) => normalizeFsPath(r));
      }
    } catch { /* malformed file — treat as empty */ }
  }

  return {
    ctx_root: ctxRoot,
    additional_roots: additional.map((p) => ({
      path: p,
      exists: fs.existsSync(p),
    })),
  };
}

export async function addAllowedRoot(rawPath: string): Promise<ActionResult> {
  const trimmed = rawPath.trim();
  if (!trimmed) return { success: false, error: 'Path is required' };
  if (!path.isAbsolute(trimmed)) {
    return { success: false, error: 'Path must be absolute (start with / or a drive letter)' };
  }

  const normalized = normalizeFsPath(trimmed);

  for (const blocked of SYSTEM_BLOCKLIST) {
    if (normalized === normalizeFsPath(blocked)) {
      return { success: false, error: `Cannot add system directory: ${normalized}. This path is on the security blocklist.` };
    }
  }

  if (!fs.existsSync(normalized)) {
    return { success: false, error: `Path does not exist: ${normalized}` };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(normalized);
  } catch {
    return { success: false, error: `Path is not readable: ${normalized}` };
  }
  if (!stat.isDirectory()) {
    return { success: false, error: `Path is not a directory: ${normalized}` };
  }

  const configPath = getAllowedRootsConfigPath();
  let current: { additional_roots: string[] } = { additional_roots: [] };
  if (fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (Array.isArray(parsed.additional_roots)) {
        current.additional_roots = parsed.additional_roots
          .filter((r: unknown): r is string => typeof r === 'string')
          .map((r: string) => normalizeFsPath(r));
      }
    } catch { /* malformed — treat as empty */ }
  }

  if (current.additional_roots.includes(normalized)) {
    return { success: false, error: `Path is already in the allowed roots list: ${normalized}` };
  }

  const updated = { additional_roots: [...current.additional_roots, normalized] };
  const configDir = path.dirname(configPath);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  const tmpPath = configPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(updated, null, 2));
  fs.renameSync(tmpPath, configPath);

  revalidatePath('/settings');
  return { success: true };
}

export async function removeAllowedRoot(rawPath: string): Promise<ActionResult> {
  const normalized = normalizeFsPath(rawPath.trim());
  const configPath = getAllowedRootsConfigPath();

  let current: { additional_roots: string[] } = { additional_roots: [] };
  if (fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (Array.isArray(parsed.additional_roots)) {
        current.additional_roots = parsed.additional_roots
          .filter((r: unknown): r is string => typeof r === 'string')
          .map((r: string) => normalizeFsPath(r));
      }
    } catch { /* malformed — treat as empty */ }
  }

  const updated = { additional_roots: current.additional_roots.filter((r) => r !== normalized) };
  const configDir = path.dirname(configPath);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  const tmpPath = configPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(updated, null, 2));
  fs.renameSync(tmpPath, configPath);

  revalidatePath('/settings');
  return { success: true };
}
