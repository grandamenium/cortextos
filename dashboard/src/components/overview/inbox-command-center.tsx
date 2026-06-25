'use client';

import { useState } from 'react';
import {
  IconMail, IconBolt, IconTag, IconInbox, IconWand,
  IconBookmark, IconChevronDown, IconChevronRight,
  IconSend, IconX, IconCheck, IconLoader2,
} from '@tabler/icons-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import type { InboxItem } from '@/lib/data/inbox';

const CATEGORY_COLORS: Record<string, string> = {
  Deals:              'text-yellow-600 dark:text-yellow-400',
  'Property-Alerts':  'text-blue-600 dark:text-blue-400',
  Lenders:            'text-purple-600 dark:text-purple-400',
  Tenants:            'text-green-600 dark:text-green-400',
  Banking:            'text-emerald-600 dark:text-emerald-400',
  Invoices:           'text-orange-600 dark:text-orange-400',
  Bills:              'text-orange-600 dark:text-orange-400',
  Legal:              'text-red-600 dark:text-red-400',
  'Legal-Filing':     'text-red-600 dark:text-red-400',
  Meetings:           'text-cyan-600 dark:text-cyan-400',
};

const QUICK_RULES = [
  'Route to Scout (deal flow)',
  'Route to Argus (research needed)',
  'Flag for my approval',
  'CC Tammy on all replies',
  'CC Ashley on all replies',
  'Auto-archive (not important)',
  'Treat as high priority',
  'Always include TIS one-pager',
];

