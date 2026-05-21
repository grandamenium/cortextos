/**
 * Routing health check: computes Codex:Claude event ratio to detect
 * architectural drift (work leaking to Claude that should go to Codex).
 *
 * Spec: agents/analyst/reports/cheap-llm-lanes-spec-2026-05-20.md
 * "Monitoring: Detect Architectural Drift Before Cap"
 *
 * Healthy: Codex task completions >> Claude message events
 * Drift: Claude message events rising without corresponding Codex tasks
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

export type RoutingHealthStatus = 'healthy' | 'drift_warning' | 'drift_critical' | 'insufficient_data';

export interface RoutingHealthReport {
  status: RoutingHealthStatus;
  claudeMessageEvents: number;
  codexTaskCompletions: number;
  ratio: number | null;
  windowHours: number;
  recommendation: string;
}

/**
 * Read all JSONL event lines for all agents over the last windowHours.
 */
function readRecentEvents(analyticsDir: string, windowHours: number): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  const cutoff = Date.now() - windowHours * 60 * 60 * 1000;
  const eventsDir = join(analyticsDir, 'events');

  if (!existsSync(eventsDir)) return events;

  const agentDirs = readdirSync(eventsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

  for (const agent of agentDirs) {
    for (const dateStr of [yesterday, today]) {
      const filePath = join(eventsDir, agent, `${dateStr}.jsonl`);
      if (!existsSync(filePath)) continue;
      const lines = readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          const ts = event.timestamp as string | undefined;
          if (ts && new Date(ts).getTime() >= cutoff) {
            events.push(event);
          }
        } catch { /* skip malformed lines */ }
      }
    }
  }

  return events;
}

export function checkRoutingHealth(analyticsDir: string, windowHours = 24): RoutingHealthReport {
  const events = readRecentEvents(analyticsDir, windowHours);

  if (events.length < 10) {
    return {
      status: 'insufficient_data',
      claudeMessageEvents: 0,
      codexTaskCompletions: 0,
      ratio: null,
      windowHours,
      recommendation: 'Not enough events in window to assess routing health.',
    };
  }

  // Claude message events: category=message (telegram_sent, slack_sent, agent_message, etc.)
  const claudeMessages = events.filter(e => e.category === 'message').length;

  // Codex task completions: action/task_completed events where metadata indicates Codex dispatch.
  // Heuristic: task_completed events with a commit hash in metadata (Codex always commits).
  const codexTasks = events.filter(e => {
    const eventName = e.event_name ?? e.event;
    return eventName === 'task_completed' &&
      typeof (e.metadata as Record<string, unknown>)?.commit === 'string';
  }).length;

  const ratio = claudeMessages > 0 ? codexTasks / claudeMessages : null;

  let status: RoutingHealthStatus;
  let recommendation: string;

  if (ratio === null || codexTasks === 0) {
    status = 'drift_warning';
    recommendation = 'No Codex task completions detected. Verify Codex is being used for execution work.';
  } else if (ratio >= 0.5) {
    status = 'healthy';
    recommendation = `Codex:Claude ratio ${ratio.toFixed(2)} is healthy. Codex carrying execution load.`;
  } else if (ratio >= 0.2) {
    status = 'drift_warning';
    recommendation = `Codex:Claude ratio ${ratio.toFixed(2)} is low. Consider routing more execution work to Codex.`;
  } else {
    status = 'drift_critical';
    recommendation = `Codex:Claude ratio ${ratio.toFixed(2)} is critically low. Claude is likely doing work that should go to Codex. Check task routing before Claude 5h cap is hit.`;
  }

  return {
    status,
    claudeMessageEvents: claudeMessages,
    codexTaskCompletions: codexTasks,
    ratio,
    windowHours,
    recommendation,
  };
}
