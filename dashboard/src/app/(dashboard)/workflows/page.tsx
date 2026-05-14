'use client';

import { useState, useEffect, useCallback, Fragment } from 'react';
import { useRouter } from 'next/navigation';
import { useOrg } from '@/hooks/use-org';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  IconClock,
  IconPlus,
  IconTrash,
  IconEdit,
  IconCheck,
  IconX,
  IconRefresh,
  IconChevronDown,
  IconChevronUp,
  IconRobot,
  IconHistory,
  IconSearch,
  IconFilter,
  IconExternalLink,
  IconCircleCheck,
  IconAlertTriangle,
  IconCircleX,
  IconCircleDashed,
  IconArrowRight,
} from '@tabler/icons-react';
import { formatRelative, formatSchedule } from '@/lib/cron-utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Cron {
  name: string;
  type?: 'recurring' | 'once';
  interval?: string;
  cron?: string;        // raw crontab expression (e.g. "0 9 * * *")
  fire_at?: string;     // ISO datetime for once-type crons
  prompt: string;
  /** External cron system fields */
  schedule?: string;
  enabled?: boolean;
  last_fired_at?: string;
  fire_count?: number;
  description?: string;
}

interface CronSummaryRow {
  agent: string;
  org: string;
  cron: Cron;
  lastFire: string | null;
  lastStatus: 'fired' | 'retried' | 'failed' | null;
  nextFire: string;
}

interface CronExecutionEntry {
  ts: string;
  cron: string;
  status: 'fired' | 'retried' | 'failed';
  attempt: number;
  duration_ms: number;
  error: string | null;
}

interface AgentCrons {
  name: string;
  org: string;
  crons: Cron[];
  loading: boolean;
  error: string | null;
}

// Fleet health summary shape (Subtask 4.4)
interface FleetHealthSummary {
  total: number;
  healthy: number;
  warning: number;
  failure: number;
  neverFired: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function intervalToHuman(interval: string | undefined): string {
  if (!interval) return '?';
  const match = interval.match(/^(\d+)([smhd])$/);
  if (!match) return interval;
  const n = parseInt(match[1]);
  const unit = match[2];
  const units: Record<string, string> = {
    s: n === 1 ? 'second' : 'seconds',
    m: n === 1 ? 'minute' : 'minutes',
    h: n === 1 ? 'hour' : 'hours',
    d: n === 1 ? 'day' : 'days',
  };
  return `${n} ${units[unit]}`;
}

function validateInterval(interval: string | undefined): boolean {
  if (!interval) return false;
  return /^\d+[smhd]$/.test(interval);
}

function validateName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name) && name.length > 0;
}

function slugifyName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '');
}

function statusBadgeVariant(
  status: 'fired' | 'retried' | 'failed' | null,
): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'fired') return 'default';
  if (status === 'failed') return 'destructive';
  if (status === 'retried') return 'secondary';
  return 'outline';
}

