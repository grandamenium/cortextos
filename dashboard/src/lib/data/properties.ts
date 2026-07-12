import fs from 'fs';
import path from 'path';
import { getPropertiesDir, getOrgs } from '@/lib/config';

export interface PropertyUnit {
  name: string;
  status: 'occupied' | 'vacant';
  rent: number | null;
  tenant: string | null;
  lease_expiration?: string;
  notes?: string;
}

export interface PropertyNeed {
  item: string;
  unit?: string;
  vendor?: string;
  cost: number | null;
  quoted_amount?: number | null;
  status: 'needed' | 'in_progress' | 'on_hold' | 'quote_pending' | 'pending' | 'done';
  priority: 'urgent' | 'high' | 'medium' | 'low';
  expected_completion_date?: string;
  notes?: string;
  doorloop_task_id?: string;
  doorloop_updated_at?: string | null;
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

export type ProspectStage = 'lead' | 'applied' | 'screening' | 'approved' | 'committed' | 'lease_signed' | 'moved_in';

export interface ProspectEntry {
  name: string;
  stage: ProspectStage;
  room?: string;
  target_room?: string;        // Timber's field name — same as room
  applied_date?: string;
  stage_updated?: string;
  last_contact_date?: string;
  expected_move_in?: string;
  move_in_date?: string;       // Timber's field name — same as expected_move_in
  no_reply?: boolean;
  source?: string;
  ghl_conv_id?: string;
  dl_tenant_id?: string;
  doorloop_tenant_id?: string;
  notes?: string;
  phone?: string;
  email?: string;
  contact?: { email?: string; phone?: string };
}

export interface CollectionNote {
  date: string;
  method: 'text' | 'call' | 'email' | 'in-person';
  contact: string;
  room: string;
  note: string;
  outcome: 'pending' | 'paid' | 'partial' | 'no-response' | 'promise-to-pay';
  amount_discussed?: number;
}

export interface RoomRosterEntry {
  room: string;
  tenant: string | null;
  lease_expiration?: string;
  payment_status: 'current' | 'late' | 'delinquent' | 'vacant' | 'eviction' | string;
  amount_due: number | null;
  last_payment?: { date: string; amount: number } | null;
  eviction_status?: string;
  notes?: string;
  collection_notes?: CollectionNote[];
  move_out_planned?: boolean;
  move_out_date?: string;
  expected_move_in?: string;
  flag?: string | null;
}

export interface UtilityTracker {
  provider?: string;
  account_holder?: string;
  monthly_est?: number;
  status: 'current' | 'unknown' | 'overdue';
}

export interface OutreachEntry {
  timestamp: string;
  platform: 'ghl' | 'imessage' | 'call' | 'other';
  to: string;
  phone?: string;
  property?: string;
  room?: string;
  message_preview?: string;
  direction: 'outbound' | 'inbound';
}

export interface OccupancyOutreachLog {
  date: string;
  type: 'text' | 'listing' | 'facebook' | 'call' | 'showing' | 'other';
  detail: string;
}

export interface Property {
  id: string;
  name: string;
  city: string;
  state: string;
  owner: string;
  entity: string;
  client_scope?: string;
  manager?: string;
  manager_email?: string;
  type: string;
  lender?: string;
  room_roster?: RoomRosterEntry[];
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
  insurance?: { renewal_date: string; carrier?: string; amount?: number };
  taxes?: { due_date: string; amount?: number; status?: string };
  utilities?: {
    electric?: UtilityTracker;
    water?: UtilityTracker;
    gas?: UtilityTracker;
    trash?: UtilityTracker;
  };
  hoa?: { name?: string; monthly_fee?: number; status: 'not_applicable' | 'current' | 'overdue' | 'unknown' };
  recent_outreach?: OutreachEntry[];
  occupancy_outreach?: { vacant_rooms: number; outreach_log?: OccupancyOutreachLog[] };
  prospect_pipeline?: ProspectEntry[];
  status_updates?: { from: string; text: string; at: string; }[];
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
    const data = JSON.parse(raw);
    // Skip files that aren't property records (e.g. prospect lists, config files)
    if (!data.id || !data.name || !data.city || !Array.isArray(data.units)) return null;
    // Normalize missing arrays so the UI never crashes on .map()/.filter()
    data.needs = Array.isArray(data.needs) ? data.needs : [];
    data.balances_owed = Array.isArray(data.balances_owed) ? data.balances_owed : [];
    data.past_orders = Array.isArray(data.past_orders) ? data.past_orders : [];
    data.quotes = Array.isArray(data.quotes) ? data.quotes : [];
    return data as Property;
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

export function getPropertiesByClientToken(token: string): Property[] {
  const all = getProperties();
  return all.filter((p) => p.client_scope === token);
}
