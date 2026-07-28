'use client';

/**
 * CronsTab — per-agent cron editor.
 *
 * Backed by /api/workflows/crons, which reads the daemon's crons.json and
 * mutates it through IPC (the daemon owns the write, the lock, and the
 * scheduler reload).
 *
 * This tab previously talked to /api/agents/[name]/crons, which reads and
 * writes config.json.  The daemon migrates config.json crons to crons.json
 * exactly once (guarded by a .crons-migrated marker) and never reads
 * config.json again — so that endpoint showed a stale fossil and silently
 * discarded every edit.
 *
 * Mutations are per-cron (POST / PATCH / DELETE), not a whole-list PUT.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  IconPlus,
  IconTrash,
  IconClock,
  IconPencil,
  IconRefresh,
} from '@tabler/icons-react';
import {
  isValidScheduleClient,
  isValidCronName,
  scheduleExamples,
  formatSchedule,
  formatRelative,
} from '@/lib/cron-utils';

// ---------------------------------------------------------------------------
// Types — mirror the CronSummaryRow contract from /api/workflows/crons
// ---------------------------------------------------------------------------

interface CronDefinition {
  name: string;
  prompt: string;
  /** Interval shorthand ("4h") **or** a 5-field cron expression ("0 8 * * *"). */
  schedule: string;
  enabled: boolean;
  created_at?: string;
  last_fired_at?: string;
  fire_count?: number;
  description?: string;
}

interface CronSummaryRow {
  agent: string;
  org: string;
  cron: CronDefinition;
  lastFire: string | null;
  lastStatus: 'fired' | 'retried' | 'failed' | null;
  nextFire: string;
}

interface Draft {
  name: string;
  schedule: string;
  prompt: string;
  enabled: boolean;
}

interface CronsTabProps {
  agentName: string;
}

const NEW_CRON = '__new__';

const emptyDraft = (): Draft => ({
  name: '',
  schedule: '6h',
  prompt: '',
  enabled: true,
});

function draftErrors(draft: Draft, isNew: boolean): Partial<Record<keyof Draft, string>> {
  const errors: Partial<Record<keyof Draft, string>> = {};
  if (isNew && !isValidCronName(draft.name)) {
    errors.name = 'Letters, digits, _ and - only. No spaces.';
  }
  if (!isValidScheduleClient(draft.schedule)) {
    errors.schedule = 'Use an interval (e.g. 6h, 30m) or a cron expression (e.g. 0 9 * * *).';
  }
  if (!draft.prompt.trim()) {
    errors.prompt = 'Prompt is required.';
  }
  return errors;
}

// ---------------------------------------------------------------------------

