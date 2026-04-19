import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { CTX_ROOT } from '@/lib/config';

export const dynamic = 'force-dynamic';

interface SystemConfig {
  heartbeatStalenessThreshold: number;
  maxCrashesPerDay: number;
  sessionRefreshInterval: number;
  brand_name?: string;
}

const DEFAULT: SystemConfig = {
  heartbeatStalenessThreshold: 120,
  maxCrashesPerDay: 5,
  sessionRefreshInterval: 300,
};

const CONFIG_PATH = path.join(CTX_ROOT, 'config', 'dashboard-settings.json');

function readConfig(): SystemConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return { ...DEFAULT, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) };
    }
  } catch { /* fallback */ }
  return { ...DEFAULT };
}

export async function GET(_request: NextRequest) {
  try {
    return Response.json({ config: readConfig() });
  } catch (err) {
    console.error('[api/settings/system] GET error:', err);
    return Response.json({ error: 'Failed to fetch system config' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const current = readConfig();
    const updated: SystemConfig = {
      heartbeatStalenessThreshold: Math.max(10, Math.min(3600, Math.round(body.heartbeatStalenessThreshold ?? current.heartbeatStalenessThreshold))),
      maxCrashesPerDay: Math.max(1, Math.min(100, Math.round(body.maxCrashesPerDay ?? current.maxCrashesPerDay))),
      sessionRefreshInterval: Math.max(30, Math.min(3600, Math.round(body.sessionRefreshInterval ?? current.sessionRefreshInterval))),
      ...(body.brand_name !== undefined && { brand_name: String(body.brand_name).trim().slice(0, 100) || undefined }),
    };
    // Atomic write: temp file + rename prevents corrupt settings on crash
    const dir = path.dirname(CONFIG_PATH);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.tmp.${randomBytes(6).toString('hex')}`);
    fs.writeFileSync(tmp, JSON.stringify(updated, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmp, CONFIG_PATH);
    return Response.json({ success: true, config: updated });
  } catch (err) {
    console.error('[api/settings/system] PUT error:', err);
    return Response.json({ error: 'Failed to save system config' }, { status: 500 });
  }
}
