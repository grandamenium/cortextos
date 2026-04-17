import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getCTXRoot } from '@/lib/config';
import { resolveIdentity, buildPairKey } from '@/lib/comms-identity';

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

interface Channel {
  pair: string; // "agent1--agent2" (alphabetically sorted)
  agents: [string, string];
  last_message: { text: string; timestamp: string; from: string };
  message_count: number;
  last_activity: string;
  archived: boolean;
}

const ARCHIVE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * GET /api/comms/channels — List active agent-pair channels.
 *
 * Groups bus messages by sender-recipient pair.
 *
 * Query params:
 *   include_archived — show archived channels (default false)
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const includeArchived = searchParams.get('include_archived') === 'true';

  const ctxRoot = getCTXRoot();
  const identity = resolveIdentity(ctxRoot);
  const inboxBase = path.join(ctxRoot, 'inbox');

  if (!fs.existsSync(inboxBase)) {
    return Response.json([]);
  }

  // Primary source: persistent message history log (JSONL)
  const allMessages: BusMessage[] = [];
  const historyLog = path.join(ctxRoot, 'logs', 'message-history.jsonl');
  if (fs.existsSync(historyLog)) {
    try {
      const lines = fs.readFileSync(historyLog, 'utf-8').trim().split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg: BusMessage = JSON.parse(line);
          if (msg.id && msg.from && msg.to && msg.timestamp) {
            allMessages.push(msg);
          }
        } catch { /* skip */ }
      }
    } catch { /* empty */ }
  }

  // Include Telegram messages
  const logsBase = path.join(ctxRoot, 'logs');
  if (fs.existsSync(logsBase)) {
    let agentLogDirs: string[];
    try {
      agentLogDirs = fs.readdirSync(logsBase, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
    } catch { agentLogDirs = []; }

    // Voice transcript dedup — two-pass bestByMsgId map so transcript
    // entries beat empty stubs with the same Telegram message_id.
    // See channel/[pair]/route.ts for the full explanation.
    for (const agent of agentLogDirs) {
      for (const logFile of ['inbound-messages.jsonl', 'outbound-messages.jsonl']) {
        const filePath = path.join(logsBase, agent, logFile);
        if (!fs.existsSync(filePath)) continue;
        const bestByMsgId = new Map<string, BusMessage>();
        try {
          const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
          const isInbound = logFile.startsWith('inbound');
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const raw = JSON.parse(line);
              if (!raw.timestamp) continue;
              const msgId = `tg-${isInbound ? 'in' : 'out'}-${agent}-${raw.message_id || raw.timestamp}`;
              const fromName = isInbound ? identity.canonicalUser : agent;
              const toName = isInbound ? agent : identity.canonicalUser;
              const candidate: BusMessage = {
                id: msgId,
                from: fromName,
                to: toName,
                priority: 'normal',
                timestamp: raw.timestamp,
                text: raw.text || raw.transcript || '',
                reply_to: null,
              };
              const existing = bestByMsgId.get(msgId);
              if (!existing) {
                bestByMsgId.set(msgId, candidate);
              } else if (!existing.text && candidate.text) {
                bestByMsgId.set(msgId, candidate);
              }
            } catch { /* skip malformed line */ }
          }
        } catch { /* skip unreadable file */ }
        for (const msg of bestByMsgId.values()) {
          if (!msg.text) continue;
          allMessages.push(msg);
        }
      }
    }
  }

  // Deduplicate
  const seen = new Set<string>();
  const unique = allMessages.filter(m => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });

  // Group by agent pair
  const channelMap = new Map<string, BusMessage[]>();
  for (const msg of unique) {
    const pair = buildPairKey(msg.from, msg.to, identity);
    if (!channelMap.has(pair)) channelMap.set(pair, []);
    channelMap.get(pair)!.push(msg);
  }

  const now = Date.now();
  const channels: Channel[] = [];

  for (const [pair, msgs] of channelMap) {
    msgs.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    const latest = msgs[0];
    const lastActivity = new Date(latest.timestamp).getTime();
    const archived = (now - lastActivity) > ARCHIVE_THRESHOLD_MS;

    if (!includeArchived && archived) continue;

    const agents = pair.split('--') as [string, string];
    channels.push({
      pair,
      agents,
      last_message: { text: latest.text, timestamp: latest.timestamp, from: latest.from },
      message_count: msgs.length,
      last_activity: latest.timestamp,
      archived,
    });
  }

  // Sort by last activity descending
  channels.sort((a, b) => b.last_activity.localeCompare(a.last_activity));

  return Response.json(channels);
}