export function CronsTab({ agentName }: CronsTabProps) {
  const [rows, setRows] = useState<CronSummaryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  /** Cron name currently being edited, or NEW_CRON for the create form. */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch(
        `/api/workflows/crons?agent=${encodeURIComponent(agentName)}`,
      );
      if (!res.ok) throw new Error(`Failed to load crons (${res.status})`);
      const data = await res.json();
      // GET /api/workflows/crons returns a bare array of CronSummaryRow.
      setRows(Array.isArray(data) ? data : []);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load crons');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [agentName]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  const startCreate = () => {
    setEditing(NEW_CRON);
    setDraft(emptyDraft());
    setFormError(null);
    setMessage(null);
  };

  const startEdit = (cron: CronDefinition) => {
    setEditing(cron.name);
    setDraft({
      name: cron.name,
      schedule: cron.schedule,
      prompt: cron.prompt,
      enabled: cron.enabled,
    });
    setFormError(null);
    setMessage(null);
  };

  const cancelEdit = () => {
    setEditing(null);
    setFormError(null);
  };

  const submit = async () => {
    const isNew = editing === NEW_CRON;
    if (Object.keys(draftErrors(draft, isNew)).length > 0) return;

    setSubmitting(true);
    setFormError(null);
    try {
      let res: Response;
      if (isNew) {
        res = await fetch('/api/workflows/crons', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agent: agentName,
            definition: {
              name: draft.name,
              schedule: draft.schedule.trim(),
              prompt: draft.prompt.trim(),
              enabled: draft.enabled,
            },
          }),
        });
      } else {
        res = await fetch(
          `/api/workflows/crons/${encodeURIComponent(agentName)}/${encodeURIComponent(draft.name)}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              patch: {
                schedule: draft.schedule.trim(),
                prompt: draft.prompt.trim(),
                enabled: draft.enabled,
              },
            }),
          },
        );
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setFormError(data.error ?? `Request failed (${res.status})`);
        return;
      }

      setEditing(null);
      setMessage({
        type: 'success',
        text: isNew
          ? `Created "${draft.name}". The daemon has reloaded its schedule.`
          : `Saved "${draft.name}". The daemon has reloaded its schedule.`,
      });
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setSubmitting(false);
    }
  };

  const remove = async (name: string) => {
    if (!window.confirm(`Delete cron "${name}"? This cannot be undone.`)) return;
    setDeleting(name);
    setMessage(null);
    try {
      const res = await fetch(
        `/api/workflows/crons/${encodeURIComponent(agentName)}/${encodeURIComponent(name)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setMessage({ type: 'error', text: data.error ?? `Failed to delete (${res.status})` });
        return;
      }
      if (editing === name) setEditing(null);
      setMessage({ type: 'success', text: `Deleted "${name}".` });
      await load();
    } catch (err) {
      setMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Network error',
      });
    } finally {
      setDeleting(null);
    }
  };

  if (loading) {
    return <div className="p-6 text-muted-foreground">Loading crons...</div>;
  }

  const errors = draftErrors(draft, editing === NEW_CRON);
  const canSubmit = Object.keys(errors).length === 0 && !submitting;

  return (
    <div className="space-y-4 p-1">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <IconClock size={18} className="text-muted-foreground" />
          <h3 className="text-sm font-medium">Scheduled Crons ({rows.length})</h3>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => load()}
            className="inline-flex items-center gap-1 rounded-md bg-secondary px-3 py-1.5 text-xs font-medium hover:bg-secondary/80"
          >
            <IconRefresh size={14} />
            Refresh
          </button>
          <button
            onClick={startCreate}
            disabled={editing === NEW_CRON}
            className="inline-flex items-center gap-1 rounded-md bg-secondary px-3 py-1.5 text-xs font-medium hover:bg-secondary/80 disabled:opacity-50"
          >
            <IconPlus size={14} />
            Add Cron
          </button>
        </div>
      </div>

      {loadError && (
        <div className="rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-500">
          {loadError}
        </div>
      )}

      {message && (
        <div
          className={`rounded-md px-3 py-2 text-xs ${
            message.type === 'success'
              ? 'bg-green-500/10 text-green-500'
              : 'bg-red-500/10 text-red-500'
          }`}
        >
          {message.text}
        </div>
      )}

      {editing === NEW_CRON && (
        <CronEditor
          draft={draft}
          setDraft={setDraft}
          errors={errors}
          isNew
          submitting={submitting}
          canSubmit={canSubmit}
          formError={formError}
          onSubmit={submit}
          onCancel={cancelEdit}
        />
      )}

      {rows.length === 0 && editing !== NEW_CRON ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          No crons scheduled. Click &quot;Add Cron&quot; to create one.
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map(row =>
            editing === row.cron.name ? (
              <CronEditor
                key={row.cron.name}
                draft={draft}
                setDraft={setDraft}
                errors={errors}
                isNew={false}
                submitting={submitting}
                canSubmit={canSubmit}
                formError={formError}
                onSubmit={submit}
                onCancel={cancelEdit}
              />
            ) : (
              <div key={row.cron.name} className="rounded-lg border bg-card p-4 space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{row.cron.name}</span>
                      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                        {row.cron.schedule}
                      </span>
                      {!row.cron.enabled && (
                        <span className="rounded bg-yellow-500/10 px-1.5 py-0.5 text-[10px] text-yellow-600">
                          disabled
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {formatSchedule(row.cron.schedule)}
                      {' · last fired '}
                      {row.lastFire ? formatRelative(row.lastFire) : 'never'}
                      {row.lastStatus === 'failed' && (
                        <span className="text-red-500"> (failed)</span>
                      )}
                      {' · next '}
                      {row.cron.enabled ? formatRelative(row.nextFire) : 'not scheduled'}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      onClick={() => startEdit(row.cron)}
                      className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
                      title={`Edit ${row.cron.name}`}
                      aria-label={`Edit ${row.cron.name}`}
                    >
                      <IconPencil size={14} />
                    </button>
                    <button
                      onClick={() => remove(row.cron.name)}
                      disabled={deleting === row.cron.name}
                      className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                      title={`Remove ${row.cron.name}`}
                      aria-label={`Remove ${row.cron.name}`}
                    >
                      <IconTrash size={14} />
                    </button>
                  </div>
                </div>
                <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
                  {row.cron.prompt}
                </p>
              </div>
            ),
          )}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Crons are stored in the daemon&apos;s <span className="font-mono">crons.json</span> and edited
        through the daemon, which reloads its scheduler immediately — no agent restart needed.
        Schedule accepts an interval (<span className="font-mono">30m</span>,{' '}
        <span className="font-mono">6h</span>, <span className="font-mono">1d</span>) or a 5-field cron
        expression (<span className="font-mono">0 9 * * *</span>).
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editor form — shared by create and edit
// ---------------------------------------------------------------------------

interface CronEditorProps {
  draft: Draft;
  setDraft: React.Dispatch<React.SetStateAction<Draft>>;
  errors: Partial<Record<keyof Draft, string>>;
  isNew: boolean;
  submitting: boolean;
  canSubmit: boolean;
  formError: string | null;
  onSubmit: () => void;
  onCancel: () => void;
}

function CronEditor({
  draft,
  setDraft,
  errors,
  isNew,
  submitting,
  canSubmit,
  formError,
  onSubmit,
  onCancel,
}: CronEditorProps) {
  const inputClass =
    'mt-1 block w-full rounded-md border bg-background px-3 py-1.5 text-sm focus:border-primary focus:outline-none';

  return (
    <div className="space-y-3 rounded-lg border border-primary/40 bg-card p-4">
      <div className="grid grid-cols-[1fr_160px] gap-3">
        <div>
          <label className="text-xs text-muted-foreground" htmlFor="cron-name">
            Name
          </label>
          <input
            id="cron-name"
            type="text"
            value={draft.name}
            disabled={!isNew}
            onChange={e =>
              setDraft(prev => ({
                ...prev,
                name: e.target.value.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, ''),
              }))
            }
            placeholder="heartbeat"
            className={`${inputClass} ${!isNew ? 'cursor-not-allowed bg-muted' : ''}`}
          />
          {isNew && errors.name && (
            <span className="text-[10px] text-red-500">{errors.name}</span>
          )}
          {!isNew && (
            <span className="text-[10px] text-muted-foreground">
              Name cannot be changed after creation.
            </span>
          )}
        </div>
        <div>
          <label className="text-xs text-muted-foreground" htmlFor="cron-schedule">
            Schedule
          </label>
          <input
            id="cron-schedule"
            type="text"
            value={draft.schedule}
            onChange={e => setDraft(prev => ({ ...prev, schedule: e.target.value }))}
            placeholder="4h or 0 8 * * *"
            className={inputClass}
          />
          <span
            className={`text-[10px] ${errors.schedule ? 'text-red-500' : 'text-muted-foreground'}`}
          >
            {errors.schedule ?? formatSchedule(draft.schedule)}
          </span>
        </div>
      </div>

      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {scheduleExamples().map(ex => (
          <button
            key={ex.value}
            type="button"
            onClick={() => setDraft(prev => ({ ...prev, schedule: ex.value }))}
            className="text-[10px] text-muted-foreground hover:text-foreground"
            title={ex.label}
          >
            <span className="font-mono">{ex.value}</span>
          </button>
        ))}
      </div>

      <div>
        <label className="text-xs text-muted-foreground" htmlFor="cron-prompt">
          Prompt
        </label>
        <textarea
          id="cron-prompt"
          value={draft.prompt}
          onChange={e => setDraft(prev => ({ ...prev, prompt: e.target.value }))}
          placeholder="What the agent should do when this cron fires..."
          rows={3}
          className={`${inputClass} resize-y`}
        />
        {errors.prompt && <span className="text-[10px] text-red-500">{errors.prompt}</span>}
      </div>

      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={e => setDraft(prev => ({ ...prev, enabled: e.target.checked }))}
        />
        Enabled (disabled crons are stored but never fired)
      </label>

      {formError && (
        <div className="rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-500">{formError}</div>
      )}

      <div className="flex items-center justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-secondary"
        >
          Cancel
        </button>
        <button
          onClick={onSubmit}
          disabled={!canSubmit}
          className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {submitting ? 'Saving...' : isNew ? 'Create Cron' : 'Save Changes'}
        </button>
      </div>
    </div>
  );
}
