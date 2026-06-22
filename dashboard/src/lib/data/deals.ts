import fs from 'fs';
import path from 'path';
import { getDealsDir, getOrgs } from '@/lib/config';
import type { Deal, DealStatus } from '@/lib/types';

export interface DealUpdate {
  status?: DealStatus;
  notes?: string;
  strategy?: string;
  score?: number;
}

export function updateDeal(dealId: string, org: string, update: DealUpdate): Deal | null {
  const dir = getDealsDir(org);
  if (!fs.existsSync(dir)) return null;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const filePath = path.join(dir, file);
    try {
      const deal = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Deal;
      if (deal.id !== dealId) continue;
      const updated: Deal = { ...deal, ...update, updated_at: new Date().toISOString() };
      fs.writeFileSync(filePath, JSON.stringify(updated, null, 2));
      return updated;
    } catch { continue; }
  }
  return null;
}

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
