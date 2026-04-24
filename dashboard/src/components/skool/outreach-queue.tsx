'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { OutreachRow } from '@/lib/data/skool';
import { renderOutreachBody } from '@/lib/data/skool';

// Change this default if you want a different test-handle than james-goldbach.
const TEST_REDIRECT_HANDLE = 'james-goldbach';

function fmtWhen(iso: string) {
  const d = new Date(iso);
  const absolute = d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const ms = d.getTime() - Date.now();
  const abs = Math.abs(ms);
  const min = Math.floor(abs / 60000);
  let rel = '';
  if (min < 60) rel = `${min}m`;
  else if (min < 1440) rel = `${Math.floor(min / 60)}h`;
  else rel = `${Math.floor(min / 1440)}d`;
  rel = ms < 0 ? `${rel} ago` : `in ${rel}`;
  return { absolute, rel };
}

function statusBadge(s: OutreachRow['status']) {
  const map: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
    scheduled: { label: 'scheduled', variant: 'secondary' },
    ready: { label: 'ready to send', variant: 'default' },
    sent: { label: 'sent', variant: 'outline' },
    skipped: { label: 'skipped', variant: 'outline' },
    failed: { label: 'failed', variant: 'destructive' },
    responded: { label: 'responded', variant: 'default' },
    no_response: { label: 'no response', variant: 'outline' },
  };
  const meta = map[s] || { label: s, variant: 'secondary' as const };
  return <Badge variant={meta.variant} className="text-[11px]">{meta.label}</Badge>;
}