function senderName(from: string): string {
  return from.replace(/<[^>]+>/, '').replace(/"/g, '').trim() || from.split('@')[0];
}

function senderEmail(from: string): string {
  return (from.match(/<([^>]+)>/) || [])[1] || from;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

interface TeachModalProps {
  item: InboxItem;
  onSave: (rule: { triggerType: string; triggerValue: string; action: string; note: string }) => void;
  onClose: () => void;
}

function TeachModal({ item, onSave, onClose }: TeachModalProps) {
  const [triggerType, setTriggerType] = useState<'sender' | 'category'>('sender');
  const [customAction, setCustomAction] = useState('');
  const [selectedQuick, setSelectedQuick] = useState('');
  const [saving, setSaving] = useState(false);

  const triggerValue = triggerType === 'sender' ? senderEmail(item.from) : (item.category || '');

  async function handleSave() {
    const action = selectedQuick || customAction.trim();
    if (!action) return;
    setSaving(true);
    await onSave({ triggerType, triggerValue, action, note: `Set from inbox: ${item.subject}` });
    setSaving(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-2xl border bg-card shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <div className="flex items-center gap-2 font-medium">
            <IconBookmark size={16} className="text-primary" />
            Teach a rule
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}><IconX size={16} /></Button>
        </div>
        <div className="px-5 py-4 space-y-4">
          <div>
            <p className="text-xs text-muted-foreground mb-2">When I get an email from:</p>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant={triggerType === 'sender' ? 'secondary' : 'outline'}
                onClick={() => setTriggerType('sender')}
                className="text-xs"
              >
                {senderName(item.from)}
              </Button>
              {item.category && (
                <Button
                  size="sm"
                  variant={triggerType === 'category' ? 'secondary' : 'outline'}
                  onClick={() => setTriggerType('category')}
                  className="text-xs"
                >
                  Any {item.category} email
                </Button>
              )}
            </div>
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-2">Do this:</p>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {QUICK_RULES.map((r) => (
                <button
                  key={r}
                  onClick={() => { setSelectedQuick(r === selectedQuick ? '' : r); setCustomAction(''); }}
                  className={`text-xs rounded-full border px-2.5 py-1 transition-colors ${
                    selectedQuick === r
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'hover:bg-muted/50'
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
            <textarea
              placeholder="Or write your own rule in plain English…"
              className="w-full rounded-lg border bg-muted/30 px-3 py-2 text-sm resize-none h-16 focus:outline-none focus:ring-2 focus:ring-primary/40"
              value={customAction}
              onChange={(e) => { setCustomAction(e.target.value); setSelectedQuick(''); }}
            />
          </div>
        </div>
        <div className="flex justify-end gap-2 px-5 pb-4">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button
            size="sm"
            disabled={(!selectedQuick && !customAction.trim()) || saving}
            onClick={handleSave}
          >
            {saving ? <IconLoader2 size={14} className="animate-spin mr-1" /> : <IconCheck size={14} className="mr-1" />}
            Save rule
          </Button>
        </div>
      </div>
    </div>
  );
}

interface DraftPanelProps {
  item: InboxItem;
  onClose: () => void;
}

function DraftPanel({ item, onClose }: DraftPanelProps) {
  const [draft, setDraft] = useState('');
  const [instruction, setInstruction] = useState('');
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  async function generateDraft() {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/inbox/draft-reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: item.from,
          subject: item.subject,
          snippet: item.snippet,
          account: item.account,
          instruction: instruction.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (data.draft) setDraft(data.draft);
      else setError(data.error || 'Draft generation failed');
    } catch {
      setError('Network error — try again');
    } finally {
      setLoading(false);
    }
  }

  async function copyToClipboard() {
    await navigator.clipboard.writeText(draft);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="mt-3 rounded-lg border bg-muted/20 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium flex items-center gap-1.5">
          <IconWand size={13} className="text-primary" />
          AI Draft Reply
        </span>
        <Button variant="ghost" size="icon" className="h-5 w-5" onClick={onClose}>
          <IconX size={12} />
        </Button>
      </div>
      <input
        placeholder="Optional instruction (e.g. 'be warmer', 'ask for a call')"
        className="w-full rounded-md border bg-background px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary/40"
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && !loading && generateDraft()}
      />
      {!draft && !loading && (
        <Button size="sm" className="w-full text-xs" onClick={generateDraft}>
          <IconWand size={13} className="mr-1" />
          Generate draft
        </Button>
      )}
      {loading && (
        <div className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
          <IconLoader2 size={16} className="animate-spin" />
          Drafting…
        </div>
      )}
      {error && <p className="text-xs text-red-500">{error}</p>}
      {draft && (
        <>
          <textarea
            className="w-full rounded-md border bg-background px-3 py-2 text-sm resize-none h-32 focus:outline-none focus:ring-1 focus:ring-primary/40"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="flex gap-2">
            <Button size="sm" variant="outline" className="flex-1 text-xs" onClick={generateDraft} disabled={loading}>
              Regenerate
            </Button>
            <Button size="sm" className="flex-1 text-xs" onClick={copyToClipboard}>
              {copied ? <><IconCheck size={13} className="mr-1" />Copied!</> : <><IconSend size={13} className="mr-1" />Copy & send</>}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground text-center">Review before sending — open Gmail to paste and send.</p>
        </>
      )}
    </div>
  );
}

export function InboxCommandCenter({ items }: { items: InboxItem[] }) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const [draftOpen, setDraftOpen] = useState<number | null>(null);
  const [teachOpen, setTeachOpen] = useState<InboxItem | null>(null);
  const [savedRule, setSavedRule] = useState<string | null>(null);

  async function saveRule(rule: { triggerType: string; triggerValue: string; action: string; note: string }) {
    await fetch('/api/inbox/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rule),
    });
    setTeachOpen(null);
    setSavedRule(`Rule saved: "${rule.action}" for ${rule.triggerType === 'sender' ? rule.triggerValue : rule.triggerValue + ' emails'}`);
    setTimeout(() => setSavedRule(null), 4000);
  }

  return (
    <>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium uppercase tracking-wider text-muted-foreground">
            <IconMail size={14} />
            Priority Inbox
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {savedRule && (
            <div className="mx-4 mb-2 flex items-center gap-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400">
              <IconCheck size={13} />
              {savedRule}
            </div>
          )}
          {items.length === 0 ? (
            <div className="flex items-center gap-2 text-muted-foreground px-6 py-4 text-sm">
              <IconInbox size={16} />
              <span>No flagged emails — inbox is clear</span>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {items.map((item, i) => {
                const catColor = item.category ? (CATEGORY_COLORS[item.category] ?? 'text-muted-foreground') : '';
                const isOpen = expanded === i;
                const isDraftOpen = draftOpen === i;
                return (
                  <div key={i} className={`px-4 py-3 transition-colors ${isOpen ? 'bg-muted/30' : 'hover:bg-muted/20'}`}>
                    {/* Header row */}
                    <div
                      className="flex items-start justify-between gap-2 cursor-pointer"
                      onClick={() => setExpanded(isOpen ? null : i)}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-xs font-medium text-muted-foreground shrink-0">{item.account}</span>
                          {item.isDeal && <IconBolt size={12} className="text-yellow-500 shrink-0" />}
                          {item.category && (
                            <span className={`text-xs ${catColor} flex items-center gap-0.5`}>
                              <IconTag size={10} />{item.category}
                            </span>
                          )}
                        </div>
                        <p className="text-sm font-medium truncate mt-0.5">{item.subject}</p>
                        <p className="text-xs text-muted-foreground truncate">
                          {senderName(item.from)}
                          {!isOpen && item.snippet ? ` — ${item.snippet.slice(0, 70)}` : ''}
                        </p>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <span className="text-xs text-muted-foreground">{relativeTime(item.flaggedAt)}</span>
                        {isOpen ? <IconChevronDown size={14} className="text-muted-foreground" /> : <IconChevronRight size={14} className="text-muted-foreground" />}
                      </div>
                    </div>

                    {/* Expanded content */}
                    {isOpen && (
                      <div className="mt-2 space-y-2">
                        {item.snippet && (
                          <p className="text-xs text-muted-foreground leading-relaxed bg-muted/30 rounded-md px-3 py-2">
                            {item.snippet}
                          </p>
                        )}
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            className="text-xs gap-1"
                            onClick={() => setDraftOpen(isDraftOpen ? null : i)}
                          >
                            <IconWand size={13} />
                            Draft reply
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="text-xs gap-1"
                            onClick={() => setTeachOpen(item)}
                          >
                            <IconBookmark size={13} />
                            Teach
                          </Button>
                        </div>
                        {isDraftOpen && (
                          <DraftPanel item={item} onClose={() => setDraftOpen(null)} />
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {teachOpen && (
        <TeachModal
          item={teachOpen}
          onSave={saveRule}
          onClose={() => setTeachOpen(null)}
        />
      )}
    </>
  );
}
