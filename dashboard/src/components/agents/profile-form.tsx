'use client';

import { useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { IconAlertTriangle, IconDeviceFloppy } from '@tabler/icons-react';
import type { IdentityFields, SoulFields } from '@/lib/types';

interface ProfileFormProps {
  agentName: string;
  org: string;
  identity: IdentityFields;
  soul: SoulFields;
  actionSlot?: HTMLElement | null;
}

export function ProfileForm({
  agentName,
  org,
  identity: initialIdentity,
  soul: initialSoul,
  actionSlot,
}: ProfileFormProps) {
  const [identity, setIdentity] = useState<IdentityFields>(initialIdentity);
  const [soul, setSoul] = useState<SoulFields>(initialSoul);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updateIdentity = useCallback(
    (key: string, value: string) => {
      setIdentity((prev) => ({ ...prev, [key]: value }));
      setSaved(false);
    },
    [],
  );

  const updateSoul = useCallback(
    (key: string, value: string) => {
      setSoul((prev) => ({ ...prev, [key]: value }));
      setSaved(false);
    },
    [],
  );

  const handleSave = async () => {
    setSaving(true);
    setError(null);

    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentName)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identity, soul, org }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? 'Failed to save');
      }

      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const saveButton = (
    <Button size="sm" onClick={handleSave} disabled={saving}>
      <IconDeviceFloppy size={16} data-icon="inline-start" />
      {saving ? 'Saving...' : 'Save Changes'}
    </Button>
  );

  return (
    <div className="space-y-6">
      {actionSlot && createPortal(saveButton, actionSlot)}
      {/* Warning banner after save */}
      {saved && (
        <div className="flex items-center gap-2 rounded-lg border border-warning/50 bg-warning/10 px-4 py-3 text-sm text-warning">
          <IconAlertTriangle size={16} />
          <span>
            Saved successfully. Changes will take effect the next time the agent
            restarts or reloads its configuration.
          </span>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <IconAlertTriangle size={16} />
          <span>{error}</span>
        </div>
      )}

      {/* IDENTITY.md fields */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
            Identity
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="identity-name">Name</Label>
              <Input
                id="identity-name"
                value={identity.name}
                onChange={(e) => updateIdentity('name', e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="identity-emoji">Emoji</Label>
              <Input
                id="identity-emoji"
                value={identity.emoji}
                onChange={(e) => updateIdentity('emoji', e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="identity-role">Role</Label>
            <Input
              id="identity-role"
              value={identity.role}
              onChange={(e) => updateIdentity('role', e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="identity-vibe">Vibe</Label>
            <Textarea
              id="identity-vibe"
              value={identity.vibe}
              onChange={(e) => updateIdentity('vibe', e.target.value)}
              rows={2}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="identity-workstyle">Work Style</Label>
            <Textarea
              id="identity-workstyle"
              value={identity.workStyle}
              onChange={(e) => updateIdentity('workStyle', e.target.value)}
              rows={2}
            />
          </div>
        </CardContent>
      </Card>

      {/* SOUL.md fields */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
            Soul
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="soul-autonomy">Autonomy Rules</Label>
            <Textarea
              id="soul-autonomy"
              value={soul.autonomyRules}
              onChange={(e) => updateSoul('autonomyRules', e.target.value)}
              rows={3}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="soul-communication">Communication Style</Label>
            <Textarea
              id="soul-communication"
              value={soul.communicationStyle}
              onChange={(e) =>
                updateSoul('communicationStyle', e.target.value)
              }
              rows={3}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="soul-daymode">Day Mode</Label>
              <Textarea
                id="soul-daymode"
                value={soul.dayMode}
                onChange={(e) => updateSoul('dayMode', e.target.value)}
                rows={2}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="soul-nightmode">Night Mode</Label>
              <Textarea
                id="soul-nightmode"
                value={soul.nightMode}
                onChange={(e) => updateSoul('nightMode', e.target.value)}
                rows={2}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="soul-coretruths">Core Truths</Label>
            <Textarea
              id="soul-coretruths"
              value={soul.coreTruths}
              onChange={(e) => updateSoul('coreTruths', e.target.value)}
              rows={3}
            />
          </div>
        </CardContent>
      </Card>

    </div>
  );
}
