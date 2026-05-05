'use client';

/**
 * CronForm — reusable create/edit form for CronDefinition records.
 *
 * Props:
 *   mode          - 'create' or 'edit'
 *   initialValues - Pre-populated values for edit mode
 *   agents        - List of enabled agent names (for the agent Select)
 *   onSuccess     - Called after a successful submit; the parent should
 *                   refresh data and close any containing dialog/drawer.
 */

import { useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { IconRefresh, IconCheck } from '@tabler/icons-react';
import {
  isValidScheduleClient,
  isValidCronName,
  scheduleExamples,
  formatSchedule,
} from '@/lib/cron-utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CronFormValues {
  agent: string;
  name: string;
  schedule: string;
  prompt: string;
  enabled: boolean;
  description?: string;
  /** When true, the Test Fire button is disabled and the IPC handler refuses manual fires. */
  manualFireDisabled?: boolean;
}

export interface CronFormProps {
  mode: 'create' | 'edit';
  initialValues?: Partial<CronFormValues>;
  agents: string[];
  onSuccess: () => void;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

interface FieldErrors {
  agent?: string;
  name?: string;
  schedule?: string;
  prompt?: string;
}

function validate(values: CronFormValues): FieldErrors {
  const errors: FieldErrors = {};

  if (!values.agent || !values.agent.trim()) {
    errors.agent = 'Agent is required.';
  }
  if (!isValidCronName(values.name)) {
    errors.name = 'Name must be non-empty (letters, digits, _ and - only, no spaces).';
  }
  if (!isValidScheduleClient(values.schedule)) {
    errors.schedule = 'Enter a valid interval (e.g. "6h", "30m") or cron expression (e.g. "0 9 * * *").';
  }
  if (!values.prompt || !values.prompt.trim()) {
    errors.prompt = 'Prompt is required.';
  }

  return errors;
}

// ---------------------------------------------------------------------------
// CronForm component
// ---------------------------------------------------------------------------

export default function CronForm({
  mode,
  initialValues,
  agents,
  onSuccess,
}: CronFormProps) {
  const [values, setValues] = useState<CronFormValues>({
    agent: initialValues?.agent ?? (agents[0] ?? ''),
    name: initialValues?.name ?? '',
    schedule: initialValues?.schedule ?? '6h',
    prompt: initialValues?.prompt ?? '',
    enabled: initialValues?.enabled ?? true,
    description: initialValues?.description ?? '',
    manualFireDisabled: initialValues?.manualFireDisabled ?? false,
  });

  const [touched, setTouched] = useState<Partial<Record<keyof CronFormValues, boolean>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const errors = validate(values);
  const isValid = Object.keys(errors).length === 0;

  const markTouched = useCallback((field: keyof CronFormValues) => {
    setTouched(prev => ({ ...prev, [field]: true }));
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Mark all fields touched so errors show
    setTouched({ agent: true, name: true, schedule: true, prompt: true });
    if (!isValid) return;

    setSubmitting(true);
    setServerError(null);

    try {
      let res: Response;

      if (mode === 'create') {
        res = await fetch('/api/workflows/crons', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agent: values.agent,
            definition: {
              name: values.name,
              schedule: values.schedule.trim(),
              prompt: values.prompt.trim(),
              enabled: values.enabled,
              ...(values.description?.trim() ? { description: values.description.trim() } : {}),
              ...(values.manualFireDisabled ? { manualFireDisabled: true } : {}),
            },
          }),
        });
      } else {
        // edit mode — PATCH the existing cron
        const patch: Record<string, unknown> = {
          schedule: values.schedule.trim(),
          prompt: values.prompt.trim(),
          enabled: values.enabled,
          manualFireDisabled: values.manualFireDisabled ?? false,
        };
        if (values.description !== undefined) {
          patch.description = values.description.trim() || undefined;
        }
        res = await fetch(
          `/api/workflows/crons/${encodeURIComponent(values.agent)}/${encodeURIComponent(values.name)}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ patch }),
          },
        );
      }

      if (res.ok) {
        onSuccess();
        return;
      }

      const data = await res.json().catch(() => ({}));
      setServerError(data.error ?? 'An error occurred. Please try again.');
    } catch (err) {
      setServerError(err instanceof Error ? err.message : 'Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const exampleSchedules = scheduleExamples();
  const isEdit = mode === 'edit';

  return (
    <form onSubmit={handleSubmit} className="space-y-5" noValidate>
      {/* Agent select — disabled in edit mode */}
      <div className="space-y-1.5">
        <Label htmlFor="cron-agent">
          Agent <span className="text-destructive">*</span>
        </Label>
        {isEdit ? (
          <Input
            id="cron-agent"
            value={values.agent}
            disabled
            className="bg-muted cursor-not-allowed"
            aria-label="Agent (read-only in edit mode)"
          />
        ) : (
          <Select
            value={values.agent}
            onValueChange={v => {
              setValues(prev => ({ ...prev, agent: v ?? '' }));
              markTouched('agent');
            }}
            disabled={isEdit}
          >
            <SelectTrigger id="cron-agent" className={touched.agent && errors.agent ? 'border-destructive' : ''}>
              <SelectValue placeholder="Select agent..." />
            </SelectTrigger>
            <SelectContent>
              {agents.map(a => (
                <SelectItem key={a} value={a}>
                  {a}
                </SelectItem>
              ))}
              {agents.length === 0 && (
                <SelectItem value="" disabled>
                  No enabled agents found
                </SelectItem>
              )}
            </SelectContent>
          </Select>
        )}
        {touched.agent && errors.agent && (
          <p className="text-xs text-destructive">{errors.agent}</p>
        )}
      </div>

      {/* Cron name — disabled in edit mode */}
      <div className="space-y-1.5">
        <Label htmlFor="cron-name">
          Name <span className="text-destructive">*</span>
        </Label>
        <Input
          id="cron-name"
          value={values.name}
          onChange={e => {
            const v = e.target.value.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '');
            setValues(prev => ({ ...prev, name: v }));
          }}
          onBlur={() => markTouched('name')}
          disabled={isEdit}
          placeholder="e.g. heartbeat, daily-report"
          className={[
            touched.name && errors.name ? 'border-destructive' : '',
            isEdit ? 'bg-muted cursor-not-allowed' : '',
          ].filter(Boolean).join(' ')}
          aria-invalid={!!(touched.name && errors.name)}
          aria-describedby={touched.name && errors.name ? 'cron-name-error' : undefined}
        />
        {touched.name && errors.name && (
          <p id="cron-name-error" className="text-xs text-destructive">{errors.name}</p>
        )}
        {isEdit && (
          <p className="text-xs text-muted-foreground">Name cannot be changed after creation.</p>
        )}
      </div>

      {/* Schedule */}
      <div className="space-y-1.5">
        <Label htmlFor="cron-schedule">
          Schedule <span className="text-destructive">*</span>
        </Label>
        <Input
          id="cron-schedule"
          value={values.schedule}
          onChange={e => setValues(prev => ({ ...prev, schedule: e.target.value }))}
          onBlur={() => markTouched('schedule')}
          placeholder="e.g. 6h, 30m, 0 9 * * *"
          className={touched.schedule && errors.schedule ? 'border-destructive' : ''}
          aria-invalid={!!(touched.schedule && errors.schedule)}
          aria-describedby={
            touched.schedule && errors.schedule ? 'cron-schedule-error' : 'cron-schedule-hint'
          }
        />
        {touched.schedule && errors.schedule ? (
          <p id="cron-schedule-error" className="text-xs text-destructive">{errors.schedule}</p>
        ) : (
          <>
            {values.schedule && isValidScheduleClient(values.schedule) && (
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <IconCheck size={12} className="text-green-500 shrink-0" />
                {formatSchedule(values.schedule)}
              </p>
            )}
            <div
              id="cron-schedule-hint"
              className="mt-1.5 rounded-md bg-muted/40 border border-muted px-3 py-2 text-xs text-muted-foreground"
            >
              <p className="font-medium mb-1">Examples:</p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
                {exampleSchedules.map(ex => (
                  <button
                    key={ex.value}
                    type="button"
                    className="text-left hover:text-foreground transition-colors"
                    onClick={() => setValues(prev => ({ ...prev, schedule: ex.value }))}
                  >
                    <span className="font-mono text-foreground/80">{ex.value}</span>
                    {' — '}
                    {ex.label}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Prompt */}
      <div className="space-y-1.5">
        <Label htmlFor="cron-prompt">
          Prompt <span className="text-destructive">*</span>
        </Label>
        <Textarea
          id="cron-prompt"
          value={values.prompt}
          onChange={e => setValues(prev => ({ ...prev, prompt: e.target.value }))}
          onBlur={() => markTouched('prompt')}
          placeholder="The prompt injected into the agent when this cron fires..."
          rows={4}
          className={`resize-none ${touched.prompt && errors.prompt ? 'border-destructive' : ''}`}
          aria-invalid={!!(touched.prompt && errors.prompt)}
          aria-describedby={touched.prompt && errors.prompt ? 'cron-prompt-error' : undefined}
        />
        {touched.prompt && errors.prompt && (
          <p id="cron-prompt-error" className="text-xs text-destructive">{errors.prompt}</p>
        )}
        <p className="text-xs text-muted-foreground">
          The daemon injects{' '}
          <span className="font-mono bg-muted px-1 rounded">
            [CRON: {values.name || 'name'}]
          </span>{' '}
          before the prompt automatically.
        </p>
      </div>

      {/* Description (optional) */}
      <div className="space-y-1.5">
        <Label htmlFor="cron-description">Description <span className="text-muted-foreground">(optional)</span></Label>
        <Input
          id="cron-description"
          value={values.description ?? ''}
          onChange={e => setValues(prev => ({ ...prev, description: e.target.value }))}
          placeholder="Human-readable note shown in the dashboard"
        />
      </div>

      {/* Enabled toggle */}
      <div className="flex items-center justify-between rounded-md border px-3 py-2.5">
        <div>
          <p className="text-sm font-medium">Enabled</p>
          <p className="text-xs text-muted-foreground">
            Disabled crons are stored but not executed by the scheduler.
          </p>
        </div>
        <Switch
          checked={values.enabled}
          onCheckedChange={v => setValues(prev => ({ ...prev, enabled: v }))}
          aria-label="Enable cron"
        />
      </div>

      {/* Disable manual fire toggle */}
      <div className="flex items-center justify-between rounded-md border px-3 py-2.5">
        <div>
          <p className="text-sm font-medium">Disable manual fire</p>
          <p className="text-xs text-muted-foreground">
            When enabled, the Test Fire button is hidden and manual IPC triggers are refused.
            Use for crons with strict scheduling contracts or destructive operations.
          </p>
        </div>
        <Switch
          checked={values.manualFireDisabled ?? false}
          onCheckedChange={v => setValues(prev => ({ ...prev, manualFireDisabled: v }))}
          aria-label="Disable manual fire"
          data-testid="manual-fire-disabled-toggle"
        />
      </div>

      {/* Server error banner */}
      {serverError && (
        <div className="rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2 text-sm text-destructive">
          {serverError}
        </div>
      )}

      {/* Submit */}
      <div className="flex items-center justify-between pt-1">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {values.schedule && isValidScheduleClient(values.schedule) && (
            <Badge variant="outline" className="font-mono text-[10px]">
              {values.schedule}
            </Badge>
          )}
        </div>
        <Button
          type="submit"
          disabled={submitting || !isValid}
          className="min-w-[100px]"
        >
          {submitting ? (
            <>
              <IconRefresh size={14} className="mr-1.5 animate-spin" />
              Saving...
            </>
          ) : mode === 'create' ? (
            'Create Cron'
          ) : (
            'Save Changes'
          )}
        </Button>
      </div>
    </form>
  );
}
