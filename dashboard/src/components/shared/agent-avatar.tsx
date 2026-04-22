'use client';

import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';

export interface AgentAvatarProps {
  name: string;
  emoji?: string;
  size?: 'sm' | 'md' | 'lg';
  showName?: boolean;
  className?: string;
}

const sizeMap = {
  sm: 'sm' as const,
  md: 'default' as const,
  lg: 'lg' as const,
};

export function AgentAvatar({
  name,
  emoji,
  size = 'md',
  showName = false,
  className,
}: AgentAvatarProps) {
  const fallbackText = emoji || name.charAt(0).toUpperCase();

  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <Avatar size={sizeMap[size]}>
        <AvatarFallback>{fallbackText}</AvatarFallback>
      </Avatar>
      {showName && (
        <span className="text-sm font-medium">{name}</span>
      )}
    </span>
  );
}
