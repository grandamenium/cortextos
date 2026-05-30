import type { Priority, EventCategory, EventSeverity, ApprovalCategory } from '../types/index.js';
import { VALID_PRIORITIES } from '../types/index.js';

const AGENT_NAME_REGEX = /^[a-z0-9_-]+$/;

export function validateInstanceId(instanceId: string): void {
  if (!instanceId || !AGENT_NAME_REGEX.test(instanceId)) {
    throw new Error(
      `Invalid instance ID '${instanceId}'. Must contain only lowercase letters, numbers, underscores, and hyphens.`
    );
  }
}

export function validateAgentName(name: string): void {
  if (!name || !AGENT_NAME_REGEX.test(name)) {
    throw new Error(
      `Invalid agent name '${name}'. Must contain only lowercase letters, numbers, underscores, and hyphens.`
    );
  }
}

export function validateOrgName(org: string): void {
  if (!org || !AGENT_NAME_REGEX.test(org)) {
    throw new Error(
      `Invalid org name '${org}'. Must contain only lowercase letters, numbers, underscores, and hyphens.`
    );
  }
}

export function validatePriority(priority: string): asserts priority is Priority {
  if (!VALID_PRIORITIES.includes(priority as Priority)) {
    throw new Error(
      `Invalid priority '${priority}'. Must be one of: ${VALID_PRIORITIES.join(', ')}`
    );
  }
}

const VALID_CATEGORIES: EventCategory[] = [
  'action', 'error', 'metric', 'milestone', 'heartbeat', 'message', 'task', 'approval',
];

export function validateEventCategory(category: string): asserts category is EventCategory {
  if (!VALID_CATEGORIES.includes(category as EventCategory)) {
    throw new Error(
      `Invalid event category '${category}'. Must be one of: ${VALID_CATEGORIES.join(', ')}`
    );
  }
}

const VALID_SEVERITIES: EventSeverity[] = ['info', 'warning', 'error', 'critical'];

export function validateEventSeverity(severity: string): asserts severity is EventSeverity {
  if (!VALID_SEVERITIES.includes(severity as EventSeverity)) {
    throw new Error(
      `Invalid severity '${severity}'. Must be one of: ${VALID_SEVERITIES.join(', ')}`
    );
  }
}

export const STANDARD_APPROVAL_CATEGORIES: readonly string[] = [
  'external-comms', 'financial', 'deployment', 'data-deletion', 'other',
];

/**
 * F2: org-scoped approval categories.
 *
 * Accepts the standard set PLUS any categories the org declares in its
 * context.json `extra_approval_categories`. `extra` defaults to [] so every
 * existing caller keeps IDENTICAL behavior (standard set only) — zero
 * regression. Callers that want to honor a vertical pack's custom categories
 * pass the org's declared list. It never accepts an arbitrary string: a
 * category must be standard or explicitly declared by the org.
 */
export function validateApprovalCategory(
  category: string,
  extra: readonly string[] = [],
): asserts category is ApprovalCategory {
  if (!STANDARD_APPROVAL_CATEGORIES.includes(category) && !extra.includes(category)) {
    const allowed = [...STANDARD_APPROVAL_CATEGORIES, ...extra];
    throw new Error(
      `Invalid approval category '${category}'. Must be one of: ${allowed.join(', ')}`
    );
  }
}

export function validateModel(model: string): void {
  if (!/^[a-zA-Z0-9._-]+$/.test(model)) {
    throw new Error(`Invalid model name '${model}'. Must be alphanumeric with dots and hyphens.`);
  }
}

export function isValidJson(str: string): boolean {
  try {
    JSON.parse(str);
    return true;
  } catch {
    return false;
  }
}

/**
 * Strip terminal control sequences and non-printable characters from external input.
 * Applied to all inbound Telegram text, captions, and callback data before PTY injection.
 * Prevents terminal injection attacks via crafted Telegram messages.
 */
export function stripControlChars(input: string): string {
  return input
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')    // ANSI CSI sequences (e.g. \e[31m)
    .replace(/\x1b\][^\x07]*\x07/g, '')         // OSC sequences (e.g. \e]0;title\a)
    .replace(/\x1b[^[\]]/g, '')                  // Other ESC sequences
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ''); // Control chars (keep \t=0x09, \n=0x0a, \r=0x0d)
}