// ---- Detail modal ----
function DetailModal({
  row,
  onClose,
  onAfterSend,
}: {
  row: OutreachRow;
  onClose: () => void;
  onAfterSend: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState(false);
  // Default OFF: Skool blocks self-DM (no Message button on your own profile),
  // so test-redirect to your own handle always fails. The modal body preview
  // above is the real verification. Leave the checkbox for future test accounts.
  const [testMode, setTestMode] = useState(false);
  const [resultMsg, setResultMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null);

  async function refreshCopy() {
    setRefreshing(true);
    setRefreshMsg(null);
    try {
      const res = await fetch(`/api/crm/outreach/${row.id}/refresh-copy`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `status ${res.status}`);
      if (data.updated) {
        setRefreshMsg('Copy refreshed — reload the page to see the new body.');
        start(() => router.refresh());
      } else {
        setRefreshMsg('No template found for this sequence/step. Edit one in /crm-templates first.');
      }
    } catch (e) {
      setRefreshMsg(e instanceof Error ? e.message : 'refresh failed');
    } finally {
      setRefreshing(false);
    }
  }

  const body = renderOutreachBody(row);
  const copy = (row.payload as { copy?: { body?: string } } | null)?.copy;
  const formSlug = (row.payload as { form_slug?: string } | null)?.form_slug;
  const when = fmtWhen(row.scheduled_for);

  async function confirmSend() {
    setBusy(true);
    setError(null);
    setResultMsg(null);
    try {
      const res = await fetch(`/api/crm/outreach/${row.id}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(testMode ? { test_handle: TEST_REDIRECT_HANDLE } : {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `status ${res.status}`);
      const outcome = data.results?.[0]?.outcome || 'sent';
      const to = data.results?.[0]?.sent_to || (testMode ? TEST_REDIRECT_HANDLE : row.member_handle);
      setResultMsg(`${outcome} → @${to}`);
      start(() => {
        router.refresh();
        onAfterSend();
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'send failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60"
      data-testid="outreach-modal"
      onClick={onClose}
    >
      <div
        className="bg-card border rounded-lg shadow-lg w-full max-w-2xl max-h-[85vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Outreach detail</h2>
            <p className="text-xs text-muted-foreground mt-1">
              Review the exact message that will be sent. You can test-redirect to your own Skool handle before sending to the real recipient.
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} data-testid="outreach-modal-close">✕</Button>
        </div>

        <div className="p-5 space-y-4 text-sm">
          <div className="grid grid-cols-2 gap-3">
            <div><span className="text-muted-foreground text-xs block">Recipient</span>
              <div className="font-medium">{row.member_name || '—'}</div>
              <div className="text-[11px] text-muted-foreground">@{row.member_handle}</div>
            </div>
            <div><span className="text-muted-foreground text-xs block">Status</span>{statusBadge(row.status)}</div>
            <div><span className="text-muted-foreground text-xs block">Sequence</span>{row.sequence_slug}</div>
            <div><span className="text-muted-foreground text-xs block">Step / channel</span>{row.step} · {row.channel}</div>
            <div className="col-span-2"><span className="text-muted-foreground text-xs block">Scheduled for</span>{when.absolute} ({when.rel})</div>
            {formSlug && (
              <div className="col-span-2"><span className="text-muted-foreground text-xs block">Form delivery</span>
                <code className="text-xs">{formSlug}</code>
              </div>
            )}
          </div>

          <div>
            <span className="text-muted-foreground text-xs block mb-1">Message body ([Name] substituted)</span>
            {body ? (
              <pre
                className="whitespace-pre-wrap bg-muted/30 border rounded p-3 text-[13px] leading-relaxed font-sans"
                data-testid="outreach-body-preview"
              >{body}</pre>
            ) : (
              <div className="border border-destructive/40 bg-destructive/10 p-3 rounded text-xs text-destructive">
                No copy.body in this row&apos;s payload. Live send would be skipped.
              </div>
            )}
            {copy && 'copy_engaged' in copy && (
              <p className="text-[11px] text-muted-foreground mt-1">
                (This step has an engaged-variant alternate available in payload.copy.copy_engaged — not used by current sender.)
              </p>
            )}
          </div>

          {row.status === 'ready' && (
            <div className="rounded border bg-muted/20 p-3 space-y-2">
              <label className="flex items-start gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={testMode}
                  onChange={(e) => setTestMode(e.target.checked)}
                  data-testid="outreach-modal-testmode"
                  className="mt-0.5"
                />
                <div>
                  <div className="font-medium">Test redirect — send to <code>@{TEST_REDIRECT_HANDLE}</code> instead of <code>@{row.member_handle}</code></div>
                  <div className="text-[11px] text-muted-foreground">For routing to a secondary Skool account. Do NOT use your own handle — Skool blocks self-DM.</div>
                </div>
              </label>
            </div>
          )}

          {resultMsg && (
            <div className="rounded border border-green-500/30 bg-green-500/10 p-3 text-sm" data-testid="outreach-result">
              ✓ {resultMsg}
            </div>
          )}
          {error && (
            <div className="rounded border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive" data-testid="outreach-send-error">
              {error}
            </div>
          )}
        </div>

        <div className="p-5 border-t flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {(row.status === 'scheduled' || row.status === 'ready') && (
              <Button
                variant="outline"
                size="sm"
                onClick={refreshCopy}
                disabled={refreshing}
                data-testid="outreach-refresh-copy"
              >
                {refreshing ? 'Refreshing…' : 'Refresh copy'}
              </Button>
            )}
            {refreshMsg && <span className="text-xs text-muted-foreground" data-testid="refresh-msg">{refreshMsg}</span>}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={onClose}>Close</Button>
            {row.status === 'ready' && !resultMsg && (
              <Button
                onClick={confirmSend}
                disabled={busy || pending || !body}
                data-testid="outreach-modal-confirm"
                className={testMode ? '' : 'bg-red-600 hover:bg-red-700 text-white'}
              >
                {busy ? 'Sending…' : testMode ? 'Send test to yourself' : 'SEND TO REAL MEMBER'}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function OutreachQueue({ rows }: { rows: OutreachRow[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detailRow, setDetailRow] = useState<OutreachRow | null>(null);

  async function execute(id: string) {
    setBusyId(id);
    setError(null);
    try {
      const r = await fetch(`/api/crm/outreach/${id}/ready`, { method: 'POST' });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error || `status ${r.status}`);
      }
      start(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to execute');
    } finally {
      setBusyId(null);
    }
  }

  const counts = rows.reduce(
    (acc, r) => {
      if (r.status === 'scheduled') acc.scheduled++;
      else if (r.status === 'ready') acc.ready++;
      return acc;
    },
    { scheduled: 0, ready: 0 },
  );

  return (
    <>
      <Card data-testid="outreach-queue">
        <CardHeader>
          <CardTitle>
            CRM outreach queue
            {' '}
            <span className="text-sm font-normal text-muted-foreground">
              ({counts.scheduled} scheduled, {counts.ready} ready)
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {error && <p className="text-sm text-destructive mb-3" data-testid="outreach-error">{error}</p>}
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4" data-testid="outreach-empty">
              No outreach in queue. Either nothing triggered yet, or everything has been sent/responded.
            </p>
          ) : (
            <div className="overflow-x-auto" data-testid="outreach-table">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Member</TableHead>
                    <TableHead>Sequence</TableHead>
                    <TableHead>Step</TableHead>
                    <TableHead>Channel</TableHead>
                    <TableHead>Scheduled</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => {
                    const when = fmtWhen(r.scheduled_for);
                    const canExecute = r.status === 'scheduled' && !pending && busyId !== r.id;
                    return (
                      <TableRow key={r.id} data-testid="outreach-row" data-row-status={r.status}>
                        <TableCell>
                          <div className="font-medium">{r.member_name ?? '—'}</div>
                          <div className="text-[11px] text-muted-foreground">@{r.member_handle}</div>
                        </TableCell>
                        <TableCell className="text-xs">{r.sequence_slug}</TableCell>
                        <TableCell className="tabular-nums">{r.step}</TableCell>
                        <TableCell className="text-xs">{r.channel}</TableCell>
                        <TableCell className="text-xs">
                          <div>{when.absolute}</div>
                          <div className="text-muted-foreground">{when.rel}</div>
                        </TableCell>
                        <TableCell>{statusBadge(r.status)}</TableCell>
                        <TableCell className="text-right space-x-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setDetailRow(r)}
                            data-testid="outreach-detail"
                          >Detail</Button>
                          {r.status === 'scheduled' && (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={!canExecute}
                              onClick={() => execute(r.id)}
                              data-testid="outreach-execute"
                            >
                              {busyId === r.id ? '…' : 'Execute'}
                            </Button>
                          )}
                          {r.status === 'ready' && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setDetailRow(r)}
                              data-testid="outreach-send-now"
                            >Send now</Button>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {detailRow && (
        <DetailModal
          row={detailRow}
          onClose={() => setDetailRow(null)}
          onAfterSend={() => setDetailRow(null)}
        />
      )}
    </>
  );
}
