// cortextOS Dashboard - Priority inbox digest reader
// Reads flagged emails written by check-business-inboxes.js cron

import fs from 'fs';
import path from 'path';
import os from 'os';

export interface InboxItem {
  account: string;
  from: string;
  subject: string;
  snippet: string;
  category: string | null;
  isDeal: boolean;
  flaggedAt: string;
}

export function getInboxDigest(limit = 15): InboxItem[] {
  const instanceId = process.env.CTX_INSTANCE_ID ?? 'default';
  const ctxRoot = process.env.CTX_ROOT
    ?? path.join(os.homedir(), '.cortextos', instanceId);
  const digestPath = path.join(ctxRoot, 'state', 'data', 'inbox-digest.json');

  try {
    const raw = fs.readFileSync(digestPath, 'utf8');
    const items = JSON.parse(raw) as InboxItem[];
    return Array.isArray(items) ? items.slice(0, limit) : [];
  } catch {
    return [];
  }
}
