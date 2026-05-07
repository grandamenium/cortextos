'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { IconMessagePlus, IconRobot, IconSearch, IconSettings, IconSparkles } from '@tabler/icons-react';
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command';

type Agent = { name: string; org?: string };

export function CommandPalette({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [open, setOpen] = useState(false);
  const [agents, setAgents] = useState<Agent[]>([]);
  const router = useRouter();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((current) => !current);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (!open) return;
    fetch('/api/agents').then((res) => res.json()).then((data) => {
      const list = Array.isArray(data) ? data : Array.isArray(data.agents) ? data.agents : [];
      setAgents(list);
    }).catch(() => setAgents([]));
  }, [open]);

  const actions = useMemo(() => [
    { label: 'Settings', icon: IconSettings, shortcut: '⌘,', run: () => onOpenSettings() },
    { label: 'New chat', icon: IconMessagePlus, shortcut: '/new', run: () => window.dispatchEvent(new CustomEvent('cortextos:new-chat')) },
    { label: 'Search files', icon: IconSearch, shortcut: 'Files', run: () => router.push('/agents') },
    { label: 'Run onboarding', icon: IconSparkles, shortcut: 'Setup', run: () => router.push('/onboarding') },
  ], [onOpenSettings, router]);

  function run(action: () => void) {
    setOpen(false);
    action();
  }

  return (
    <CommandDialog open={open} onOpenChange={setOpen} title="Command Palette">
      <Command>
        <CommandInput placeholder="Jump to agent or run an action" />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>
          <CommandGroup heading="Quick Actions">
            {actions.map((action) => {
              const Icon = action.icon;
              return (
                <CommandItem key={action.label} onSelect={() => run(action.run)}>
                  <Icon size={16} />
                  <span>{action.label}</span>
                  <CommandShortcut>{action.shortcut}</CommandShortcut>
                </CommandItem>
              );
            })}
          </CommandGroup>
          <CommandGroup heading="Agents">
            {agents.map((agent) => (
              <CommandItem key={agent.name} onSelect={() => run(() => router.push(`/agents/${encodeURIComponent(agent.name)}/chat`))}>
                <IconRobot size={16} />
                <span>{agent.name}</span>
                {agent.org && <CommandShortcut>{agent.org}</CommandShortcut>}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
