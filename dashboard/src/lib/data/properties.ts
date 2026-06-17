import fs from 'fs';
import path from 'path';
import { getPropertiesDir, getOrgs } from '@/lib/config';

export interface PropertyUnit {
  name: string;
  status: 'occupied' | 'vacant';
  rent: number | null;
  tenant: string | null;
  notes?: string;
}

export interface PropertyNeed {
  item: string;
  vendor?: string;
  cost: number | null;
  status: 'needed' | 'in_progress' | 'on_hold' | 'quote_pending' | 'pending' | 'done';
  priority: 'urgent' | 'high' | 'medium' | 'low';
  notes?: string;
}

export interface BalanceOwed {
  to: string;
  amount: number | null;
  reason: string;
  status: 'unpaid' | 'collections_risk' | 'paid';
  notes?: string;
}

export interface PastOrder {
  date: string;
  item: string;
  vendor: string;
  cost: number | null;
}

export interface Property {
  id: string;
  name: string;
  city: string;
  state: string;
  owner: string;
  entity: string;
  manager?: string;
  manager_email?: string;
  type: string;
  units: PropertyUnit[];
  needs: PropertyNeed[];
  balances_owed: BalanceOwed[];
  past_orders: PastOrder[];
  quotes: Array<{ date: string; item: string; vendor: string; amount?: number; amount_range?: string }>;
  spreadsheet_url?: string;
  status_note?: string;
  last_report?: string;
  last_report_by?: string;
  updated_at: string;
}

function readPropertyFile(filePath: string): Property | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as Property;
  } catch {
    return null;
  }
}

export function getProperties(org?: string): Property[] {
  const orgs = org ? [org] : getOrgs();
  const properties: Property[] = [];

  for (const o of orgs) {
    const dir = getPropertiesDir(o);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      const prop = readPropertyFile(path.join(dir, file));
      if (prop) properties.push(prop);
    }
  }

  return properties.sort((a, b) => a.name.localeCompare(b.name));
}
