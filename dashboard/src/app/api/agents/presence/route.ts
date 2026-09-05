import fs from 'fs';
import path from 'path';
import { getCTXRoot } from '@/lib/config';

export const dynamic = 'force-dynamic';

export interface AgentPresence {
  name: string;
  /** stdout grew within the last ~5s (fast-checker's typing.flag). */
  typing: boolean;
  /** Epoch ms of the last stdout write, null if no log exists. */
  lastOutputAt: number | null;
}

/**
 * GET /api/agents/presence — one-pass presence snapshot for the whole fleet.
 *
 * Replaces N per-agent /typing calls with a single directory scan:
 * `<ctxRoot>/logs/<agent>/typing.flag` (timestamp refreshed while stdout
 * grows, valid ~5s) plus `stdout.log` mtime for the "recently active"
 * window. The route reports every log dir it finds — workers and retired
 * agents included — and leaves filtering to the caller, which knows which
 * agents it is rendering.
 */
export async function GET() {
  const ctxRoot = getCTXRoot();
  const logsRoot = path.join(ctxRoot, 'logs');

  let dirs: string[] = [];
  try {
    dirs = fs
      .readdirSync(logsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^[a-z0-9_-]+$/.test(d.name))
      .map((d) => d.name);
  } catch {
    return Response.json({ agents: [] });
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const agents: AgentPresence[] = dirs.map((name) => {
    let typing = false;
    try {
      const flag = fs.readFileSync(path.join(logsRoot, name, 'typing.flag'), 'utf-8').trim();
      const ts = parseInt(flag, 10);
      typing = !isNaN(ts) && nowSec - ts <= 5;
    } catch {
      /* no flag — not typing */
    }

    let lastOutputAt: number | null = null;
    try {
      lastOutputAt = fs.statSync(path.join(logsRoot, name, 'stdout.log')).mtimeMs;
    } catch {
      /* no stdout yet */
    }

    return { name, typing, lastOutputAt };
  });

  return Response.json({ agents });
}
