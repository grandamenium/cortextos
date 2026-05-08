'use client';

import { useSyncExternalStore } from 'react';

export type DashboardTheme =
  | 'claude-official'
  | 'claude-official-light'
  | 'claude-classic'
  | 'claude-classic-light'
  | 'slate'
  | 'slate-light'
  | 'mono'
  | 'mono-light';

export type DashboardSettings = {
  theme: DashboardTheme;
  editorFontSize: number;
  wordWrap: boolean;
  minimap: boolean;
  notifications: boolean;
  usageThreshold: number;
  smartSuggestions: boolean;
};

const STORAGE_KEY = 'cortextos-dashboard-settings';

export const THEMES: Array<{ id: DashboardTheme; label: string; mode: 'dark' | 'light' }> = [
  { id: 'claude-official', label: 'Claude Official', mode: 'dark' },
  { id: 'claude-official-light', label: 'Claude Official Light', mode: 'light' },
  { id: 'claude-classic', label: 'Claude Classic', mode: 'dark' },
  { id: 'claude-classic-light', label: 'Classic Light', mode: 'light' },
  { id: 'slate', label: 'Slate', mode: 'dark' },
  { id: 'slate-light', label: 'Slate Light', mode: 'light' },
  { id: 'mono', label: 'Mono', mode: 'dark' },
  { id: 'mono-light', label: 'Mono Light', mode: 'light' },
];

const DEFAULT_SETTINGS: DashboardSettings = {
  theme: 'claude-official',
  editorFontSize: 14,
  wordWrap: true,
  minimap: false,
  notifications: true,
  usageThreshold: 80,
  smartSuggestions: true,
};

let snapshot = DEFAULT_SETTINGS;
const listeners = new Set<() => void>();

function isTheme(value: unknown): value is DashboardTheme {
  return typeof value === 'string' && THEMES.some((theme) => theme.id === value);
}

function normalize(value: unknown): DashboardSettings {
  if (!value || typeof value !== 'object') return DEFAULT_SETTINGS;
  const record = value as Partial<DashboardSettings>;
  return {
    theme: isTheme(record.theme) ? record.theme : DEFAULT_SETTINGS.theme,
    editorFontSize: typeof record.editorFontSize === 'number' ? record.editorFontSize : DEFAULT_SETTINGS.editorFontSize,
    wordWrap: typeof record.wordWrap === 'boolean' ? record.wordWrap : DEFAULT_SETTINGS.wordWrap,
    minimap: typeof record.minimap === 'boolean' ? record.minimap : DEFAULT_SETTINGS.minimap,
    notifications: typeof record.notifications === 'boolean' ? record.notifications : DEFAULT_SETTINGS.notifications,
    usageThreshold: typeof record.usageThreshold === 'number' ? record.usageThreshold : DEFAULT_SETTINGS.usageThreshold,
    smartSuggestions: typeof record.smartSuggestions === 'boolean' ? record.smartSuggestions : DEFAULT_SETTINGS.smartSuggestions,
  };
}

function applyTheme(theme: DashboardTheme) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const meta = THEMES.find((item) => item.id === theme) ?? THEMES[0];
  root.setAttribute('data-theme', theme);
  root.classList.toggle('dark', meta.mode === 'dark');
  root.style.colorScheme = meta.mode;
}

function emit(next: DashboardSettings) {
  snapshot = next;
  applyTheme(next.theme);
  if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  listeners.forEach((listener) => listener());
}

export function initDashboardSettings() {
  if (typeof localStorage === 'undefined') return;
  try {
    snapshot = normalize(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'));
  } catch {
    snapshot = DEFAULT_SETTINGS;
  }
  applyTheme(snapshot.theme);
}

export function updateDashboardSettings(patch: Partial<DashboardSettings>) {
  emit(normalize({ ...snapshot, ...patch }));
}

export function useDashboardSettings() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
    () => DEFAULT_SETTINGS,
  );
}
