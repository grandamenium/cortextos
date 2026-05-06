'use client';

import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { CategoryBadge, OrgBadge, TimeAgo } from '@/components/shared';
import { IconCheck, IconX } from '@tabler/icons-react';
import type { Approval } from '@/lib/types';

interface ApprovalCardProps {
  approval: Approval;
  onClick: (approval: Approval) => void;
  onQuickResolve?: (id: string, decision: 'approved' | 'rejected') => Promise<void>;
}

export function ApprovalCard({ approval, onClick, onQuickResolve }: ApprovalCardProps) {
  const [submitting, setSubmitting] = useState<'approved' | 'rejected' | null>(null);

  async function handleQuick(
    decision: 'approved' | 'rejected',
    e: React.MouseEvent,
  ) {
    e.stopPropagation();
    if (!onQuickResolve || submitting) return;
    setSubmitting(decision);
    try {
      await onQuickResolve(approval.id, decision);
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <Card
      className="cursor-pointer p-4 transition-colors hover:bg-muted/50"
      onClick={() => onClick(approval)}
    >
      <div className="space-y-2">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-medium leading-snug line-clamp-2">
            {approval.title}
          </p>
          <CategoryBadge category={approval.category} />
        </div>
        {approval.description && (
          <p className="text-xs text-muted-foreground line-clamp-2">
            {approval.description}
          </p>
        )}
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <span>{approval.agent}</span>
            <OrgBadge org={approval.org} />
            <TimeAgo date={approval.created_at} className="text-xs" />
          </div>
          {onQuickResolve && (
            <div className="flex shrink-0 items-center gap-1">
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                disabled={submitting !== null}
                onClick={(e) => handleQuick('rejected', e)}
                aria-label="Reject approval"
              >
                <IconX size={14} className="mr-1" />
                Reject
              </Button>
              <Button
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={submitting !== null}
                onClick={(e) => handleQuick('approved', e)}
                aria-label="Approve approval"
              >
                <IconCheck size={14} className="mr-1" />
                Approve
              </Button>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
