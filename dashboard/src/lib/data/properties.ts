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

export interface PropertyTeamMember {
  name: string;
  role: string;
  email?: string;
}

export interface DrawLineItem {
  line: string;
  item: string;
  budget: number;
  released: number;
  approved?: number;
  status: string;
  notes?: string;
}

export interface PropertyDraws {
  loan_total: number;
  total_approved: number;
  total_released: number;
  remaining_balance: number;
  source_url?: string;
  line_items?: DrawLineItem[];
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
  lender?: string;
  purchase_price?: number;
  closing_costs?: number;
  original_budget?: number;
  total_budget?: number;
  total_committed?: {
    total: number;
    purchase_price: number;
    closing_costs: {
      total: number;
      items: Array<{ item: string; amount: number }>;
    };
    rehab_released: number;
    outstanding_debts: {
      total: number;
      items: Array<{ item: string; amount: number | null; status: string }>;
    };
  };
  financials?: {
    target_sale_price: number;
    total_obligations: number;
    projected_net: number;
    note?: string;
  };
  draws?: PropertyDraws;
  team?: PropertyTeamMember[];
  share_token?: string;
  units: PropertyUnit[];
  needs: PropertyNeed[];
  balances_owed: BalanceOwed[];
  past_orders: PastOrder[];
  quotes: Array<{ date: string; item: string; vendor: string; amount?: number; amount_range?: string; notes?: string }>;
  spreadsheet_url?: string;
  status_note?: string;
  last_report?: string;
  last_report_by?: string;
  updated_at: string;
  project_summary?: {
    status?: string;
    arv?: {
      without_basement?: { low: number; high: number };
      with_basement?: { low: number; high: number };
      market_note?: string;
    };
    ownership?: Array<{ entity: string; share: string }>;
    exit_scenarios?: {
      sell?: {
        assumed_price?: number;
        note?: string;
        ppf_payoff?: number;
        costs_est?: number;
        gross_net?: number;
        net_to_partners?: number;
        capital_returns?: Array<{ recipient: string; amount: number; note?: string }>;
        total_capital_returns?: number;
        profit_pool?: number;
        waterfall?: Array<{ recipient: string; amount: number; note?: string }>;
        partner_totals?: Array<{ recipient: string; capital: number; profit: number; total: number }>;
      };
      hold_refi?: {
        note?: string;
        refi_loan?: number;
        cash_out_est?: number;
        waterfall?: Array<{ recipient: string; amount: number; note?: string }>;
        rental?: {
          monthly_rent_est?: { low: number; high: number };
          monthly_dscr_payment?: number;
          monthly_cash_flow_est?: { low: number; high: number };
        };
      };
    };
  };
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

export function getPropertyByShareToken(token: string): Property | null {
  const all = getProperties();
  return all.find((p) => p.share_token === token) ?? null;
}
