import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getCTXRoot } from '@/lib/config';
import { resolveIdentity } from '@/lib/comms-identity';

export const dynamic = 'force-dynamic';

interface BusMessage {
  id: string;
  from: string;
  to: string;
  priority: string;
  timestamp: string;
  text: string;
  reply_to: string | null;
}

/**
 * GET /api/comms/feed — Org-wide chronological feed of bus messages.
 *
 * Scans all agents' inbox directories (processed, inflight, pending)
 * for JSON message files. Returns newest first.
 *
 * Query params:
 *   org    — filter by org (required for agent discovery)
 *   agent  — filter by sender OR recipient
 *   limit  — max messages (default 100, max 500)
 *   before — ISO cursor for pagination
 *   search — text search in message body
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  // `org` param is accepted but not yet applied — agents for different orgs
  // are already isolated at the filesystem level under the configured
  // CTX_ROOT, so the feed naturally scopes to the active org.
  const agentFilter = searchParams.get('agent') || '';
  const defaultLimit = 200;
  const maxLimit = 500;
  const rawLimit = parseInt(searchParams.get('limit') ?? String(defaultLimit), 10) || defaultLimit;
  const before = searchParams.get('before');
  const search = searchParams.get('search')?.toLowerCase().trim() || '';
  // When searching, scan all messages (capped at maxLimit). When not
  // searching, use the requested limit (default 200) for the recent view.
  const limit = search ? maxLimit : Math.min(Math.max(rawLimit, 1), maxLimit);
  // Word-boundary search: build a regex so "help" matches "help" and
  // "helpful" but not "chelp". Falls back to substring if the search
  // term contains characters that break regex construction.
  let searchRegex: RegExp | null = null;
  if (search) {
    try {
      searchRegex = new RegExp(`\\b${search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
    } catch {
      searchRegex = null; // fall back to includes
    }
  }
  function matchesSearch(text: string): boolean {
    if (!search) return true;
    if (searchRegex) return searchRegex.test(text);
    return text.toLowerCase().includes(search);
  }

  const ctxRoot = getCTXRoot();
  const identity = resolveIdentity(ctxRoot);
  const inboxBase = path.join(ctxRoot, 'inbox');

  if (!fs.existsSync(inboxBase)) {
    return Response.json([]);
  }

  const messages: BusMessage[] = [];

  // Primary source: persistent message history log (JSONL)
  const historyLog = path.join(ctxRoot, 'logs', 'message-history.jsonl');
  if (fs.existsSync(historyLog)) {
    try {
      const lines = fs.readFileSync(historyLog, 'utf-8').trim().split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg: BusMessage = JSON.parse(line);
          if (!msg.id || !msg.from || !msg.to || !msg.timestamp) continue;
          if (agentFilter && msg.from !== agentFilter && msg.to !== agentFilter) continue;
          if (!matchesSearch(msg.text)) continue;
          if (before && msg.timestamp >= before) continue;
          messages.push(msg);
        } catch { /* skip corrupt lines */ }
      }
    } catch { /* fall through to inbox scan */ }
  }

  // Fallback: scan inbox + processed directories for messages not in the history log.
  // Processed messages (ACK'd via check-inbox) are moved to ctxRoot/processed/{agent}/
  // and are invisible without this scan when the history log is empty or absent.
  const seen = new Set<string>(messages.map(m => m.id));
  const processedBase = path.join(ctxRoot, 'processed');

  for (const [base, subs] of [[inboxBase, ['inflight', '']], [processedBase, ['']]] as const) {
    if (!fs.existsSync(base)) continue;
    let agentDirs: string[];
    try {
      agentDirs = fs.readdirSync(base, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
    } catch {
      agentDirs = [];
    }

    for (const agent of agentDirs) {
      for (const sub of subs) {
        const dir = sub ? path.join(base, agent, sub) : path.join(base, agent);
        if (!fs.existsSync(dir)) continue;
        let files: string[];
        try {
          files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('.'));
        } catch { continue; }

        for (const file of files) {
          try {
            const raw = fs.readFileSync(path.join(dir, file), 'utf-8');
            const msg: BusMessage = JSON.parse(raw);
            if (!msg.id || !msg.from || !msg.to || !msg.timestamp) continue;
            if (seen.has(msg.id)) continue;
            if (agentFilter && msg.from !== agentFilter && msg.to !== agentFilter) continue;
            if (!matchesSearch(msg.text)) continue;
            if (before && msg.timestamp >= before) continue;
            seen.add(msg.id);
            messages.push(msg);
          } catch { /* skip */ }
        }
      }
    }
  }

  // Include Telegram messages (inbound from user + outbound from agents)
  const logsBase = path.join(ctxRoot, 'logs');
  if (fs.existsSync(logsBase)) {
    let agentLogDirs: string[];
    try {
      agentLogDirs = fs.readdirSync(logsBase, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
    } catch { agentLogDirs = []; }

    for (const agent of agentLogDirs) {
      for (const logFile of ['inbound-messages.jsonl', 'outbound-messages.jsonl']) {
        const filePath = path.join(logsBase, agent, logFile);
        if (!fs.existsSync(filePath)) continue;
        try {
          const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
          const isInbound = logFile.startsWith('inbound');
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const raw = JSON.parse(line);
              const msgId = `tg-${isInbound ? 'in' : 'out'}-${agent}-${raw.message_id || raw.timestamp}`;
              if (seen.has(msgId)) continue;
              if (!raw.text || !raw.timestamp) continue;

              const fromName = isInbound ? identity.canonicalUser : agent;
              const toName = isInbound ? agent : identity.canonicalUser;

              if (agentFilter && fromName !== agentFilter && toName !== agentFilter) continue;
              if (!matchesSearch(raw.text)) continue;
              if (before && raw.timestamp >= before) continue;

              seen.add(msgId);
              messages.push({
                id: msgId,
                from: fromName,
                to: toName,
                priority: 'normal',
                timestamp: raw.timestamp,
                text: raw.text,
                reply_to: null,
              });
            } catch { /* skip */ }
          }
        } catch { /* skip */ }
      }
    }
  }

  // Sort by timestamp descending (newest first)
  messages.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  return Response.json(messages.slice(0, limit));
}