function statusLabel(status: 'fired' | 'retried' | 'failed' | null): string {
  if (status === 'fired') return 'success';
  if (status === 'failed') return 'failed';
  if (status === 'retried') return 'retried';
  return 'never';
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function WorkflowsPage() {
  const router = useRouter();
  const { currentOrg } = useOrg();

  // ── Fleet health summary (from /api/workflows/health) ─────────────────────
  const [fleetHealth, setFleetHealth] = useState<FleetHealthSummary | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);

  // ── Cron-status data (from /api/workflows/crons) ──────────────────────────
  const [cronRows, setCronRows] = useState<CronSummaryRow[]>([]);
  const [statusLoading, setStatusLoading] = useState(true);

  // ── Legacy per-agent cron config data (from /api/agents/[name]/crons) ─────
  const [agents, setAgents] = useState<AgentCrons[]>([]);
  const [loading, setLoading] = useState(true);

  // ── UI state ───────────────────────────────────────────────────────────────
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
  const [editingCron, setEditingCron] = useState<{ agent: string; index: number } | null>(null);
  const [addingTo, setAddingTo] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [agentFilter, setAgentFilter] = useState<string>('all');

  // ── Detail panel (executions) ─────────────────────────────────────────────
  const [selectedCron, setSelectedCron] = useState<{ agent: string; name: string } | null>(null);
  const [executions, setExecutions] = useState<CronExecutionEntry[]>([]);
  const [execLoading, setExecLoading] = useState(false);

  // New cron form state
  const [newCron, setNewCron] = useState<Cron>({ name: '', interval: '5m', prompt: '' });

  // Edit cron form state
  const [editCron, setEditCron] = useState<Cron>({ name: '', interval: '', prompt: '' });

  // ── Fetch fleet health summary ─────────────────────────────────────────────
  const fetchFleetHealth = useCallback(async () => {
    setHealthLoading(true);
    try {
      const res = await fetch('/api/workflows/health');
      if (res.ok) {
        const data = await res.json();
        if (data && typeof data.summary === 'object') {
          setFleetHealth(data.summary as FleetHealthSummary);
        }
      }
    } catch (err) {
      console.error('[workflows] Failed to fetch fleet health:', err);
    } finally {
      setHealthLoading(false);
    }
  }, []);

  // ── Fetch cron status rows (list-all-crons via API) ────────────────────────
  const fetchCronStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      const res = await fetch('/api/workflows/crons');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) setCronRows(data);
      }
    } catch (err) {
      console.error('[workflows] Failed to fetch cron status:', err);
    } finally {
      setStatusLoading(false);
    }
  }, []);

  // ── Fetch per-agent config crons (for CRUD) ────────────────────────────────
  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/agents');
      const agentList: { name: string; org: string }[] = await res.json();

      const results: AgentCrons[] = await Promise.all(
        agentList.map(async (agent) => {
          try {
            const cronRes = await fetch(`/api/agents/${encodeURIComponent(agent.name)}/crons`);
            const data = await cronRes.json();
            return {
              name: agent.name,
              org: agent.org,
              crons: data.crons ?? [],
              loading: false,
              error: null,
            };
          } catch {
            return {
              name: agent.name,
              org: agent.org,
              crons: [],
              loading: false,
              error: 'Failed to load crons',
            };
          }
        }),
      );

      // Sort: agents with crons first, then alphabetical
      results.sort((a, b) => {
        if (a.crons.length > 0 && b.crons.length === 0) return -1;
        if (a.crons.length === 0 && b.crons.length > 0) return 1;
        return a.name.localeCompare(b.name);
      });

      setAgents(results);
      if (results.length > 0 && !expandedAgent) {
        setExpandedAgent(results[0].name);
      }
    } catch (err) {
      console.error('Failed to fetch agents:', err);
    } finally {
      setLoading(false);
    }
  }, [expandedAgent]);

  // ── Fetch execution detail panel ──────────────────────────────────────────
  const fetchExecutions = useCallback(async (agentName: string, cronName: string) => {
    setExecLoading(true);
    try {
      const url = `/api/workflows/crons/${encodeURIComponent(agentName)}/executions?cronName=${encodeURIComponent(cronName)}&limit=10`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          setExecutions([...data].reverse()); // most recent first
        }
      }
    } catch (err) {
      console.error('[workflows] Failed to fetch executions:', err);
    } finally {
      setExecLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    fetchCronStatus();
    fetchFleetHealth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (selectedCron) {
      fetchExecutions(selectedCron.agent, selectedCron.name);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCron]);

  // ── CRUD operations ────────────────────────────────────────────────────────

  const saveCrons = async (agentName: string, crons: Cron[]) => {
    setSaving(agentName);
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentName)}/crons`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ crons }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to save');
      }
      setAgents((prev) =>
        prev.map((a) =>
          a.name === agentName ? { ...a, crons, error: null } : a,
        ),
      );
    } catch (err) {
      setAgents((prev) =>
        prev.map((a) =>
          a.name === agentName
            ? { ...a, error: err instanceof Error ? err.message : 'Save failed' }
            : a,
        ),
      );
    } finally {
      setSaving(null);
    }
  };

  const deleteCron = (agentName: string, index: number) => {
    const agent = agents.find((a) => a.name === agentName);
    if (!agent) return;
    const updated = agent.crons.filter((_, i) => i !== index);
    saveCrons(agentName, updated);
  };

  const addCron = (agentName: string) => {
    if (!validateName(newCron.name) || !validateInterval(newCron.interval) || !newCron.prompt.trim()) {
      return;
    }
    const agent = agents.find((a) => a.name === agentName);
    if (!agent) return;

    if (agent.crons.some((c) => c.name === newCron.name)) {
      setAgents((prev) =>
        prev.map((a) =>
          a.name === agentName ? { ...a, error: `Cron "${newCron.name}" already exists` } : a,
        ),
      );
      return;
    }

    const updated = [...agent.crons, { ...newCron }];
    saveCrons(agentName, updated);
    setNewCron({ name: '', interval: '5m', prompt: '' });
    setAddingTo(null);
  };

  const saveEdit = (agentName: string, index: number) => {
    if (!validateName(editCron.name) || !validateInterval(editCron.interval) || !editCron.prompt.trim()) {
      return;
    }
    const agent = agents.find((a) => a.name === agentName);
    if (!agent) return;

    if (agent.crons.some((c, i) => c.name === editCron.name && i !== index)) {
      setAgents((prev) =>
        prev.map((a) =>
          a.name === agentName ? { ...a, error: `Cron "${editCron.name}" already exists` } : a,
        ),
      );
      return;
    }

    const updated = agent.crons.map((c, i) => (i === index ? { ...editCron } : c));
    saveCrons(agentName, updated);
    setEditingCron(null);
  };

  // ── Derived data ──────────────────────────────────────────────────────────

  const displayedAgents = currentOrg === 'all'
    ? agents
    : agents.filter((a) => a.org === currentOrg);

  const totalCrons = displayedAgents.reduce((sum, a) => sum + a.crons.length, 0);

  // Build a lookup map: agent+cronName -> CronSummaryRow (for status display)
  const cronStatusMap = new Map<string, CronSummaryRow>();
  for (const row of cronRows) {
    cronStatusMap.set(`${row.agent}::${row.cron.name}`, row);
  }

  // Agent filter options
  const agentOptions = ['all', ...displayedAgents.map(a => a.name)];

  // Search + agent filter applied to the flat table view
  const filteredRows = cronRows.filter(row => {
    if (currentOrg !== 'all' && row.org !== currentOrg) return false;
    if (agentFilter !== 'all' && row.agent !== agentFilter) return false;
    if (searchQuery && !row.cron.name.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  });

  const handleRefresh = () => {
    fetchAll();
    fetchCronStatus();
    fetchFleetHealth();
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Workflows</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Scheduled crons across all agents
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={() => router.push('/workflows/new')}
          >
            <IconPlus size={14} className="mr-1" />
            New Cron
          </Button>
          <button
            onClick={handleRefresh}
            className="p-2 rounded-md hover:bg-muted transition-colors"
            title="Refresh"
          >
            <IconRefresh size={18} className={(loading || statusLoading) ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* ── Fleet Health Panel ─────────────────────────────────────────────────── */}
      <Card className={
        !healthLoading && fleetHealth &&
        (fleetHealth.failure > 0 || fleetHealth.neverFired > 0)
          ? 'border-red-500/30'
          : !healthLoading && fleetHealth && fleetHealth.warning > 0
            ? 'border-yellow-500/30'
            : ''
      }>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium">Fleet Health</CardTitle>
            <button
              onClick={() => router.push('/workflows/health')}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              View all
              <IconArrowRight size={12} />
            </button>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {healthLoading ? (
            <div className="grid grid-cols-4 gap-2">
              {[1, 2, 3, 4].map(i => (
                <div key={i} className="h-12 rounded-md bg-muted/30 animate-pulse" />
              ))}
            </div>
          ) : fleetHealth ? (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {/* Total */}
              <div className="text-center">
                <p className="text-2xl font-semibold">{fleetHealth.total}</p>
                <p className="text-xs text-muted-foreground mt-0.5">total</p>
              </div>
              {/* Healthy */}
              <div className="text-center">
                <p className={`text-2xl font-semibold flex items-center justify-center gap-1 ${fleetHealth.healthy > 0 ? 'text-green-600 dark:text-green-400' : ''}`}>
                  <IconCircleCheck size={16} className="shrink-0" />
                  {fleetHealth.healthy}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">healthy</p>
              </div>
              {/* Warning */}
              <div className="text-center">
                <p className={`text-2xl font-semibold flex items-center justify-center gap-1 ${fleetHealth.warning > 0 ? 'text-yellow-600 dark:text-yellow-400' : 'text-muted-foreground'}`}>
                  <IconAlertTriangle size={16} className="shrink-0" />
                  {fleetHealth.warning}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">warning</p>
              </div>
              {/* Failure + Never-fired */}
              <div className="text-center">
                <p className={`text-2xl font-semibold flex items-center justify-center gap-1 ${(fleetHealth.failure + fleetHealth.neverFired) > 0 ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground'}`}>
                  <IconCircleX size={16} className="shrink-0" />
                  {fleetHealth.failure + fleetHealth.neverFired}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  failed
                  {fleetHealth.neverFired > 0 && ` / ${fleetHealth.neverFired} new`}
                </p>
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground text-center py-2">
              Health data unavailable
            </p>
          )}
        </CardContent>
      </Card>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Total Crons</p>
            <p className="text-2xl font-semibold mt-1">
              {loading && agents.length === 0
                ? <span className="text-muted-foreground">-</span>
                : totalCrons}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Agents</p>
            <p className="text-2xl font-semibold mt-1">
              {loading && agents.length === 0 ? (
                <span className="text-muted-foreground">-</span>
              ) : (
                <>
                  {displayedAgents.filter((a) => a.crons.length > 0).length}
                  <span className="text-sm text-muted-foreground font-normal">
                    {' '}/ {displayedAgents.length}
                  </span>
                </>
              )}
            </p>
          </CardContent>
        </Card>
        <Card className="col-span-2 md:col-span-1">
          <CardContent className="pt-4 pb-3">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Most Active</p>
            <p className="text-2xl font-semibold mt-1 truncate">
              {loading && agents.length === 0
                ? <span className="text-muted-foreground">-</span>
                : displayedAgents.length > 0
                  ? displayedAgents.reduce((max, a) => (a.crons.length > max.crons.length ? a : max)).name
                  : '-'}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ── Read-only status table (list-all-crons view) ────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <CardTitle className="text-base">Cron Status</CardTitle>
            {/* Filter controls */}
            <div className="flex items-center gap-2 flex-wrap">
              {/* Search */}
              <div className="relative">
                <IconSearch
                  size={14}
                  className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
                />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder="Search crons..."
                  className="h-8 w-48 rounded-md border bg-background pl-8 pr-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                  aria-label="Search crons"
                />
              </div>
              {/* Agent filter */}
              <div className="relative">
                <IconFilter
                  size={14}
                  className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
                />
                <select
                  value={agentFilter}
                  onChange={e => setAgentFilter(e.target.value)}
                  className="h-8 rounded-md border bg-background pl-8 pr-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                  aria-label="Filter by agent"
                >
                  {agentOptions.map(opt => (
                    <option key={opt} value={opt}>
                      {opt === 'all' ? 'All agents' : opt}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {/* Table */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="pb-2 pr-4 font-medium text-muted-foreground text-xs uppercase tracking-wide">Agent</th>
                  <th className="pb-2 pr-4 font-medium text-muted-foreground text-xs uppercase tracking-wide">Cron</th>
                  <th className="pb-2 pr-4 font-medium text-muted-foreground text-xs uppercase tracking-wide hidden sm:table-cell">Schedule</th>
                  <th className="pb-2 pr-4 font-medium text-muted-foreground text-xs uppercase tracking-wide hidden md:table-cell">Next Fire</th>
                  <th className="pb-2 pr-4 font-medium text-muted-foreground text-xs uppercase tracking-wide hidden md:table-cell">Last Fire</th>
                  <th className="pb-2 font-medium text-muted-foreground text-xs uppercase tracking-wide">Status</th>
                </tr>
              </thead>
              <tbody>
                {statusLoading && filteredRows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-muted-foreground">
                      Loading...
                    </td>
                  </tr>
                ) : filteredRows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-muted-foreground">
                      {searchQuery || agentFilter !== 'all'
                        ? 'No crons match the current filters'
                        : 'No crons found'}
                    </td>
                  </tr>
                ) : (
                  filteredRows.map(row => {
                    const isSelected = selectedCron?.agent === row.agent && selectedCron?.name === row.cron.name;
                    return (
                      <Fragment key={`${row.agent}::${row.cron.name}`}>
                        <tr
                          className={`border-b last:border-0 cursor-pointer hover:bg-muted/50 transition-colors group ${isSelected ? 'bg-muted/70' : ''}`}
                          onClick={() => {
                            if (isSelected) {
                              setSelectedCron(null);
                            } else {
                              setSelectedCron({ agent: row.agent, name: row.cron.name });
                            }
                          }}
                        >
                          <td className="py-2.5 pr-4">
                            <span className="flex items-center gap-1.5">
                              <IconRobot size={13} className="text-muted-foreground shrink-0" />
                              <span className="font-medium">{row.agent}</span>
                            </span>
                          </td>
                          <td className="py-2.5 pr-4">
                            <div className="flex items-center gap-1.5">
                              <IconClock size={13} className="text-muted-foreground shrink-0" />
                              <span>{row.cron.name}</span>
                              <button
                                className="opacity-0 group-hover:opacity-100 transition-opacity ml-0.5 text-muted-foreground hover:text-foreground"
                                title="Open detail page"
                                onClick={e => {
                                  e.stopPropagation();
                                  router.push(`/workflows/${encodeURIComponent(row.agent)}/${encodeURIComponent(row.cron.name)}`);
                                }}
                              >
                                <IconExternalLink size={12} />
                              </button>
                            </div>
                            {row.cron.description && (
                              <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
                                {row.cron.description}
                              </p>
                            )}
                          </td>
                          <td className="py-2.5 pr-4 hidden sm:table-cell">
                            <Badge variant="outline" className="text-[10px] font-mono">
                              {formatSchedule(row.cron.schedule ?? '')}
                            </Badge>
                          </td>
                          <td className="py-2.5 pr-4 text-xs text-muted-foreground hidden md:table-cell">
                            {formatRelative(row.nextFire)}
                          </td>
                          <td className="py-2.5 pr-4 text-xs text-muted-foreground hidden md:table-cell">
                            {formatRelative(row.lastFire)}
                          </td>
                          <td className="py-2.5">
                            <Badge
                              variant={statusBadgeVariant(row.lastStatus)}
                              className="text-[10px]"
                            >
                              {statusLabel(row.lastStatus)}
                            </Badge>
                          </td>
                        </tr>

                        {/* Execution detail panel — inline expanded row */}
                        {isSelected && (
                          <tr key={`${row.agent}::${row.cron.name}::detail`}>
                            <td colSpan={6} className="pb-3 pt-0">
                              <div className="rounded-md bg-muted/40 border border-muted px-4 py-3">
                                <div className="flex items-center justify-between mb-2">
                                  <p className="text-xs font-medium flex items-center gap-1.5">
                                    <IconHistory size={13} />
                                    Recent executions — {row.cron.name}
                                  </p>
                                  <button
                                    className="text-xs text-muted-foreground hover:text-foreground"
                                    onClick={e => { e.stopPropagation(); setSelectedCron(null); }}
                                  >
                                    <IconX size={13} />
                                  </button>
                                </div>
                                {execLoading ? (
                                  <p className="text-xs text-muted-foreground py-2">Loading...</p>
                                ) : executions.length === 0 ? (
                                  <p className="text-xs text-muted-foreground py-2">No execution history found.</p>
                                ) : (
                                  <div className="space-y-1">
                                    {executions.map((entry, i) => (
                                      <div key={i} className="flex items-center gap-3 text-xs">
                                        <Badge
                                          variant={statusBadgeVariant(entry.status)}
                                          className="text-[10px] shrink-0"
                                        >
                                          {entry.status}
                                        </Badge>
                                        <span className="text-muted-foreground shrink-0">
                                          {formatRelative(entry.ts)}
                                        </span>
                                        <span className="text-muted-foreground shrink-0">
                                          {entry.duration_ms}ms
                                        </span>
                                        {entry.error && (
                                          <span className="text-destructive truncate">
                                            {entry.error}
                                          </span>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
          {filteredRows.length > 0 && (
            <p className="text-xs text-muted-foreground mt-3">
              {filteredRows.length} cron{filteredRows.length !== 1 ? 's' : ''} shown
              {(searchQuery || agentFilter !== 'all') ? ' (filtered)' : ''}
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── Per-agent CRUD accordion (edit/add/delete) ──────────────────────── */}
      <div>
        <h2 className="text-base font-semibold mb-3">Manage Crons</h2>

        {/* Loading skeleton */}
        {loading && agents.length === 0 && (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-24 rounded-lg bg-muted/30 animate-pulse" />
            ))}
          </div>
        )}

        {/* Agent accordion sections */}
        {displayedAgents.map((agent) => {
          const isExpanded = expandedAgent === agent.name;
          const isSaving = saving === agent.name;

          return (
            <Card key={agent.name} className="mb-3">
              <button
                className="w-full text-left"
                onClick={() => setExpandedAgent(isExpanded ? null : agent.name)}
              >
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <IconRobot size={18} className="text-muted-foreground" />
                      <CardTitle className="text-base">{agent.name}</CardTitle>
                      <span className="text-xs text-muted-foreground">{agent.org}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <Badge variant="secondary" className="text-[11px]">
                        {agent.crons.length} cron{agent.crons.length !== 1 ? 's' : ''}
                      </Badge>
                      {isExpanded ? <IconChevronUp size={16} /> : <IconChevronDown size={16} />}
                    </div>
                  </div>
                </CardHeader>
              </button>

              {isExpanded && (
                <CardContent className="pt-0 space-y-3">
                  {/* Error banner */}
                  {agent.error && (
                    <div className="rounded-md bg-red-500/10 border border-red-500/20 px-3 py-2 text-sm text-red-600 dark:text-red-400 flex items-center justify-between">
                      <span>{agent.error}</span>
                      <button
                        onClick={() =>
                          setAgents((prev) =>
                            prev.map((a) => (a.name === agent.name ? { ...a, error: null } : a)),
                          )
                        }
                      >
                        <IconX size={14} />
                      </button>
                    </div>
                  )}

                  {/* Cron list */}
                  {agent.crons.length === 0 && addingTo !== agent.name && (
                    <p className="text-sm text-muted-foreground text-center py-4">
                      No crons configured
                    </p>
                  )}

                  {agent.crons.map((cron, idx) => {
                    const isEditing =
                      editingCron?.agent === agent.name && editingCron?.index === idx;
                    const statusRow = cronStatusMap.get(`${agent.name}::${cron.name}`);

                    if (isEditing) {
                      return (
                        <div
                          key={`edit-${cron.name}`}
                          className="rounded-md border border-primary/30 px-3 py-3 space-y-2"
                        >
                          <div className="flex gap-2">
                            <Input
                              value={editCron.name}
                              onChange={(e) => setEditCron({ ...editCron, name: slugifyName(e.target.value) })}
                              placeholder="cron-name"
                              className="flex-1 h-8 text-sm"
                            />
                            <Input
                              value={editCron.interval}
                              onChange={(e) =>
                                setEditCron({ ...editCron, interval: e.target.value })
                              }
                              placeholder="e.g. 5m, 2h"
                              className="w-24 h-8 text-sm"
                            />
                          </div>
                          <Textarea
                            value={editCron.prompt}
                            onChange={(e) => setEditCron({ ...editCron, prompt: e.target.value })}
                            placeholder="Prompt..."
                            className="text-sm min-h-[60px]"
                          />
                          <div className="flex justify-end gap-2">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setEditingCron(null)}
                            >
                              Cancel
                            </Button>
                            <Button
                              size="sm"
                              onClick={() => saveEdit(agent.name, idx)}
                              disabled={
                                !validateName(editCron.name) ||
                                !validateInterval(editCron.interval) ||
                                !editCron.prompt.trim()
                              }
                            >
                              <IconCheck size={14} className="mr-1" />
                              Save
                            </Button>
                          </div>
                        </div>
                      );
                    }

                    return (
                      <div
                        key={cron.name}
                        className="rounded-md border px-3 py-2.5 group hover:border-foreground/20 transition-colors"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <IconClock size={14} className="text-muted-foreground shrink-0" />
                              <span className="text-sm font-medium">{cron.name}</span>
                              <Badge variant="outline" className="text-[10px]">
                                {cron.fire_at
                                  ? `once at ${new Date(cron.fire_at).toLocaleString()}`
                                  : cron.cron
                                    ? `cron: ${cron.cron}`
                                    : `every ${intervalToHuman(cron.interval)}`}
                              </Badge>
                              {/* Runtime status from external cron system */}
                              {statusRow && (
                                <Badge
                                  variant={statusBadgeVariant(statusRow.lastStatus)}
                                  className="text-[10px]"
                                >
                                  {statusLabel(statusRow.lastStatus)}
                                </Badge>
                              )}
                              {statusRow && (
                                <span className="text-[11px] text-muted-foreground">
                                  next: {formatRelative(statusRow.nextFire)}
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                              {cron.prompt}
                            </p>
                          </div>
                          <div className="flex items-center gap-1 md:opacity-0 md:group-hover:opacity-100 transition-opacity shrink-0">
                            <button
                              className="p-1.5 rounded hover:bg-muted"
                              title="Open detail / edit page"
                              onClick={(e) => {
                                e.stopPropagation();
                                router.push(`/workflows/${encodeURIComponent(agent.name)}/${encodeURIComponent(cron.name)}`);
                              }}
                            >
                              <IconExternalLink size={16} />
                            </button>
                            <button
                              className="p-1.5 rounded hover:bg-muted"
                              title="Edit (inline)"
                              onClick={(e) => {
                                e.stopPropagation();
                                setEditCron({ ...cron });
                                setEditingCron({ agent: agent.name, index: idx });
                              }}
                            >
                              <IconEdit size={16} />
                            </button>
                            <button
                              className="p-1.5 rounded hover:bg-red-500/10 text-red-500"
                              title="Delete"
                              onClick={(e) => {
                                e.stopPropagation();
                                deleteCron(agent.name, idx);
                              }}
                            >
                              <IconTrash size={16} />
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}

                  {/* Add cron form — inline or navigate to /workflows/new */}
                  {addingTo === agent.name ? (
                    <div className="rounded-md border border-dashed border-primary/30 px-3 py-3 space-y-2">
                      <div className="flex gap-2">
                        <Input
                          value={newCron.name}
                          onChange={(e) => setNewCron({ ...newCron, name: slugifyName(e.target.value) })}
                          placeholder="cron-name (e.g. daily-report)"
                          className="flex-1 h-8 text-sm"
                          autoFocus
                        />
                        <Input
                          value={newCron.interval}
                          onChange={(e) => setNewCron({ ...newCron, interval: e.target.value })}
                          placeholder="e.g. 5m, 2h, 1d"
                          className="w-28 h-8 text-sm"
                        />
                      </div>
                      <Textarea
                        value={newCron.prompt}
                        onChange={(e) => setNewCron({ ...newCron, prompt: e.target.value })}
                        placeholder="Prompt that runs on each interval..."
                        className="text-sm min-h-[60px]"
                      />
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setAddingTo(null);
                            setNewCron({ name: '', interval: '5m', prompt: '' });
                          }}
                        >
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => addCron(agent.name)}
                          disabled={
                            !validateName(newCron.name) ||
                            !validateInterval(newCron.interval) ||
                            !newCron.prompt.trim() ||
                            isSaving
                          }
                        >
                          {isSaving ? (
                            <IconRefresh size={14} className="mr-1 animate-spin" />
                          ) : (
                            <IconPlus size={14} className="mr-1" />
                          )}
                          Add Cron
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full border-dashed"
                      onClick={() => {
                        setAddingTo(agent.name);
                        setNewCron({ name: '', interval: '5m', prompt: '' });
                      }}
                    >
                      <IconPlus size={14} className="mr-1" />
                      Add Cron
                    </Button>
                  )}
                </CardContent>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
