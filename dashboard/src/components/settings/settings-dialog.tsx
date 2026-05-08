'use client';

import { useEffect, useState } from 'react';
import { IconSettings } from '@tabler/icons-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { THEMES, updateDashboardSettings, useDashboardSettings, type DashboardTheme } from '@/lib/dashboard-settings';

export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const settings = useDashboardSettings();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key === ',') {
        event.preventDefault();
        onOpenChange(true);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><IconSettings size={18} /> Settings</DialogTitle>
        </DialogHeader>
        <div className="grid gap-5 py-2">
          <section className="grid gap-2">
            <Label>Theme</Label>
            <Select value={settings.theme} onValueChange={(value) => updateDashboardSettings({ theme: value as DashboardTheme })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {THEMES.map((theme) => <SelectItem key={theme.id} value={theme.id}>{theme.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </section>

          <section className="grid gap-3">
            <Label>Editor</Label>
            <div className="rounded-md border p-3">
              <div className="mb-3 flex items-center justify-between gap-3">
                <span className="text-sm">Font size</span>
                <span className="text-sm text-muted-foreground">{settings.editorFontSize}px</span>
              </div>
              <Slider value={[settings.editorFontSize]} min={11} max={22} step={1} onValueChange={(value) => {
                const next = Array.isArray(value) ? value[0] : value;
                updateDashboardSettings({ editorFontSize: Number(next) });
              }} />
              <div className="mt-4 grid gap-3">
                <SettingSwitch label="Word wrap" checked={settings.wordWrap} onCheckedChange={(wordWrap) => updateDashboardSettings({ wordWrap })} />
                <SettingSwitch label="Minimap" checked={settings.minimap} onCheckedChange={(minimap) => updateDashboardSettings({ minimap })} />
              </div>
            </div>
          </section>

          <section className="grid gap-3">
            <Label>Notifications</Label>
            <SettingSwitch label="Desktop notifications" checked={settings.notifications} onCheckedChange={(notifications) => updateDashboardSettings({ notifications })} />
          </section>

          <section className="grid gap-3">
            <Label>Usage threshold</Label>
            <div className="rounded-md border p-3">
              <div className="mb-3 flex items-center justify-between gap-3 text-sm">
                <span>Context warning</span>
                <span className="text-muted-foreground">{settings.usageThreshold}%</span>
              </div>
              <Slider value={[settings.usageThreshold]} min={50} max={95} step={5} onValueChange={(value) => {
                const next = Array.isArray(value) ? value[0] : value;
                updateDashboardSettings({ usageThreshold: Number(next) });
              }} />
            </div>
          </section>

          <section className="grid gap-3">
            <Label>Smart suggestions</Label>
            <SettingSwitch label="Show contextual suggestions" checked={settings.smartSuggestions} onCheckedChange={(smartSuggestions) => updateDashboardSettings({ smartSuggestions })} />
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SettingSwitch({ label, checked, onCheckedChange }: { label: string; checked: boolean; onCheckedChange: (checked: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm">{label}</span>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}

export function useSettingsDialogState() {
  return useState(false);
}
