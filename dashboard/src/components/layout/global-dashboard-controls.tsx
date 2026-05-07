'use client';

import { useEffect, useState } from 'react';
import { CommandPalette } from '@/components/layout/command-palette';
import { KeyboardShortcutsDialog } from '@/components/layout/keyboard-shortcuts-dialog';
import { SettingsDialog } from '@/components/settings/settings-dialog';
import { initDashboardSettings } from '@/lib/dashboard-settings';

export function GlobalDashboardControls() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => {
    initDashboardSettings();
    function openSettings() {
      setSettingsOpen(true);
    }
    window.addEventListener('cortextos:open-settings', openSettings);
    return () => window.removeEventListener('cortextos:open-settings', openSettings);
  }, []);

  return (
    <>
      <CommandPalette onOpenSettings={() => setSettingsOpen(true)} />
      <KeyboardShortcutsDialog />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </>
  );
}
