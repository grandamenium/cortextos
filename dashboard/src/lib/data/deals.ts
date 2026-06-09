import fs from 'fs';
import path from 'path';
import { getDealsDir, getOrgs } from '@/lib/config';
import type { Deal } from '@/lib/types';

function readDealFile(filePath: string): Deal | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as Deal;
  } catch {
    return null;
  }
}

export function getDeals(org?: string): Deal[] {
  const orgs = org ? [org] : getOrgs();
  const deals: Deal[] = [];

  for (const o of orgs) {
    const dir = getDealsDir(o);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      const deal = readDealFile(path.join(dir, file));
      if (deal) deals.push(deal);
    }
  }

  return deals.sort(
    (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
  );
}
