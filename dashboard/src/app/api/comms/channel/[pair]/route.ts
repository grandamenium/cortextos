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
  /** Optional origin marker — set when the message came from a Telegram voice
   *  note so the UI can render a microphone indicator next to the transcript. */
  media_type?: string;
}

/**
 * GET /api/comms/channel/[pair] — Messages for a specific agent pair.
 * pair = "agent1--agent2" (alphabetically sorted).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ pair: string }> },
) {
  const { pair } = await params;
  const agents = pair.split('--');
  if (agents.length !== 2 || !agents.every(a => /^[a-z0-9_-]+$/.test(a))) {
    return Response.json({ error: 'Invalid pair format. Use agent1--agent2' }, { status: 400 });
  }

  const { searchParams } = request.nextUrl;
  const limit = Math.min(Math.max(parseInt(searchParams.get('limit') ?? '100', 10) || 100, 1), 500);
  const before = searchParams.get('before');
  const search = searchParams.get('search')?.toLowerCase().trim() || '';
  let searchRegex: RegExp | null = null;
  if (search) {
    try {
      searchRegex = new RegExp(`\\b${search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
    } catch { searchRegex = null; }
  }
  function matchesSearch(text: string): boolean {
    if (!search) return true;
    if (searchRegex) return searchRegex.test(text);
    return text.toLowerCase().includes(search);
  }

  const ctxRoot = getCTXRoot();
  const messages: BusMessage[] = [];
  const [a1, a2] = agents;

  // Resolve user identity so inbound and outbound Telegram messages
  // land in the same channel as bus messages for the same conversation.
  const identity = resolveIdentity(ctxRoot);

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
          const msgPair = buildPairKey(msg.from, msg.to, identity);
          if (msgPair !== pair) continue;
          if (!matchesSearch(msg.text)) continue;
          if (before && msg.timestamp >= before) continue;
          messages.push(msg);
        } catch { /* skip corrupt lines */ }
      }
    } catch { /* fall through to inbox scan */ }
  }

  // Fallback: scan inbox directories for messages not yet in the history log
  const seen = new Set<string>(messages.map(m => m.id));
  const inboxBase = path.join(ctxRoot, 'inbox');

  if (fs.existsSync(inboxBase)) {
    for (const agent of [a1, a2]) {
      for (const sub of ['processed', 'inflight', '']) {
        const dir = sub ? path.join(inboxBase, agent, sub) : path.join(inboxBase, agent);
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

            const msgPair = buildPairKey(msg.from, msg.to, identity);
            if (msgPair !== pair) continue;

            if (!matchesSearch(msg.text)) continue;
            if (before && msg.timestamp >= before) continue;

            seen.add(msg.id);
            messages.push(msg);
          } catch { /* skip */ }
        }
      }
    }
  }

  // Include Telegram messages for this pair.
  //
  // Voice transcript dedup — Telegram voice notes produce two log entries
  // with the same message_id: a stub (empty text, written immediately on
  // delivery) and a transcript (full text + media_type, written after
  // Whisper/Gemini transcription completes). A naive iteration keeps
  // whichever entry appears first, which is the empty stub.
  //
  // Two-pass approach: first pass builds a bestByMsgId map where entries
  // with non-empty text always beat empty stubs sharing the same id.
  // Second pass emits only the winners. Applies to inbound and outbound.
  const logsBase = path.join(ctxRoot, 'logs');
  if (fs.existsSync(logsBase)) {
    interface RawTelegramEntry {
      id: string;
      from: string;
      to: string;
      priority: string;
      timestamp: string;
      text: string;
      reply_to: null;
      media_type?: string;
    }
    for (const agent of [a1, a2]) {
      for (const logFile of ['inbound-messages.jsonl', 'outbound-messages.jsonl']) {
        const filePath = path.join(logsBase, agent, logFile);
        if (!fs.existsSync(filePath)) continue;
        const bestByMsgId = new Map<string, RawTelegramEntry>();
        try {
          const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
          const isInbound = logFile.startsWith('inbound');
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const raw = JSON.parse(line);
              if (!raw.timestamp) continue;
              const msgId = `tg-${isInbound ? 'in' : 'out'}-${agent}-${raw.message_id || raw.timestamp}`;
              if (seen.has(msgId)) continue;

              // Resolve both sides through the identity layer so inbound
              // (user→agent) and outbound (agent→user) land in the same channel.
              const fromName = isInbound ? identity.canonicalUser : agent;
              const toName = isInbound ? agent : identity.canonicalUser;
              const msgPair = buildPairKey(fromName, toName, identity);
              if (msgPair !== pair) continue;

              // Build the candidate. Text may be empty here — that is fine
              // for the dedup map, the second-pass write-out only emits
              // entries that actually have text.
              const candidate: RawTelegramEntry = {
                id: msgId,
                from: fromName,
                to: toName,
                priority: 'normal',
                timestamp: raw.timestamp,
                text: raw.text || raw.transcript || '',
                reply_to: null,
                ...(raw.media_type ? { media_type: raw.media_type } : {}),
              };

              const existing = bestByMsgId.get(msgId);
              if (!existing) {
                bestByMsgId.set(msgId, candidate);
              } else if (!existing.text && candidate.text) {
                // Upgrade: this entry has real text, the previous one was
                // a stub. Prefer this one. Also carry over media_type if
                // the upgrade brought it along.
                bestByMsgId.set(msgId, candidate);
              }
              // else: both have text, keep the first one (stable order).
              //       or both are stubs, no change.
            } catch { /* skip malformed line */ }
          }
        } catch { /* skip unreadable file */ }

        // Second pass: write the winners to the messages array, filtering
        // out any final entry that still has empty text (pure stubs with
        // no transcript ever arriving). Search filter applied here.
        for (const msg of bestByMsgId.values()) {
          if (!msg.text) continue;
          if (!matchesSearch(msg.text)) continue;
          if (before && msg.timestamp >= before) continue;
          seen.add(msg.id);
          messages.push(msg);
        }
      }
    }
  }

  // Sort by timestamp ascending (oldest first for chat view)
  messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return Response.json(messages.slice(-limit));
}
