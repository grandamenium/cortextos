'use client';

import { useState } from 'react';
import { IconChevronDown, IconChevronUp } from '@tabler/icons-react';
import { Card, CardContent } from '@/components/ui/card';
import type { SopStep, StepDisplayInfo } from '@/lib/data/sop-model';
import { isUnmappedRole } from '@/lib/data/sop-model';
import {
  KindIcon,
  ActionTypeChip,
  GateMapChip,
  CustomDependencyChip,
  AutomationMarker,
  AgentBadge,
} from './sop-chips';

export function SopStepCard({ step, info }: { step: SopStep; info: StepDisplayInfo }) {
  const [expanded, setExpanded] = useState(false);
  const hasInstructions = Boolean(step.instructions?.trim());

  return (
    <Card className={info.gated ? 'border-amber-500/40' : ''}>
      <CardContent className="space-y-2 p-3">
        <div className="flex items-start gap-2">
          <KindIcon kind={step.kind} />
          <p className="min-w-0 flex-1 text-[13px] font-medium leading-snug">{step.title}</p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <AgentBadge role={step.assigned_role} unmapped={isUnmappedRole(step.assigned_role)} />
          <ActionTypeChip actionType={info.actionType} gated={info.gated} />
          <AutomationMarker isAutomated={step.is_automated} />
        </div>

        {(info.gated || !info.isChainStep) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {info.gated && <GateMapChip gateTitle={info.nearestGateTitle} />}
            {!info.isChainStep && <CustomDependencyChip />}
          </div>
        )}

        {hasInstructions && (
          <div>
            <p className={`text-[11px] leading-snug text-muted-foreground ${expanded ? '' : 'line-clamp-2'}`}>
              {step.instructions}
            </p>
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-1 inline-flex items-center gap-0.5 text-[10px] font-medium text-primary hover:underline"
            >
              {expanded ? (
                <>
                  Show less <IconChevronUp size={11} />
                </>
              ) : (
                <>
                  Show more <IconChevronDown size={11} />
                </>
              )}
            </button>
          </div>
        )}

        {typeof step.estimated_minutes === 'number' && (
          <p className="text-[10px] text-muted-foreground">~{step.estimated_minutes} min</p>
        )}
      </CardContent>
    </Card>
  );
}
