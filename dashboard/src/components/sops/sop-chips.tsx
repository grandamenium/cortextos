import {
  IconRobot,
  IconUserCheck,
  IconShieldCheck,
  IconShieldExclamation,
  IconArrowsExchange,
  IconGitBranch,
  IconUser,
} from '@tabler/icons-react';
import type { SopDisplayActionType, SopStepKind } from '@/lib/data/sop-model';

const KIND_ICON: Record<SopStepKind, React.ComponentType<{ size?: number; className?: string }>> = {
  agent_task: IconRobot,
  human_review: IconUserCheck,
  human_approval: IconShieldCheck,
  system_handoff: IconArrowsExchange,
};

const KIND_LABEL: Record<SopStepKind, string> = {
  agent_task: 'Agent task',
  human_review: 'Human review',
  human_approval: 'Human approval',
  system_handoff: 'System handoff',
};

export function KindIcon({ kind, size = 15 }: { kind: SopStepKind; size?: number }) {
  const Icon = KIND_ICON[kind];
  return <Icon size={size} className="shrink-0 text-muted-foreground" aria-label={KIND_LABEL[kind]} />;
}

const ACTION_TYPE_LABEL: Record<SopDisplayActionType, string> = {
  internal: 'Internal',
  gate: 'Gate',
  handoff: 'Handoff',
  external_comm: 'External comm',
  money_movement: 'Money movement',
  legal_action: 'Legal action',
  system_write: 'PMS write',
};

/** action_type chip (card anatomy, plan section 4.2). GATED types render amber + shield. */
export function ActionTypeChip({ actionType, gated }: { actionType: SopDisplayActionType; gated: boolean }) {
  if (gated) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-500">
        <IconShieldExclamation size={11} className="shrink-0" />
        {ACTION_TYPE_LABEL[actionType]}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full border border-border bg-secondary/30 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
      {ACTION_TYPE_LABEL[actionType]}
    </span>
  );
}

/** "Gated by: <gate title>" shield chip, or an honest red "no gate" chip
 *  when the transitive closure of depends_on has no human_approval ancestor
 *  (plan section 3.4/Part 4 gate-map, never hidden). */
export function GateMapChip({ gateTitle }: { gateTitle: string | null }) {
  if (gateTitle) {
    return (
      <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-500">
        <IconShieldCheck size={11} className="shrink-0" />
        <span className="truncate">Gated by: {gateTitle}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-[10px] font-medium text-red-500">
      <IconShieldExclamation size={11} className="shrink-0" />
      No gate found
    </span>
  );
}

/** "Custom dependencies" chip for a step whose depends_on does not match the
 *  simple linear chain (plan section 4.0). */
export function CustomDependencyChip() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-secondary/30 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
      <IconGitBranch size={11} className="shrink-0" />
      Custom dependencies
    </span>
  );
}

/** Automated-vs-human marker (card anatomy). */
export function AutomationMarker({ isAutomated }: { isAutomated: boolean }) {
  if (isAutomated) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-medium text-muted-foreground">
        <IconRobot size={11} className="shrink-0" />
        Automated
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-medium text-muted-foreground">
      <IconUser size={11} className="shrink-0" />
      Human
    </span>
  );
}

const ROLE_LABEL: Record<string, string> = {
  maintenance: 'Maintenance',
  leasing: 'Leasing',
  accounting: 'Accounting',
  operations: 'Operations',
  human: 'Human',
  pm: 'PM',
  owner: 'Owner',
};

export function roleLabel(role: string): string {
  return ROLE_LABEL[role] ?? role;
}

/** Assigned-agent badge. */
export function AgentBadge({ role, unmapped }: { role: string; unmapped?: boolean }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${
        unmapped
          ? 'border-red-500/40 bg-red-500/10 text-red-500'
          : 'border-border bg-secondary/40 text-foreground/80'
      }`}
    >
      {roleLabel(role)}
      {unmapped && ' (unmapped)'}
    </span>
  );
}
