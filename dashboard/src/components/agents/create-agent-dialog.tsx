'use client';

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { IconLoader2 } from '@tabler/icons-react';

interface CreateAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: () => void;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

const TEMPLATES = [
  {
    value: 'agent',
    label: 'Agent (Claude)',
    runtime: 'claude-code',
    description: 'General-purpose worker on the Claude-Code runtime. Default. Skills under .claude/skills/, slash-commands available.',
  },
  {
    value: 'agent-codex',
    label: 'Agent (Codex)',
    runtime: 'codex-app-server',
    description: 'General-purpose worker on the codex-app-server runtime (gpt-5-codex). Skills under plugins/cortextos-agent-skills/skills/, no slash-commands.',
  },
  {
    value: 'orchestrator',
    label: 'Orchestrator (Claude only)',
    runtime: 'claude-code',
    description: 'Coordinates the org — morning/evening reviews, goal cascade, approvals. Claude-Code runtime only.',
  },
  {
    value: 'analyst',
    label: 'Analyst (Claude only)',
    runtime: 'claude-code',
    description: 'System health, metrics, theta-wave autoresearch. Claude-Code runtime only.',
  },
] as const;

type Template = (typeof TEMPLATES)[number]['value'];

export function CreateAgentDialog({
  open,
  onOpenChange,
  onCreated,
}: CreateAgentDialogProps) {
  const [name, setName] = useState('');
  const [org, setOrg] = useState('agentnet');
  const [template, setTemplate] = useState<Template>('agent');
  const [botToken, setBotToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  function resetForm() {
    setName('');
    setOrg('agentnet');
    setTemplate('agent');
    setBotToken('');
    setChatId('');
    setError(null);
    setSuccess(false);
  }

  function handleOpenChange(next: boolean) {
    if (!next) resetForm();
    onOpenChange(next);
  }

  function validate(): string | null {
    if (!name.trim()) return 'Agent name is required.';
    if (!NAME_PATTERN.test(name))
      return 'Name must be lowercase alphanumeric, hyphens, or underscores (cannot start with - or _).';
    if (!org.trim()) return 'Organization is required.';
    if (!template) return 'Template is required.';
    if (!botToken.trim()) return 'Bot token is required.';
    if (!chatId.trim()) return 'Chat ID is required.';
    return null;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);

    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          org: org.trim(),
          template,
          botToken: botToken.trim(),
          chatId: chatId.trim(),
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `Failed to create agent (${res.status})`);
      }

      setSuccess(true);
      onCreated?.();

      // Auto-close after brief delay so user sees the success message
      setTimeout(() => handleOpenChange(false), 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create Agent</DialogTitle>
          <DialogDescription>
            Configure a new agent and add it to the fleet.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Agent Name */}
          <div className="grid gap-1.5">
            <Label htmlFor="agent-name">Agent Name</Label>
            <Input
              id="agent-name"
              placeholder="my-agent"
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              disabled={submitting}
              autoFocus
            />
          </div>

          {/* Organization */}
          <div className="grid gap-1.5">
            <Label htmlFor="agent-org">Organization</Label>
            <Input
              id="agent-org"
              placeholder="agentnet"
              value={org}
              onChange={(e) => setOrg(e.target.value)}
              disabled={submitting}
            />
          </div>

          {/* Template */}
          <div className="grid gap-1.5">
            <Label>Template</Label>
            <Select value={template} onValueChange={(v) => setTemplate(v as Template)}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select a template" />
              </SelectTrigger>
              <SelectContent>
                {TEMPLATES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {/* Runtime tooltip — shows what the selected template means
                so users picking between Claude / Codex agents understand
                the runtime + skill location implications before submit. */}
            <p className="text-xs text-muted-foreground">
              Runtime: <code className="text-xs">{TEMPLATES.find((t) => t.value === template)?.runtime ?? 'claude-code'}</code>.
              {' '}
              {TEMPLATES.find((t) => t.value === template)?.description}
            </p>
          </div>

          {/* Bot Token */}
          <div className="grid gap-1.5">
            <Label htmlFor="agent-bot-token">Bot Token</Label>
            <Input
              id="agent-bot-token"
              placeholder="123456:ABC-DEF..."
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              disabled={submitting}
            />
          </div>

          {/* Chat ID */}
          <div className="grid gap-1.5">
            <Label htmlFor="agent-chat-id">Chat ID</Label>
            <Input
              id="agent-chat-id"
              placeholder="-1001234567890"
              value={chatId}
              onChange={(e) => setChatId(e.target.value)}
              disabled={submitting}
            />
          </div>

          {/* Feedback */}
          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}
          {success && (
            <p className="text-sm text-green-600">Agent created!</p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting && <IconLoader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              Create Agent
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
