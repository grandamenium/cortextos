import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import type { AgentRuntime } from '@/lib/types';

export interface RuntimeBadgeProps {
  runtime: AgentRuntime;
  className?: string;
}

const RUNTIME_LABEL: Record<AgentRuntime, string> = {
  'claude-code': 'Claude',
  'codex-app-server': 'Codex',
  hermes: 'Hermes',
};

const RUNTIME_CLASSES: Record<AgentRuntime, string> = {
  'claude-code': 'bg-amber-500/10 text-amber-600 border-amber-500/30',
  'codex-app-server': 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30',
  hermes: 'bg-violet-500/10 text-violet-600 border-violet-500/30',
};

export function RuntimeBadge({ runtime, className }: RuntimeBadgeProps) {
  return (
    <Badge
      variant="outline"
      className={cn('font-normal', RUNTIME_CLASSES[runtime], className)}
    >
      {RUNTIME_LABEL[runtime]}
    </Badge>
  );
}
